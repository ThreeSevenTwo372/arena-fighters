import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DuelService } from '../online/service.mjs';
import { MemoryStore } from '../online/store.mjs';
import { REACTION_LIMITS } from '../online/arena-reactions.mjs';
import { TournamentClient } from '../src/tournament-client.js';
import { createAppServer } from '../server.mjs';

const fighter = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
const pathFor = view => `/api/arena/tournaments/${view.code}/reactions`;
const apiError = (status, code) => error => error.status === status && (!code || error.code === code);

async function fixture(t, options = {}) {
  let now = 1000000, service, failing = false;
  const store = new MemoryStore(), write = store.write.bind(store);
  store.write = async value => { if (failing) throw new Error('Synthetic write failure'); await write(value); };
  const config = { store, clock: () => now, disconnectMs: 10000000, ...options };
  service = new DuelService(config); await service.initialized;
  t.after(() => service.close());
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  return { request, store, get service() { return service; }, get now() { return now; },
    fail(value) { failing = value; }, elapse(value) { now += value; },
    async tick(value = 0) { now += value; await service.tick(); },
    guest() { return request('POST', '/api/session', undefined, {}); },
    async restart() { await service.close(); service = new DuelService(config); await service.initialized; },
    async lobby(count = 8) {
      let view; const guests = [];
      for (let i = 0; i < count; i++) {
        const guest = await this.guest(); guests.push(guest);
        view = await request('POST', i ? '/api/tournaments/join' : '/api/tournaments', guest.token,
          { ...(i ? { code: view.code } : {}), character: fighter(`Fighter ${i + 1}`) });
      }
      return { view, guests };
    },
    read(view, guest) { return request('GET', pathFor(view), guest?.token); },
    post(view, guest, commandId, kind = 'cheer') { return request('POST', pathFor(view), guest?.token, { commandId, kind }); },
  };
}

test('public reaction reads create no guest or seat and permit lazy guest creation on first send', async t => {
  const f = await fixture(t), { view } = await f.lobby(1), before = structuredClone(f.service.data);
  const result = await f.read(view);
  assert.deepEqual(result, { tournamentId: view.tournamentId, code: view.code, available: true,
    canSend: true, reactions: [], minIntervalMs: 3000, ttlMs: 6000, nextSendAt: f.now });
  assert.deepEqual(f.service.data, before); assert.equal(f.service.arenaReactions.rooms.size, 0);
  await assert.rejects(f.post(view, null, 'without-session'), apiError(401, 'unauthorized'));
  await assert.rejects(f.request('PUT', pathFor(view)), apiError(405));
  await assert.rejects(f.request('GET', '/api/arena/tournaments/ABC234/reactions'), apiError(404, 'room_not_found'));
});

test('reactions reveal only a bounded cosmetic kind, never identities, private gear, choices or authority', async t => {
  const f = await fixture(t), { view, guests } = await f.lobby(), observer = await f.guest();
  const gear = { weapon: 'greatsword', armor: 'heavy', helmet: 'greathelm' };
  await f.request('POST', `/api/tournaments/${view.code}/loadout`, guests[view.match.slots[0]].token,
    { commandId: 'hidden-gear', duelId: view.duelId, loadout: gear });
  const before = structuredClone(f.service.data.tournaments[view.code]);
  const result = await f.post(view, observer, 'cheering');
  assert.deepEqual(f.service.data.tournaments[view.code], before);
  assert.deepEqual(Object.keys(result.reactions[0]).sort(), ['createdAt', 'id', 'kind']);
  for (const secret of [...Object.values(gear), ...guests.flatMap(guest => [guest.token, guest.playerId]), observer.token, observer.playerId]) {
    assert.ok(!JSON.stringify(result).includes(secret));
  }
  const session = await f.request('GET', '/api/session', observer.token);
  assert.equal(session.character, null); assert.equal(session.activeRoom, null); assert.equal(session.activeTournament, null);
  assert.equal(before.players.length, 8);
  for (const action of ['action', 'mercy', 'vote', 'leave']) {
    await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/${action}`, observer.token,
      { commandId: `outside-${action}`, duelId: view.duelId, ...(action === 'action' ? { round: 1, action: 'strike' }
        : ['mercy', 'vote'].includes(action) ? { decision: 'execute' } : {}) }), apiError(403, 'forbidden'));
  }
});

test('the current duelists cannot react; living roster spectators and ordinary public guests can', async t => {
  const f = await fixture(t), { view, guests } = await f.lobby();
  for (const slot of view.match.slots) {
    assert.equal((await f.read(view, guests[slot])).canSend, false);
    await assert.rejects(f.post(view, guests[slot], `duelist-${slot}`), apiError(403, 'spectator'));
  }
  const slot = guests.findIndex((_, i) => !view.match.slots.includes(i));
  assert.equal((await f.post(view, guests[slot], 'roster-applause', 'applause')).reactions[0].kind, 'applause');
  assert.equal((await f.post(view, await f.guest(), 'outside-tomato', 'tomato')).reactions[1].kind, 'tomato');
  await f.service.serialize(() => {
    const tournament = f.service.data.tournaments[view.code];
    tournament.eliminated[slot] = true; f.service.touch(tournament);
  });
  await f.tick(3000);
  assert.equal((await f.post(view, guests[slot], 'spared-spectator')).canSend, true, 'An earlier living, spared contestant can still spectate.');
});

test('dead, departed and pending personal verdict guests cannot send; a completed tournament declines new sends', async t => {
  const f = await fixture(t), { view, guests } = await f.lobby();
  const slot = guests.findIndex((_, i) => !view.match.slots.includes(i)), guest = guests[slot];
  for (const condition of ['dead', 'left', 'pending']) {
    await f.service.serialize(() => {
      const tournament = f.service.data.tournaments[view.code], session = f.service.session(guest.token);
      session.profile.alive = condition !== 'dead'; tournament.left[slot] = condition === 'left';
      session.pendingMercyTournament = condition === 'pending' ? view.code : null; f.service.touch(tournament);
    });
    assert.equal((await f.read(view, guest)).canSend, false);
    await assert.rejects(f.post(view, guest, condition), apiError(403, 'spectator'));
  }
  await f.service.serialize(() => { f.service.data.tournaments[view.code].phase = 'complete'; f.service.changed = true; });
  const observer = await f.guest();
  assert.equal((await f.read(view, observer)).available, false);
  await assert.rejects(f.post(view, observer, 'after-complete'), apiError(409, 'wrong_phase'));
});

test('server validates exact kinds and body shape, owns cross-room cooldown, and retries a receipt once', async t => {
  const f = await fixture(t), first = await f.lobby(1), second = await f.lobby(1), observer = await f.guest();
  for (const body of [null, [], {}, { commandId: 'bad', kind: '<img>' }, { commandId: {}, kind: 'cheer' },
    { commandId: 'bad', kind: 'cheer', damage: 999 }]) {
    await assert.rejects(f.request('POST', pathFor(first.view), observer.token, body), apiError(400));
  }
  const initial = await f.post(first.view, observer, 'exact', 'cheer');
  const repeated = await f.post(first.view, observer, 'exact', 'cheer');
  assert.deepEqual(repeated, initial);
  await assert.rejects(f.post(first.view, observer, 'exact', 'tomato'), apiError(409, 'command_conflict'));
  await assert.rejects(f.post(second.view, observer, 'other-room'), apiError(429, 'rate_limited'));
  await f.tick(2999); await assert.rejects(f.post(first.view, observer, 'too-fast'), apiError(429, 'rate_limited'));
  await f.tick(1);
  assert.equal((await f.post(first.view, observer, 'on-time', 'applause')).reactions.length, 2);
  const guest = await f.guest();
  const outcomes = await Promise.allSettled([f.post(first.view, guest, 'a'), f.post(first.view, guest, 'b')]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.status, 429);
});

test('short history expires at six seconds and the finite queue discards its oldest reactions', async t => {
  const f = await fixture(t), { view } = await f.lobby(1);
  for (let index = 0; index < REACTION_LIMITS.maxReactions + 3; index++) await f.post(view, await f.guest(), `crowd-${index}`);
  assert.equal((await f.read(view)).reactions.length, REACTION_LIMITS.maxReactions);
  await f.tick(5999); assert.equal((await f.read(view)).reactions.length, 24);
  await f.tick(1); assert.deepEqual((await f.read(view)).reactions, []);
  await f.tick(54000); assert.equal(f.service.arenaReactions.rooms.size, 0); assert.equal(f.service.arenaReactions.rates.size, 0);
});

for (const temporarySessions of [false, true]) test(`${temporarySessions ? 'temporary' : 'durable'} saves never contain reaction history and a service restart loses it`, async t => {
  const f = await fixture(t, { temporarySessions }), { view } = await f.lobby(1), observer = await f.guest();
  await f.post(view, observer, 'before-restart', 'tomato');
  const saved = await f.store.read();
  assert.ok(!JSON.stringify(saved).includes('before-restart')); assert.ok(!JSON.stringify(saved).includes('tomato'));
  assert.ok(!Object.hasOwn(saved, 'reactions')); assert.ok(!Object.hasOwn(saved.tournaments[view.code], 'reactions'));
  await f.restart(); assert.deepEqual((await f.read(view)).reactions, []);
});

test('a failed surrounding heartbeat write rolls back the cosmetic event and its cooldown for an exact retry', async t => {
  const f = await fixture(t, { heartbeatPersistMs: 1 }), { view } = await f.lobby(1), observer = await f.guest();
  f.elapse(1); f.fail(true);
  await assert.rejects(f.post(view, observer, 'retry-on-failure'), /Synthetic write failure/);
  assert.equal(f.service.arenaReactions.rooms.size, 0); assert.equal(f.service.arenaReactions.rates.size, 0);
  f.fail(false);
  assert.equal((await f.post(view, observer, 'retry-on-failure')).reactions.length, 1);
});

test('HTTP reactions authenticate sends, reject forged fields and expose only spectator cosmetics', async t => {
  let now = 1000000;
  const server = createAppServer({ store: new MemoryStore(), clock: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, token, body) => fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const owner = await (await call('/api/session', null, {})).json();
  const view = await (await call('/api/tournaments', owner.token, { character: fighter('Host') })).json();
  assert.equal((await call(pathFor(view))).status, 200);
  assert.equal((await call(pathFor(view), null, { commandId: 'auth', kind: 'cheer' })).status, 401);
  const observer = await (await call('/api/session', null, {})).json();
  assert.equal((await call(pathFor(view), observer.token, { commandId: 'forged', kind: 'cheer', winner: 0 })).status, 400);
  assert.equal((await call(pathFor(view), observer.token, { commandId: 'first', kind: 'cheer' })).status, 200);
  assert.equal((await call(pathFor(view), observer.token, { commandId: 'second', kind: 'tomato' })).status, 429);
  now += 3000;
  assert.equal((await call(pathFor(view), observer.token, { commandId: 'second', kind: 'tomato' })).status, 200);
  const session = await (await call('/api/session', observer.token)).json();
  assert.equal(session.character, null); assert.equal(session.activeTournament, null);
});

test('the client reads without acquiring a guest and sends retry-safe intentions through one ordinary guest', async () => {
  const calls = []; let failFirst = true;
  const client = new TournamentClient({ storage: null, fetcher: async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body, authorization: options.headers.Authorization });
    if (path.endsWith('/reactions') && body && failFirst) { failFirst = false; throw new TypeError('Lost response'); }
    return { ok: true, json: async () => path === '/api/session' && body ? { token: 'ordinary-guest' } : {} };
  } });
  await client.reactions(' abc234 ');
  assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/arena/tournaments/ABC234/reactions');
  assert.equal(calls[0].authorization, undefined);
  await client.sendReaction('abc234', { commandId: 'same-on-retry', kind: 'applause' });
  const sends = calls.filter(call => call.body?.kind);
  assert.equal(sends.length, 2); assert.deepEqual(sends[0], sends[1]);
  assert.deepEqual(sends[0].body, { commandId: 'same-on-retry', kind: 'applause' });
  assert.ok(calls.every(call => !call.path.startsWith('/api/tournaments')));
});
