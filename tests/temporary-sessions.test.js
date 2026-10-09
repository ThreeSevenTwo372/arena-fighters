import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuelService } from '../online/service.mjs';
import { MemoryStore } from '../online/store.mjs';
import { getActionOptions } from '../src/combat.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const unauthorized = error => error.status === 401 && error.code === 'unauthorized';

async function fixture(t, options = {}) {
  let now = 1000000;
  let service = new DuelService({ temporarySessions: true, clock: () => now, winnerMs: 0, ...options });
  await service.initialized;
  t.after(() => service.close());
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  return {
    request, get service() { return service; },
    clock(delta) { now += delta; },
    async tick(delta = 0) { now += delta; await service.tick(); },
    session() { return request('POST', '/api/session', undefined, {}); },
    heartbeat(guest) { return request('GET', '/api/session', guest.token); },
    async restart() {
      await service.close();
      service = new DuelService({ temporarySessions: true, clock: () => now, winnerMs: 0, ...options });
      await service.initialized;
    },
    async pair() {
      const one = await this.session(), two = await this.session();
      const waiting = await request('POST', '/api/rooms', one.token, { character: character('Cassian') });
      const room = await request('POST', '/api/rooms/join', two.token, { code: waiting.code, character: character('Mira') });
      return { one, two, room };
    },
    async lobby() {
      const guests = [await this.session()];
      let view = await request('POST', '/api/tournaments', guests[0].token, { character: character('Fighter 1') });
      for (let index = 1; index < 8; index += 1) {
        guests.push(await this.session());
        view = await request('POST', '/api/tournaments/join', guests[index].token, { code: view.code, character: character(`Fighter ${index + 1}`) });
      }
      return { guests, view };
    },
    async finishDuel(pair) {
      let view = pair.room;
      for (const [index, guest] of [pair.one, pair.two].entries()) {
        view = await request('POST', `/api/rooms/${view.code}/loadout`, guest.token, command(view, `gear-${index}`, {
          loadout: { weapon: 'sword', armor: 'medium', helmet: 'none' },
        }));
      }
      while (view.phase === 'battle') {
        if (view.actionOpensAt > now) await this.tick(view.actionOpensAt - now);
        const round = view.duel.round;
        const actions = view.duel.fighters.map((_, index) => getActionOptions(view.duel, index).find(option => option.id === 'strike' && option.enabled) ? 'strike' : 'recover');
        await request('POST', `/api/rooms/${view.code}/action`, pair.one.token, command(view, `round-${round}-0`, { round, action: actions[0] }));
        view = await request('POST', `/api/rooms/${view.code}/action`, pair.two.token, command(view, `round-${round}-1`, { round, action: actions[1] }));
      }
      if (view.phase === 'mercy' && view.mercyOpensAt > now) await this.tick(view.mercyOpensAt - now);
      return view;
    },
  };
}

test('temporary mode never reads or changes a configured save file and a fresh server invalidates its guests', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-temporary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, 'preserved-save.json');
  const sentinel = 'preserved content that is deliberately not a valid JSON store';
  await writeFile(storePath, sentinel);
  const f = await fixture(t, { storePath });
  assert.ok(f.service.store instanceof MemoryStore);
  const pair = await f.pair();
  await f.tick(1000);
  assert.equal(await readFile(storePath, 'utf8'), sentinel);
  assert.deepEqual(await readdir(directory), ['preserved-save.json']);
  await f.restart();
  await assert.rejects(f.heartbeat(pair.one), unauthorized);
  assert.deepEqual(f.service.data, { schema: 1, sessions: {}, rooms: {}, tournaments: {} });
  assert.equal(await readFile(storePath, 'utf8'), sentinel);
});

test('refresh heartbeats preserve the same fighter until the full disconnect grace expires', async t => {
  const f = await fixture(t);
  const guest = await f.session();
  const waiting = await f.request('POST', '/api/rooms', guest.token, { character: character('Cassian') });
  const original = (await f.heartbeat(guest)).character;
  f.clock(89999);
  const refreshed = await f.heartbeat(guest);
  assert.equal(refreshed.character.id, original.id);
  assert.equal(refreshed.activeRoom, waiting.code);
  await f.tick(89999);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  await f.tick(1);
  assert.equal(Object.keys(f.service.data.sessions).length, 0);
  assert.equal(f.service.lastSeen.size, 0);
  assert.equal(Object.keys(f.service.data.rooms).length, 0);
  await assert.rejects(f.heartbeat(guest), unauthorized);
});

test('request-time expiry is committed even when the stale bearer request is rejected', async t => {
  const f = await fixture(t), guest = await f.session();
  f.clock(90000);
  await assert.rejects(f.heartbeat(guest), unauthorized);
  assert.equal(Object.keys(f.service.data.sessions).length, 0);
  assert.equal(f.service.lastSeen.size, 0);
});

test('idle guests expire without a room, while heartbeat-active guests retain their identity', async t => {
  const f = await fixture(t), absent = await f.session(), present = await f.session();
  f.clock(89999); await f.heartbeat(present); await f.tick(1);
  await assert.rejects(f.heartbeat(absent), unauthorized);
  assert.equal((await f.heartbeat(present)).playerId, present.playerId);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
});

test('an expired duelist forfeits but the opponent and mercy decision remain playable', async t => {
  const f = await fixture(t), pair = await f.pair();
  const survivorId = (await f.heartbeat(pair.two)).character.id;
  f.clock(89999); await f.heartbeat(pair.two); await f.tick(1);
  await assert.rejects(f.heartbeat(pair.one), unauthorized);
  const view = await f.request('GET', `/api/rooms/${pair.room.code}`, pair.two.token);
  assert.equal(view.phase, 'mercy');
  assert.equal(view.duel.result.winner, 1);
  assert.deepEqual(view.players.map(player => player.left), [true, false]);
  assert.equal(view.players[1].character.id, survivorId);
  assert.equal(view.players[1].duelWins, 1);
  const complete = await f.request('POST', `/api/rooms/${view.code}/mercy`, pair.two.token, command(view, 'spare-expired', { decision: 'spare' }));
  assert.equal(complete.phase, 'complete');
  await f.request('POST', `/api/rooms/${view.code}/leave`, pair.two.token, command(complete, 'leave-complete'));
  const retry = () => f.request('POST', `/api/rooms/${view.code}/leave`, pair.two.token, command(complete, 'leave-complete'));
  assert.deepEqual(await retry(), { left: true });
  f.clock(89999); await f.heartbeat(pair.two); await f.tick(1);
  assert.equal(Object.keys(f.service.data.rooms).length, 0);
  assert.equal((await f.heartbeat(pair.two)).character.id, survivorId);
});

test('simultaneous guest expiry discards the abandoned duel without retaining fighter snapshots', async t => {
  const f = await fixture(t); await f.pair(); await f.tick(90000);
  assert.deepEqual(f.service.data, { schema: 1, sessions: {}, rooms: {}, tournaments: {} });
  assert.equal(f.service.lastSeen.size, 0);
});

test('an expired mercy winner defaults to spare while the still-present loser keeps their fighter', async t => {
  const f = await fixture(t, { mercyMs: 200000 }), pair = await f.pair();
  const result = await f.finishDuel(pair);
  assert.equal(result.phase, 'mercy');
  const guests = [pair.one, pair.two], loserIndex = 1 - result.duel.result.winner;
  const loser = guests[loserIndex];
  const identity = (await f.heartbeat(loser)).character.id;
  f.clock(89999); await f.heartbeat(loser); await f.tick(1);
  const view = await f.request('GET', `/api/rooms/${result.code}`, loser.token);
  assert.equal(view.phase, 'complete');
  assert.equal(view.decision.decision, 'spare');
  assert.equal(view.players[loserIndex].alive, true);
  assert.equal((await f.heartbeat(loser)).character.id, identity);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
});

test('waiting tournament expiry removes only departed seats and leaves a live entrant registered', async t => {
  const f = await fixture(t), absent = await f.session(), present = await f.session();
  const waiting = await f.request('POST', '/api/tournaments', absent.token, { character: character('Absent') });
  await f.request('POST', '/api/tournaments/join', present.token, { code: waiting.code, character: character('Present') });
  f.clock(89999); await f.heartbeat(present); await f.tick(1);
  const view = await f.request('GET', `/api/tournaments/${waiting.code}`, present.token);
  assert.equal(view.phase, 'waiting');
  assert.equal(view.players.some(player => player.character.name === 'Absent'), false);
  assert.equal(view.players[view.you].character.name, 'Present');
  assert.equal((await f.heartbeat(present)).activeTournament, waiting.code);
  await assert.rejects(f.heartbeat(absent), unauthorized);
});

test('a waiting tournament with no remaining guest is collected instead of running bots alone', async t => {
  const f = await fixture(t), guest = await f.session();
  await f.request('POST', '/api/tournaments', guest.token, { character: character('Absent') });
  await f.tick(90000);
  assert.equal(Object.keys(f.service.data.tournaments).length, 0);
  assert.equal(Object.keys(f.service.data.sessions).length, 0);
});

test('expired tournament duelists preserve other guests and the seeded bracket through their forfeit', async t => {
  const f = await fixture(t), { guests, view: initial } = await f.lobby();
  const expiredSlot = initial.match.slots[0], winnerSlot = initial.match.slots[1];
  const expectedSeeds = initial.players.map(player => player.seed);
  f.clock(89999);
  for (let slot = 0; slot < guests.length; slot += 1) if (slot !== expiredSlot) await f.heartbeat(guests[slot]);
  await f.tick(1);
  let view = await f.request('GET', `/api/tournaments/${initial.code}`, guests[winnerSlot].token);
  assert.equal(view.phase, 'mercy');
  assert.equal(view.match.duel.result.winner, 1);
  assert.equal(view.players[expiredSlot].left, true);
  assert.deepEqual(view.players.map(player => player.seed), expectedSeeds);
  assert.equal(Object.keys(f.service.data.sessions).length, 7);
  view = await f.request('POST', `/api/tournaments/${view.code}/mercy`, guests[winnerSlot].token, command(view, 'spare-expired', { decision: 'spare' }));
  assert.equal(view.phase, 'intermission');
  assert.equal(view.bracket[0].winner, winnerSlot);
  assert.equal(view.bracket[0].loser, expiredSlot);
  await f.tick(6000);
  view = await f.request('GET', `/api/tournaments/${view.code}`, guests[winnerSlot].token);
  assert.equal(view.currentMatchIndex, 1);
  assert.equal(view.phase, 'equipment');
  assert.deepEqual(view.players.map(player => player.seed), expectedSeeds);
});

test('spectator expiry withdraws that entrant without changing the active pair or awarding a win', async t => {
  const f = await fixture(t), { guests, view: initial } = await f.lobby();
  const expiredSlot = guests.findIndex((_, slot) => !initial.match.slots.includes(slot));
  f.clock(89999);
  for (let slot = 0; slot < guests.length; slot += 1) if (slot !== expiredSlot) await f.heartbeat(guests[slot]);
  await f.tick(1);
  const view = await f.request('GET', `/api/tournaments/${initial.code}`, guests[initial.match.slots[0]].token);
  assert.equal(view.phase, 'equipment');
  assert.deepEqual(view.match.slots, initial.match.slots);
  assert.deepEqual(view.match.ready, initial.match.ready);
  assert.equal(view.players[expiredSlot].left, true);
  assert.equal(view.players[expiredSlot].eliminated, false);
  assert.ok(view.players.every(player => player.duelWins === 0));
});

test('both current tournament guests expiring together advance by seed without granting an absent fighter a duel win', async t => {
  const f = await fixture(t), { guests, view: initial } = await f.lobby();
  f.clock(89999);
  for (let slot = 0; slot < guests.length; slot += 1) if (!initial.match.slots.includes(slot)) await f.heartbeat(guests[slot]);
  await f.tick(1);
  const observer = guests.find((_, slot) => !initial.match.slots.includes(slot));
  const view = await f.request('GET', `/api/tournaments/${initial.code}`, observer.token);
  assert.equal(view.phase, 'intermission');
  assert.equal(view.bracket[0].advanceReason, 'draw_seed');
  assert.equal(view.match.duel.result.reason, 'abandoned');
  assert.ok(view.match.players.every(player => player.left));
  assert.ok(view.players.every(player => player.duelWins === 0));
  assert.equal(Object.keys(f.service.data.sessions).length, 6);
});

test('an expired future tournament entrant forfeits their later pairing without disturbing the present match', async t => {
  const f = await fixture(t), { guests, view: initial } = await f.lobby();
  const expiredSlot = initial.bracket[1].slots[0], opponentSlot = initial.bracket[1].slots[1];
  f.clock(89999);
  for (let slot = 0; slot < guests.length; slot += 1) if (slot !== expiredSlot) await f.heartbeat(guests[slot]);
  await f.tick(1);
  const activeSlot = initial.match.slots[0];
  let view = await f.request('GET', `/api/tournaments/${initial.code}`, guests[activeSlot].token);
  assert.equal(view.phase, 'equipment');
  assert.deepEqual(view.match.slots, initial.match.slots);
  await f.request('POST', `/api/tournaments/${view.code}/leave`, guests[activeSlot].token, command(view, 'first-forfeit'));
  view = await f.request('GET', `/api/tournaments/${view.code}`, guests[initial.match.slots[1]].token);
  await f.request('POST', `/api/tournaments/${view.code}/mercy`, guests[initial.match.slots[1]].token, command(view, 'first-spare', { decision: 'spare' }));
  await f.tick(6000);
  view = await f.request('GET', `/api/tournaments/${view.code}`, guests[opponentSlot].token);
  assert.equal(view.currentMatchIndex, 1);
  assert.equal(view.phase, 'mercy');
  assert.equal(view.match.duel.result.reason, 'forfeit');
  assert.equal(view.match.slots[view.match.duel.result.winner], opponentSlot);
});

test('all expired tournament guests release the complete live bracket and auth records', async t => {
  const f = await fixture(t); await f.lobby(); await f.tick(90000);
  assert.deepEqual(f.service.data, { schema: 1, sessions: {}, rooms: {}, tournaments: {} });
  assert.equal(f.service.lastSeen.size, 0);
});

test('durable mode keeps idle sessions through the same grace window', async t => {
  const f = await fixture(t, { temporarySessions: false, store: new MemoryStore() });
  const guest = await f.session(); await f.tick(90000);
  assert.equal((await f.heartbeat(guest)).playerId, guest.playerId);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
});
