import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineClient } from '../src/online-client.js';

const DURABLE_KEY = 'last-laurel.guest.v1';
const TEMPORARY_KEY = 'last-laurel.temporary-guest.v1';
const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
function environment(t, { mode = 'temporary', temporary = storage(), durable = storage(), denied = null } = {}) {
  const originals = Object.fromEntries(['document', 'sessionStorage', 'localStorage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: selector => selector === 'meta[name="arena-session-mode"]' ? { content: mode } : null } });
  for (const [key, value] of [['sessionStorage', temporary], ['localStorage', durable]]) {
    Object.defineProperty(globalThis, key, denied === key ? { configurable: true, get() { throw new Error('Storage access denied'); } } : { configurable: true, value });
  }
  t.after(() => { for (const [key, descriptor] of Object.entries(originals)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return { temporary, durable };
}
function service() {
  const requests = [];
  let created = 0;
  return {
    requests, get created() { return created; },
    fetcher: async (path, options) => {
      assert.equal(path, '/api/session');
      requests.push(options);
      if (options.method === 'POST') return reply({ token: `token-${++created}` });
      return reply({ playerId: options.headers.Authorization, activeTournament: null });
    },
  };
}

test('hosted temporary mode stores its guest only in tab storage and never reads durable storage', async t => {
  const { temporary } = environment(t, { denied: 'localStorage' });
  const api = service();
  const client = new OnlineClient({ fetcher: api.fetcher });
  const session = await client.session();
  assert.equal(client.sessionMode, 'temporary');
  assert.equal(session.playerId, 'Bearer token-1');
  assert.equal(temporary.getItem(TEMPORARY_KEY), 'token-1');
  assert.equal(temporary.getItem(DURABLE_KEY), null);
  assert.equal(client.storageWarning, null);
});

test('reloading a tab resumes the same temporary guest without creating another fighter session', async t => {
  environment(t);
  const api = service();
  await new OnlineClient({ fetcher: api.fetcher }).session();
  const reloaded = new OnlineClient({ fetcher: api.fetcher });
  await reloaded.session();
  assert.equal(api.created, 1);
  assert.equal(reloaded.token, 'token-1');
  assert.equal(api.requests.at(-1).headers.Authorization, 'Bearer token-1');
});

test('a fresh tab store creates a new guest while preserving the prior durable identity', async t => {
  const { durable } = environment(t);
  durable.setItem(DURABLE_KEY, 'saved-survivor');
  const api = service();
  const first = new OnlineClient({ fetcher: api.fetcher });
  await first.session();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() });
  const next = new OnlineClient({ fetcher: api.fetcher });
  await next.session();
  assert.equal(first.token, 'token-1');
  assert.equal(next.token, 'token-2');
  assert.equal(durable.getItem(DURABLE_KEY), 'saved-survivor');
});

test('denied tab storage retains the current token in memory and reports the refresh limitation', async t => {
  environment(t, { denied: 'sessionStorage' });
  const api = service();
  const client = new OnlineClient({ fetcher: api.fetcher });
  await client.session();
  await client.session();
  assert.equal(api.created, 1);
  assert.equal(client.token, 'token-1');
  assert.match(client.storageWarning, /Refreshing the page will start a new fighter/);
  assert.equal(client.storage, null);
});

test('storage read or write denial does not turn successful guest creation into a network failure', async t => {
  environment(t);
  for (const blockedOperation of ['getItem', 'setItem']) {
    const saved = storage();
    saved[blockedOperation] = () => { throw new Error('Denied'); };
    const api = service();
    const client = new OnlineClient({ storage: saved, fetcher: api.fetcher });
    await client.session();
    await client.session();
    assert.equal(api.created, 1);
    assert.equal(client.token, 'token-1');
    assert.match(client.storageWarning, /Refreshing/);
  }
});

test('expired temporary credentials recover even if removing the old stored token is denied', async t => {
  environment(t);
  const saved = storage();
  saved.setItem(TEMPORARY_KEY, 'expired-token');
  saved.removeItem = () => { throw new Error('Denied'); };
  let created = 0;
  const client = new OnlineClient({ storage: saved, fetcher: async (_path, options) => {
    if (options.method === 'POST') { created += 1; return reply({ token: 'new-token' }); }
    if (options.headers.Authorization === 'Bearer expired-token') return reply({ error: 'Session expired.' }, 401);
    return reply({ playerId: 'fresh-player' });
  } });
  assert.equal((await client.session()).playerId, 'fresh-player');
  assert.equal(created, 1);
  assert.equal(client.token, 'new-token');
  assert.match(client.storageWarning, /Refreshing/);
});

test('durable mode retains the legacy local-storage guest key and does not access session storage', async t => {
  const { durable } = environment(t, { mode: 'persistent', denied: 'sessionStorage' });
  durable.setItem(DURABLE_KEY, 'saved-survivor');
  const api = service();
  const client = new OnlineClient({ fetcher: api.fetcher });
  await client.session();
  assert.equal(client.sessionMode, 'persistent');
  assert.equal(client.token, 'saved-survivor');
  assert.equal(api.created, 0);
  assert.equal(durable.getItem(DURABLE_KEY), 'saved-survivor');
  assert.equal(durable.getItem(TEMPORARY_KEY), null);
});

test('explicit storage injection bypasses inaccessible browser storage', async t => {
  environment(t, { denied: 'sessionStorage' });
  const injected = storage();
  injected.setItem(TEMPORARY_KEY, 'injected-token');
  const api = service();
  const client = new OnlineClient({ storage: injected, fetcher: api.fetcher });
  await client.session();
  assert.equal(client.token, 'injected-token');
  assert.equal(api.created, 0);
  assert.equal(client.storageWarning, null);
});
