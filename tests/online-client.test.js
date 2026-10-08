import test from 'node:test';
import assert from 'node:assert/strict';
import { OnlineClient } from '../src/online-client.js';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

test('a lost action acknowledgement retries the exact same command', async () => {
  const requests = [];
  const client = new OnlineClient({ storage: storage(), fetcher: async (path, options) => {
    requests.push({ path, body: options.body });
    if (requests.length === 1) throw new TypeError('network interrupted');
    return reply({ revision: 2 });
  } });
  const view = { code: 'ABC123', duelId: 'duel-1' };
  const result = await client.command(view, 'action', { round: 1, action: 'guard' });
  assert.equal(result.revision, 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(JSON.parse(requests[0].body).round, 1);
  assert.equal(JSON.parse(requests[0].body).action, 'guard');
});

test('a rejected or stale command is not automatically repeated', async () => {
  let requests = 0;
  const client = new OnlineClient({ storage: storage(), fetcher: async () => { requests += 1; return reply({ error: 'Round closed.' }, 409); } });
  await assert.rejects(client.command({ code: 'ABC123', duelId: 'duel-1' }, 'action', { round: 1, action: 'guard' }), /Round closed/);
  assert.equal(requests, 1);
});

test('room creation reconciles a lost response without creating a second room', async () => {
  const paths = [];
  let saved = false;
  const client = new OnlineClient({ storage: storage(), fetcher: async (path, options) => {
    paths.push(`${options.method} ${path}`);
    if (path === '/api/session' && options.method === 'POST') return reply({ token: 'test-token', playerId: 'test-player' });
    if (path === '/api/session') return reply({ activeRoom: saved ? 'ABC123' : null });
    if (path === '/api/rooms') { saved = true; throw new TypeError('lost response'); }
    if (path === '/api/rooms/ABC123') return reply({ code: 'ABC123', phase: 'waiting' });
    assert.fail('Unexpected request');
  } });
  const result = await client.create({ name: 'Test gladiator' });
  assert.equal(result.code, 'ABC123');
  assert.equal(paths.filter(path => path === 'POST /api/rooms').length, 1);
});

test('rejected saved credentials recover without manually clearing browser storage', async () => {
  const saved = storage();
  saved.setItem('last-laurel.guest.v1', 'old-test-token');
  let sessions = 0;
  const client = new OnlineClient({ storage: saved, fetcher: async (_path, options) => {
    if (options.method === 'POST') { sessions += 1; return reply({ token: 'new-test-token', playerId: 'test-player' }); }
    if (options.headers.Authorization === 'Bearer old-test-token') return reply({ error: 'Guest not found.' }, 401);
    return reply({ playerId: 'test-player', activeRoom: null });
  } });
  const session = await client.session();
  assert.equal(session.playerId, 'test-player');
  assert.equal(sessions, 1);
  assert.equal(saved.getItem('last-laurel.guest.v1'), 'new-test-token');
});
