import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DuelService } from '../online/service.mjs';
import { createAppServer } from '../server.mjs';
import { createDuel, resolveRound, getActionOptions } from '../src/combat.js';

const character = (name = 'Cassian', extra = {}) => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', color: '#b87333', ...extra });
const gear = (weapon = 'sword', armor = 'medium', helmet = 'none') => ({ weapon, armor, helmet });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'last-laurel-online-'));
  const storePath = join(directory, 'state.json');
  let now = 1000000;
  let service = new DuelService({ storePath, clock: () => now, winnerMs: 0, ...options });
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, storePath, request, get service() { return service; },
    clock(value) { now += value; },
    async restart(restartOptions = options) { await service.close(); service = new DuelService({ storePath, clock: () => now, winnerMs: 0, ...restartOptions }); },
    async session() { return request('POST', '/api/session', undefined, {}); },
    async pair(a = character('Cassian'), b = character('Mira')) {
      const [one, two] = await Promise.all([this.session(), this.session()]);
      const waiting = await request('POST', '/api/rooms', one.token, { character: a });
      const room = await request('POST', '/api/rooms/join', two.token, { code: waiting.code, character: b });
      return { one, two, room };
    },
  };
}
const error = (status, code) => actual => { assert.equal(actual.status, status); if (code) assert.equal(actual.code, code); return true; };
const command = (room, commandId, extra = {}) => ({ commandId, duelId: room.duelId, ...extra });
async function battle(f, pair, a = gear(), b = gear('axe', 'heavy', 'greathelm')) {
  await f.request('POST', `/api/rooms/${pair.room.code}/loadout`, pair.one.token, command(pair.room, 'loadout-a', { loadout: a }));
  return f.request('POST', `/api/rooms/${pair.room.code}/loadout`, pair.two.token, command(pair.room, 'loadout-b', { loadout: b }));
}
async function finish(f, pair) {
  let view = await f.request('GET', `/api/rooms/${pair.room.code}`, pair.one.token);
  let count = 0;
  while (view.phase === 'battle') {
    const actions = view.duel.fighters.map((_, i) => getActionOptions(view.duel, i).find(item => item.id === 'strike' && item.enabled) ? 'strike' : 'recover');
    await f.request('POST', `/api/rooms/${view.code}/action`, pair.one.token, command(view, `round-a-${count}`, { round: view.duel.round, action: actions[0] }));
    view = await f.request('POST', `/api/rooms/${view.code}/action`, pair.two.token, command(view, `round-b-${count}`, { round: view.duel.round, action: actions[1] }));
    count += 1;
    assert.ok(count <= 24);
  }
  return view;
}

test('guest authentication, room capacity, membership, and active room limits', async t => {
  const f = await fixture(t), pair = await f.pair(), stranger = await f.session();
  assert.equal(pair.one.token.length, 43); assert.notEqual(pair.one.token, pair.two.token);
  await assert.rejects(f.request('GET', '/api/session'), error(401));
  await assert.rejects(f.request('GET', `/api/rooms/${pair.room.code}`, stranger.token), error(403));
  await assert.rejects(f.request('POST', '/api/rooms/join', stranger.token, { code: pair.room.code, character: character() }), error(409, 'room_full'));
  await assert.rejects(f.request('POST', '/api/rooms', pair.one.token, { character: character() }), error(409, 'active_room'));
  const session = await f.request('GET', '/api/session', pair.one.token);
  assert.equal(session.activeRoom, pair.room.code); assert.equal(session.character.name, 'Cassian'); assert.equal(session.alive, true);
  assert.ok(!JSON.stringify(session).includes(pair.one.token));
  assert.equal(pair.room.phase, 'equipment'); assert.equal(pair.room.duel, null);
  assert.deepEqual(pair.room.ready, [false, false]); assert.deepEqual(pair.room.pending, [false, false]);
});

test('private equipment never appears in opponent snapshots or nested character data', async t => {
  const f = await fixture(t), pair = await f.pair();
  const chosen = gear('greatsword', 'heavy', 'greathelm');
  const own = await f.request('POST', `/api/rooms/${pair.room.code}/loadout`, pair.one.token, command(pair.room, 'a', { loadout: chosen }));
  assert.deepEqual(own.yourLoadout, chosen); assert.equal(own.duel, null); assert.deepEqual(own.ready, [true, false]);
  const other = await f.request('GET', `/api/rooms/${pair.room.code}`, pair.two.token);
  for (const secret of Object.values(chosen)) assert.ok(!JSON.stringify(other).includes(secret));
  assert.equal(other.yourLoadout, null);
  assert.equal(Object.hasOwn(other.players[0].character, 'weapon'), false);
  const revealed = await f.request('POST', `/api/rooms/${pair.room.code}/loadout`, pair.two.token, command(pair.room, 'b', { loadout: gear() }));
  assert.equal(revealed.phase, 'battle'); assert.equal(revealed.duel.fighters[0].weapon, 'greatsword');
  const expected = createDuel(revealed.players.map((p, i) => ({ character: p.character, ...(i ? gear() : chosen) })));
  assert.deepEqual(revealed.duel, expected);
});

test('simultaneous actions are secret, resolve exactly once, and reject stale/changed commits', async t => {
  const f = await fixture(t), pair = await f.pair(), initial = await battle(f, pair);
  const a = command(initial, 'round-one-a', { round: 1, action: 'technique' });
  const pending = await f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, a);
  assert.deepEqual(pending.pending, [true, false]); assert.deepEqual(pending.duel, initial.duel);
  const other = await f.request('GET', `/api/rooms/${initial.code}`, pair.two.token);
  assert.deepEqual(other.duel, initial.duel); assert.deepEqual(other.pending, [true, false]);
  await assert.rejects(f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, { ...a, action: 'strike' }), error(409, 'command_conflict'));
  await assert.rejects(f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, { ...a, commandId: 'cancel-a' }), error(409, 'choice_locked'));
  const b = command(initial, 'round-one-b', { round: 1, action: 'guard' });
  const results = await Promise.all([f.request('POST', `/api/rooms/${initial.code}/action`, pair.two.token, b), f.request('POST', `/api/rooms/${initial.code}/action`, pair.two.token, b)]);
  for (const view of results) { assert.equal(view.duel.round, 2); assert.deepEqual(view.duel, resolveRound(initial.duel, ['technique', 'guard'])); }
  const repeated = await f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, a);
  assert.deepEqual(repeated.duel, results[0].duel);
  await assert.rejects(f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, { ...a, commandId: 'stale-round' }), error(409, 'stale_round'));
  await assert.rejects(f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, { ...a, commandId: 'stale-duel', duelId: 'old' }), error(409, 'stale_duel'));
});

test('durable restart restores identity, room, and private committed actions without bearer secrets', async t => {
  const f = await fixture(t), pair = await f.pair(), initial = await battle(f, pair);
  const a = command(initial, 'private-a', { round: 1, action: 'technique' });
  await f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, a);
  const raw = await readFile(f.storePath, 'utf8');
  assert.ok(!raw.includes(pair.one.token)); assert.ok(!raw.includes(pair.two.token));
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.tmp')).length, 0);
  await f.restart();
  const session = await f.request('GET', '/api/session', pair.one.token);
  assert.equal(session.activeRoom, initial.code); assert.equal(session.character.id, initial.players[0].character.id);
  const privateView = await f.request('GET', `/api/rooms/${initial.code}`, pair.two.token);
  assert.deepEqual(privateView.duel, initial.duel); assert.deepEqual(privateView.pending, [true, false]);
  const resolved = await f.request('POST', `/api/rooms/${initial.code}/action`, pair.two.token, command(initial, 'b', { round: 1, action: 'recover' }));
  assert.deepEqual(resolved.duel, resolveRound(initial.duel, ['technique', 'recover']));
  const repeated = await f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, a);
  assert.deepEqual(repeated.duel, resolved.duel);
});

test('saved optional face preset IDs survive sanitization and restart with immutable identity', async t => {
  const f = await fixture(t), pair = await f.pair(character('Veteran', { appearance: { sex: 'male', facePreset: 'p10' } }));
  assert.equal(pair.room.players[0].character.appearance.facePreset, 'p10');
  await f.restart();
  const session = await f.request('GET', '/api/session', pair.one.token);
  assert.equal(session.character.appearance.facePreset, 'p10');
});

test('server deadlines default equipment, missing actions, and mercy; disconnect ends absent duels', async t => {
  const f = await fixture(t, { equipmentMs: 100, actionMs: 80, mercyMs: 40, disconnectMs: 500 }), pair = await f.pair();
  f.clock(100); await f.service.tick();
  let view = await f.request('GET', `/api/rooms/${pair.room.code}`, pair.one.token);
  assert.equal(view.phase, 'battle'); assert.deepEqual(view.duel.fighters.map(x => [x.weapon, x.armor, x.helmet]), [['sword', 'medium', 'none'], ['sword', 'medium', 'none']]);
  await f.request('POST', `/api/rooms/${view.code}/action`, pair.one.token, command(view, 'a', { round: 1, action: 'strike' }));
  f.clock(80); await f.service.tick();
  view = await f.request('GET', `/api/rooms/${view.code}`, pair.one.token);
  assert.deepEqual(view.duel.lastRound.actions, ['strike', 'recover']);
  f.clock(320); await f.service.tick();
  view = await f.request('GET', `/api/rooms/${view.code}`, pair.one.token);
  assert.equal(view.phase, 'mercy'); assert.equal(view.duel.result.reason, 'forfeit'); assert.equal(view.duel.result.winner, 0);
  assert.equal(view.players[0].duelWins, 1);
  f.clock(40); await f.service.tick();
  view = await f.request('GET', `/api/rooms/${view.code}`, pair.one.token);
  assert.equal(view.phase, 'complete'); assert.deepEqual(view.decision, { decision: 'spare', winner: 0, loser: 1 });
  assert.equal(view.players[1].alive, true); assert.equal(view.players[0].duelWins, 1);
});

test('default battle window expires at twenty seconds, survives restart, and automatically opens the next round', async t => {
  const f = await fixture(t), pair = await f.pair(), initial = await battle(f, pair);
  assert.equal(initial.rules.actionMs, 20000);
  assert.equal(initial.deadline, 1020000);
  await f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, command(initial, 'before-timeout', { round: 1, action: 'strike' }));
  f.clock(19999); await f.service.tick();
  let view = await f.request('GET', `/api/rooms/${initial.code}`, pair.one.token);
  assert.equal(view.duel.round, 1);
  assert.deepEqual(view.pending, [true, false]);
  assert.equal(view.deadline, initial.deadline, 'polling must not extend the choice deadline');
  await f.restart();
  view = await f.request('GET', `/api/rooms/${initial.code}`, pair.two.token);
  assert.equal(view.deadline, initial.deadline, 'restart must retain the original deadline');
  assert.deepEqual(view.pending, [true, false]);
  f.clock(1); await f.service.tick();
  view = await f.request('GET', `/api/rooms/${initial.code}`, pair.one.token);
  assert.equal(view.duel.round, 2);
  assert.deepEqual(view.duel.lastRound.actions, ['strike', 'recover']);
  assert.deepEqual(view.pending, [false, false]);
  assert.equal(view.deadline, 1040000);
  await f.service.tick();
  assert.equal((await f.request('GET', `/api/rooms/${initial.code}`, pair.one.token)).duel.round, 2, 'one expiry must not resolve twice');
  f.clock(1000);
  await f.request('POST', `/api/rooms/${view.code}/action`, pair.one.token, command(view, 'early-a', { round: 2, action: 'recover' }));
  view = await f.request('POST', `/api/rooms/${view.code}/action`, pair.two.token, command(view, 'early-b', { round: 2, action: 'strike' }));
  assert.equal(view.duel.round, 3, 'two committed actions resolve without a continue request');
  assert.equal(view.deadline, 1041000, 'the next round receives a fresh twenty-second window');
});

test('restoring an old longer battle window durably caps its remainder without resetting choices or extending shorter deadlines', async t => {
  const f = await fixture(t, { actionMs: 60000 }), pair = await f.pair(), equipmentPair = await f.pair();
  const initial = await battle(f, pair);
  assert.equal(initial.deadline, 1060000);
  f.clock(5000);
  await f.request('POST', `/api/rooms/${initial.code}/action`, pair.one.token, command(initial, 'legacy-choice', { round: 1, action: 'strike' }));
  await f.restart({});
  let view = await f.request('GET', `/api/rooms/${initial.code}`, pair.two.token);
  assert.equal(view.rules.actionMs, 20000);
  assert.equal(view.deadline, 1025000);
  assert.equal(view.duel.round, 1);
  assert.deepEqual(view.pending, [true, false]);
  assert.deepEqual(view.duel, initial.duel);
  const stored = JSON.parse(await readFile(f.storePath, 'utf8'));
  assert.equal(stored.rooms[view.code].deadline, view.deadline, 'the shortened deadline must survive another crash');
  const equipment = await f.request('GET', `/api/rooms/${equipmentPair.room.code}`, equipmentPair.one.token);
  assert.equal(equipment.deadline, equipmentPair.room.deadline, 'equipment keeps its independent response window');
  f.clock(10000);
  await f.restart({});
  view = await f.request('GET', `/api/rooms/${initial.code}`, pair.two.token);
  assert.equal(view.deadline, 1025000, 'restart must not grant another twenty seconds to a shorter window');
  f.clock(9999); await f.service.tick();
  assert.equal((await f.request('GET', `/api/rooms/${initial.code}`, pair.one.token)).duel.round, 1);
  f.clock(1); await f.service.tick();
  view = await f.request('GET', `/api/rooms/${initial.code}`, pair.one.token);
  assert.equal(view.duel.round, 2);
  assert.deepEqual(view.duel.lastRound.actions, ['strike', 'recover']);
  assert.equal(view.deadline, 1045000);
});

test('both disconnected players draw, without a fabricated winner or execution', async t => {
  const f = await fixture(t, { disconnectMs: 100 }), pair = await f.pair();
  f.clock(100); await f.service.tick();
  const view = await f.request('GET', `/api/rooms/${pair.room.code}`, pair.one.token);
  assert.equal(view.phase, 'complete'); assert.equal(view.duel.result.winner, null); assert.equal(view.duel.result.reason, 'abandoned');
  assert.equal(view.decision, null); assert.deepEqual(view.players.map(p => p.duelWins), [0, 0]);
});

test('winner alone chooses permanent execution, duplicate decisions do not repeat wins, and rematch needs two ready votes', async t => {
  const f = await fixture(t), pair = await f.pair();
  await battle(f, pair, gear('greatsword', 'light'), gear('sword', 'light'));
  let view = await finish(f, pair);
  assert.equal(view.phase, 'mercy');
  const winner = view.duel.result.winner, loser = 1 - winner, tokens = [pair.one.token, pair.two.token];
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/mercy`, tokens[loser], command(view, 'loser-mercy', { decision: 'execute' })), error(403));
  const execution = command(view, 'winner-mercy', { decision: 'execute' });
  view = await f.request('POST', `/api/rooms/${view.code}/mercy`, tokens[winner], execution);
  assert.equal(view.players[loser].alive, false); assert.equal(view.players[winner].duelWins, 1);
  assert.deepEqual((await f.request('POST', `/api/rooms/${view.code}/mercy`, tokens[winner], execution)).players, view.players);
  const oldId = view.duelId, deadId = view.players[loser].character.id, livingId = view.players[winner].character.id;
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/rematch`, tokens[loser], command(view, 'dead-ready')), error(409, 'character_dead'));
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/rematch`, tokens[loser], command(view, 'resurrect', { character: view.players[loser].character })), error(409, 'character_dead'));
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/rematch`, tokens[winner], command(view, 'change-winner', { character: character('Different') })), error(409, 'identity_locked'));
  const ready = await f.request('POST', `/api/rooms/${view.code}/rematch`, tokens[winner], command(view, 'winner-ready'));
  assert.equal(ready.phase, 'complete'); assert.equal(ready.rematchReady[winner], true);
  await f.restart();
  view = await f.request('POST', `/api/rooms/${view.code}/rematch`, tokens[loser], command(view, 'replacement-ready', { character: character('Successor') }));
  assert.equal(view.phase, 'equipment'); assert.notEqual(view.duelId, oldId); assert.equal(view.duel, null);
  assert.equal(view.players[winner].character.id, livingId); assert.notEqual(view.players[loser].character.id, deadId);
  assert.equal(view.players[winner].duelWins, 1); assert.equal(view.players[loser].duelWins, 0);
  assert.deepEqual(view.rematchReady, [false, false]); assert.deepEqual(view.ready, [false, false]);
  assert.equal((await f.request('GET', '/api/session', tokens[loser])).alive, true);
});

test('leaving forfeits active duels, clears active room, and never resets a survivor', async t => {
  const f = await fixture(t), pair = await f.pair(), view = await battle(f, pair);
  const leaving = command(view, 'leave');
  assert.deepEqual(await f.request('POST', `/api/rooms/${view.code}/leave`, pair.two.token, leaving), { left: true });
  assert.deepEqual(await f.request('POST', `/api/rooms/${view.code}/leave`, pair.two.token, leaving), { left: true });
  const remaining = await f.request('GET', `/api/rooms/${view.code}`, pair.one.token);
  assert.equal(remaining.phase, 'mercy'); assert.equal(remaining.duel.result.winner, 0); assert.equal(remaining.canRematch, false);
  assert.equal((await f.request('GET', '/api/session', pair.two.token)).activeRoom, null);
  await assert.rejects(f.request('POST', '/api/rooms', pair.two.token, { character: remaining.players[1].character }), error(409, 'pending_mercy'));
  await f.request('POST', `/api/rooms/${view.code}/mercy`, pair.one.token, command(view, 'spare', { decision: 'spare' }));
  await assert.rejects(f.request('POST', '/api/rooms', pair.two.token, { character: character('Changed') }), error(409, 'identity_locked'));
  const newRoom = await f.request('POST', '/api/rooms', pair.two.token, { character: remaining.players[1].character });
  assert.equal(newRoom.players[0].character.id, remaining.players[1].character.id);
  await assert.rejects(f.request('GET', `/api/rooms/${view.code}`, pair.two.token), error(403));
});

test('pending mercy blocks cross-room resurrection and waiting leave is idempotent', async t => {
  const f = await fixture(t), pair = await f.pair();
  await f.request('POST', `/api/rooms/${pair.room.code}/leave`, pair.two.token, command(pair.room, 'loser-leave'));
  const deadCharacter = (await f.request('GET', '/api/session', pair.two.token)).character;
  await assert.rejects(f.request('POST', '/api/rooms', pair.two.token, { character: deadCharacter }), error(409, 'pending_mercy'));
  await f.request('POST', `/api/rooms/${pair.room.code}/mercy`, pair.one.token, command(pair.room, 'execution', { decision: 'execute' }));
  await assert.rejects(f.request('POST', '/api/rooms', pair.two.token, { character: deadCharacter }), error(409, 'character_dead'));
  const replacement = await f.request('POST', '/api/rooms', pair.two.token, { character: character('Replacement') });
  assert.notEqual(replacement.players[0].character.id, deadCharacter.id);
  const leave = command(replacement, 'waiting-leave');
  assert.deepEqual(await f.request('POST', `/api/rooms/${replacement.code}/leave`, pair.two.token, leave), { left: true });
  assert.deepEqual(await f.request('POST', `/api/rooms/${replacement.code}/leave`, pair.two.token, leave), { left: true });
  assert.equal((await f.request('GET', '/api/session', pair.two.token)).activeRoom, null);
});

test('untrusted body shapes, nested equipment, illegal stats and actions are rejected', async t => {
  const f = await fixture(t), session = await f.session();
  for (const bad of [character('', {}), character('A', { stats: { strength: 8, dexterity: 8, speed: 8, defense: 8, intelligence: 8 } }), character('A', { weapon: 'axe' }), character('A', { appearance: { loadout: gear('axe') } }), character('A', { stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4, weapon: 'axe' } })]) await assert.rejects(f.request('POST', '/api/rooms', session.token, { character: bad }), error(400));
  const pair = await f.pair();
  await assert.rejects(f.request('POST', `/api/rooms/${pair.room.code}/loadout`, pair.one.token, command(pair.room, 'gear', { loadout: gear('hacked') })), error(400));
  const view = await battle(f, pair);
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/action`, pair.one.token, command(view, 'action', { round: 1, action: 'kill' })), error(400));
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/action`, pair.one.token, command(view, 'action', { round: 1, action: 'recover', overwrite: true })), error(400));
});

test('persistence failures roll back gameplay before acknowledgment and can retry the same command', async () => {
  let data = { schema: 1, sessions: {}, rooms: {} }, broken = false;
  const store = { async read() { return structuredClone(data); }, async write(value) { if (broken) throw new Error('Disk full'); data = structuredClone(value); } };
  const service = new DuelService({ store, clock: () => 1000 });
  const req = (method, path, token, body) => service.request({ method, path, token, body });
  const one = await req('POST', '/api/session', null, {}), two = await req('POST', '/api/session', null, {});
  const waiting = await req('POST', '/api/rooms', one.token, { character: character('One') });
  const view = await req('POST', '/api/rooms/join', two.token, { code: waiting.code, character: character('Two') });
  const locked = command(view, 'retry', { loadout: gear() });
  broken = true; await assert.rejects(req('POST', `/api/rooms/${view.code}/loadout`, one.token, locked), /Disk full/);
  broken = false;
  assert.deepEqual((await req('GET', `/api/rooms/${view.code}`, one.token)).ready, [false, false]);
  assert.deepEqual((await req('POST', `/api/rooms/${view.code}/loadout`, one.token, locked)).ready, [true, false]);
});

test('HTTP API rejects cross-origin mutations, bounded/malformed JSON, and private files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'last-laurel-http-'));
  const server = createAppServer({ storePath: join(directory, 'state.json'), tickMs: 100000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.duels.close(); await rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });
  assert.equal((await post('{}', { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('{}', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(17000))).status, 413);
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415);
  for (const path of ['/.local-data/online-duels.json', '/server.mjs', '/online/service.mjs', '/.git/config', '/package.json']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/src/combat.js')).status, 200);
  const response = await post('{}', { Origin: base }); assert.equal(response.status, 200);
  const session = await response.json(); assert.equal(typeof session.token, 'string');
  assert.equal((await fetch(base + '/api/session')).status, 401);
  const recovered = await fetch(base + '/api/session', { headers: { Authorization: `Bearer ${session.token}` } });
  assert.equal(recovered.status, 200); assert.equal((await recovered.json()).playerId, session.playerId);
});
