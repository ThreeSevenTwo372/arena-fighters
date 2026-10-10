import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuelService } from '../online/service.mjs';
import { BOT_ACTION_DELAY_MS } from '../online/tournament-bots.mjs';
import { validateCharacter, chooseCpuAction, resolveRound, WEAPONS, ARMORS, HELMETS } from '../src/combat.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b87333', appearance: { sex: 'male', hairstyle: 'braided_ponytail', skin: 'ivory', hairColor: 'chestnut', eyes: 'amber', facePreset: 'p05' } });
const gear = () => ({ weapon: 'sword', armor: 'medium', helmet: 'none' });
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const apiError = (status, code) => actual => { assert.equal(actual.status, status); assert.equal(actual.code, code); return true; };
const bots = view => view.players.filter(profile => profile.bot === true);

async function fixture(t, options = {}, persistent = false) {
  let now = 1000000, service, memory = { schema: 1, sessions: {}, rooms: {} };
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'arena-tournament-bots-')) : null;
  const storePath = directory ? join(directory, 'state.json') : null;
  const store = directory ? undefined : { async read() { return structuredClone(memory); }, async write(data) { memory = structuredClone(data); } };
  const configuration = { storePath, store, clock: () => now, winnerMs: 0, disconnectMs: 10000000, ...options };
  service = new DuelService(configuration);
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const sessions = [];
  t.after(async () => { await service.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  return {
    request, sessions, storePath, get now() { return now; }, get service() { return service; },
    async session() { const guest = await request('POST', '/api/session', undefined, {}); sessions.push(guest); return guest; },
    async tick(delta) { now += delta; await service.tick(); },
    elapse(delta) { now += delta; },
    async restart() { await service.close(); service = new DuelService(configuration); await service.initialized; },
    view(code, guest = sessions[0]) { return request('GET', `/api/tournaments/${code}`, guest.token); },
    async enter(name = 'Aster') {
      const guest = await this.session();
      const view = await request('POST', '/api/tournaments/enter', guest.token, { character: character(name) });
      return { guest, view };
    },
    async fill() {
      const { view } = await this.enter();
      for (let index = 0; index < 7; index += 1) await this.tick(20000);
      return this.view(view.code);
    },
    commit(view, localIndex, action, payload = {}, id = `${view.currentMatchIndex}-${action}-${view.match?.duel?.round ?? 0}-${localIndex}`) {
      const playerId = service.data.tournaments[view.code].playerIds[view.match.slots[localIndex]];
      const guest = sessions.find(session => session.playerId === playerId);
      assert.ok(guest, 'Only real guests can use authenticated combat commands.');
      return request('POST', `/api/tournaments/${view.code}/${action}`, guest.token, command(view, id, payload));
    },
    async step(view) {
      if (view.phase === 'equipment') {
        for (let index = 0; index < 2; index += 1) {
          if (!view.match.players[index].bot && !view.match.ready[index]) view = await this.commit(view, index, 'loadout', { loadout: gear() });
        }
      } else if (view.phase === 'entrance') await this.tick(view.match.deadline - now);
      else if (view.phase === 'battle') {
        if (view.match.actionOpensAt > now) await this.tick(view.match.actionOpensAt - now);
        const round = view.match.duel.round;
        for (let index = 0; index < 2; index += 1) {
          if (view.phase === 'battle' && view.match.duel.round === round && !view.match.players[index].bot && !view.match.pending[index]) {
            view = await this.commit(view, index, 'action', { round, action: chooseCpuAction(view.match.duel, index) });
          }
        }
        if (view.phase === 'battle' && view.match.duel.round === round) await this.tick(3000);
      } else if (view.phase === 'mercy') {
        if (view.match.mercyOpensAt > now) { await this.tick(view.match.mercyOpensAt - now); return this.view(view.code); }
        const winner = view.match.duel.result.winner;
        if (!view.match.players[winner].bot) view = await this.commit(view, winner, 'mercy', { decision: 'spare' });
        else await this.tick(3000);
      } else if (view.phase === 'intermission') await this.tick(view.nextMatchAt - now);
      return this.view(view.code);
    },
    async humanMatch() {
      let view = await this.fill(), steps = 0;
      while (!view.match.slots.includes(0)) {
        view = await this.step(view);
        assert.ok(++steps < 300, 'The preceding bot matches must finish without human choices.');
      }
      assert.equal(view.phase, 'equipment');
      return view;
    },
  };
}

test('an idle lobby adds one bot at twenty seconds; a new human resets the timer while polling and resuming do not', async t => {
  const f = await fixture(t), { guest: host, view: initial } = await f.enter();
  assert.equal(initial.nextBotAt, f.now + 20000);
  await f.tick(10000);
  const saved = await f.request('GET', '/api/session', host.token);
  const resumed = await f.request('POST', '/api/tournaments/enter', host.token, { character: saved.character });
  assert.equal(resumed.nextBotAt, initial.nextBotAt); assert.equal(resumed.players.length, 1);
  await f.tick(9999); assert.equal((await f.view(initial.code)).players.length, 1);
  await f.tick(1);
  let view = await f.view(initial.code);
  assert.equal(view.players.length, 2); assert.equal(bots(view).length, 1); assert.equal(view.nextBotAt, f.now + 20000);
  await f.tick(10000);
  const newcomer = await f.session();
  view = await f.request('POST', '/api/tournaments/join', newcomer.token, { code: initial.code, character: character('Titus') });
  const resetAt = view.nextBotAt;
  assert.equal(resetAt, f.now + 20000);
  await f.tick(10000); assert.equal((await f.view(initial.code)).players.length, 3, 'The original bot deadline must be superseded by the new human seat.');
  const newcomerIdentity = (await f.request('GET', '/api/session', newcomer.token)).character;
  view = await f.request('POST', '/api/tournaments/enter', newcomer.token, { character: newcomerIdentity });
  assert.equal(view.nextBotAt, resetAt);
  await f.tick(9999); assert.equal((await f.view(initial.code)).players.length, 3);
  await f.tick(1); assert.equal(bots(await f.view(initial.code)).length, 2);
});

test('a long overdue clock inserts one bot and gives the next empty seat a fresh twenty seconds', async t => {
  const f = await fixture(t), { view: initial } = await f.enter();
  await f.tick(140000);
  let view = await f.view(initial.code);
  assert.equal(view.players.length, 2); assert.equal(view.nextBotAt, f.now + 20000);
  const revision = view.revision;
  await f.tick(0); view = await f.view(initial.code);
  assert.equal(view.players.length, 2); assert.equal(view.revision, revision);
  await f.tick(19999); assert.equal((await f.view(initial.code)).players.length, 2);
  await f.tick(1); assert.equal((await f.view(initial.code)).players.length, 3);
});

test('a restored pre-bot waiting lobby receives one fresh durable interval without an immediate catch-up bot', async t => {
  let persisted = { schema: 1, sessions: {}, rooms: {} };
  const store = { async read() { return structuredClone(persisted); }, async write(data) { persisted = structuredClone(data); } };
  const f = await fixture(t, { store }), { view: initial } = await f.enter();
  delete persisted.tournaments[initial.code].nextBotAt;
  f.elapse(60000); await f.restart();
  let view = await f.view(initial.code);
  assert.equal(view.players.length, 1); assert.equal(view.nextBotAt, f.now + 20000);
  const restoredDeadline = view.nextBotAt;
  assert.equal(persisted.tournaments[initial.code].nextBotAt, restoredDeadline);
  await f.tick(10000); await f.restart(); view = await f.view(initial.code);
  assert.equal(view.nextBotAt, restoredDeadline); assert.equal(view.players.length, 1);
  await f.tick(9999); assert.equal((await f.view(initial.code)).players.length, 1);
  await f.tick(1); assert.equal(bots(await f.view(initial.code)).length, 1);
});

test('the bot deadline takes priority when a human join arrives at the exact final-seat deadline', async t => {
  const f = await fixture(t), { view: initial } = await f.enter();
  for (let index = 1; index < 7; index += 1) {
    const guest = await f.session();
    await f.request('POST', '/api/tournaments/join', guest.token, { code: initial.code, character: character(`Human ${index}`) });
  }
  const last = await f.session();
  f.elapse(20000);
  await assert.rejects(f.request('POST', '/api/tournaments/join', last.token, { code: initial.code, character: character('Last human') }), apiError(409, 'room_full'));
  // Failed requests roll back their transaction; the next successful tick durably inserts the due bot.
  await f.tick(0);
  const view = await f.view(initial.code);
  assert.equal(view.players.length, 8); assert.equal(bots(view).length, 1); assert.equal(view.nextBotAt, null);
  assert.equal((await f.request('GET', '/api/session', last.token)).activeTournament, null);
});

test('seven Roman-inspired bots fill the roster with valid distinct identities and start the existing shuffled bracket without auth sessions', async t => {
  const f = await fixture(t), view = await f.fill();
  assert.equal(view.players.length, 8); assert.equal(bots(view).length, 7); assert.equal(view.nextBotAt, null);
  assert.ok(['equipment', 'entrance'].includes(view.phase)); assert.equal(view.currentMatchIndex, 0);
  assert.equal(view.bracket.filter(match => match.status === 'active').length, 1);
  assert.deepEqual(view.bracket.slice(0, 4).flatMap(match => match.slots).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(view.players.map(profile => profile.seed).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(new Set(view.players.map(profile => profile.character.id)).size, 8);
  assert.equal(new Set(view.players.map(profile => profile.character.name.toLowerCase())).size, 8);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  for (const profile of bots(view)) {
    assert.match(profile.character.name, /^[A-Za-z][A-Za-z '-]{0,23}$/);
    assert.equal(validateCharacter(profile.character).valid, true);
    assert.match(profile.character.appearance.facePreset, /^p(?:0[1-9]|10)$/);
    assert.ok(['male', 'female'].includes(profile.character.appearance.sex));
    assert.equal(profile.connected, true); assert.equal(profile.alive, true); assert.equal(profile.left, false);
    assert.equal(f.service.sessionForPlayer(f.service.data.tournaments[view.code].playerIds[view.players.indexOf(profile)]), undefined);
  }
  await assert.rejects(f.request('GET', '/api/session', bots(view)[0].character.id), apiError(401, 'unauthorized'));
  const outsider = await f.session();
  await assert.rejects(f.request('GET', `/api/tournaments/${view.code}`, outsider.token), apiError(403, 'forbidden'));
  await f.tick(20000); assert.equal((await f.view(view.code)).players.length, 8);
});

test('the bot equips privately before its human opponent commits and cannot be controlled by another guest', async t => {
  const f = await fixture(t), view = await f.humanMatch();
  const humanIndex = view.match.slots.indexOf(0), botIndex = 1 - humanIndex;
  assert.deepEqual(view.match.ready, [humanIndex !== 0, humanIndex !== 1]);
  assert.equal(view.match.yourLoadout, null); assert.equal(view.match.duel, null);
  const privateGear = f.service.data.tournaments[view.code].match.loadouts[botIndex];
  assert.ok(Object.hasOwn(WEAPONS, privateGear.weapon)); assert.ok(Object.hasOwn(ARMORS, privateGear.armor)); assert.ok(Object.hasOwn(HELMETS, privateGear.helmet));
  assert.equal(Object.hasOwn(view.match, 'loadouts'), false); assert.equal(Object.hasOwn(view.match, 'botActionAt'), false);
  const outsider = await f.session();
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/loadout`, outsider.token, command(view, 'control-bot', { loadout: gear() })), apiError(403, 'forbidden'));
  const entrance = await f.commit(view, humanIndex, 'loadout', { loadout: gear() });
  assert.equal(entrance.phase, 'entrance'); assert.deepEqual(entrance.match.ready, [true, true]);
});

test('a bot selects from public state only after three seconds, retains its pending choice, and never cascades into the next round on the same tick', async t => {
  const f = await fixture(t), equipment = await f.humanMatch();
  const humanIndex = equipment.match.slots.indexOf(0), botIndex = 1 - humanIndex;
  let view = await f.commit(equipment, humanIndex, 'loadout', { loadout: gear() });
  await f.tick(8000); view = await f.view(view.code);
  assert.equal(view.phase, 'battle'); assert.deepEqual(view.match.pending, [false, false]);
  const initialDuel = structuredClone(view.match.duel), expected = chooseCpuAction(initialDuel, botIndex, view.match.players[botIndex].botStyle);
  await f.tick(2999); assert.deepEqual((await f.view(view.code)).match.pending, [false, false]);
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.match.pending[botIndex], true); assert.equal(view.match.pending[humanIndex], false);
  assert.equal(f.service.data.tournaments[view.code].match.actions[botIndex], expected);
  assert.deepEqual(view.match.duel, initialDuel); assert.equal(Object.hasOwn(view.match, 'actions'), false);
  await f.tick(0); assert.deepEqual((await f.view(view.code)).match.duel, initialDuel);
  view = await f.commit(view, humanIndex, 'action', { round: 1, action: 'guard' });
  assert.equal(view.phase, 'battle'); assert.equal(view.match.duel.round, 2); assert.deepEqual(view.match.pending, [false, false]);
  await f.tick(0); assert.deepEqual((await f.view(view.code)).match.pending, [false, false]);
  await f.tick(4000); assert.deepEqual((await f.view(view.code)).match.pending, [false, false], 'Presentation time must not consume the bot thinking interval.');
  await f.tick(2999); assert.deepEqual((await f.view(view.code)).match.pending, [false, false]);
  await f.tick(1); assert.equal((await f.view(view.code)).match.pending[botIndex], true);
});

test('a human secret choice made first does not change the bot action selected from the unresolved public duel', async t => {
  const f = await fixture(t), equipment = await f.humanMatch();
  const humanIndex = equipment.match.slots.indexOf(0), botIndex = 1 - humanIndex;
  let view = await f.commit(equipment, humanIndex, 'loadout', { loadout: gear() });
  await f.tick(8000); view = await f.view(view.code);
  const publicDuel = structuredClone(view.match.duel), expectedBot = chooseCpuAction(publicDuel, botIndex, view.match.players[botIndex].botStyle);
  const actions = [null, null]; actions[humanIndex] = 'guard'; actions[botIndex] = expectedBot;
  view = await f.commit(view, humanIndex, 'action', { round: 1, action: 'guard' });
  assert.equal(view.match.pending[humanIndex], true); assert.equal(view.match.pending[botIndex], false);
  assert.deepEqual(view.match.duel, publicDuel);
  await f.tick(2999); assert.equal((await f.view(view.code)).match.duel.round, 1);
  await f.tick(1); view = await f.view(view.code);
  const elapsed = [null, null]; elapsed[humanIndex] = 0; elapsed[botIndex] = BOT_ACTION_DELAY_MS;
  assert.deepEqual(view.match.duel, resolveRound(publicDuel, actions, { choiceElapsedMs: elapsed }));
});

test('bot equipment and pending actions remain hidden from a human spectating a bot pair', async t => {
  const f = await fixture(t);
  let view = await f.fill(), steps = 0;
  while (view.match.slots.includes(0)) {
    view = await f.step(view);
    assert.ok(++steps < 100);
  }
  assert.equal(view.spectator, true); assert.equal(view.match.you, null); assert.equal(view.match.yourLoadout, null);
  assert.equal(Object.hasOwn(view.match, 'loadouts'), false); assert.equal(Object.hasOwn(view.match, 'actions'), false);
  if (view.phase === 'intermission') { await f.tick(view.nextMatchAt - f.now); view = await f.view(view.code); }
  if (view.phase === 'entrance') { await f.tick(view.match.deadline - f.now); view = await f.view(view.code); }
  assert.equal(view.phase, 'battle');
  const initial = structuredClone(view.match.duel);
  await f.tick(2999); view = await f.view(view.code);
  assert.deepEqual(view.match.duel, initial); assert.deepEqual(view.match.pending, [false, false]);
  for (const action of ['loadout', 'action', 'mercy']) {
    const payload = action === 'loadout' ? { loadout: gear() } : action === 'action' ? { round: view.match.duel.round, action: 'strike' } : { decision: 'execute' };
    await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/${action}`, f.sessions[0].token, command(view, `spectator-${action}`, payload)), apiError(403, 'spectator'));
  }
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.match.duel.round, 2); assert.deepEqual(view.match.pending, [false, false]);
  assert.equal(Object.hasOwn(view.match, 'actions'), false); assert.equal(Object.hasOwn(view.match, 'botActionAt'), false);
  await f.tick(0); assert.equal((await f.view(view.code)).match.duel.round, 2);
  await f.tick(60000); assert.equal((await f.view(view.code)).match.duel.round, 3, 'An overdue bot pair may resolve only one round per tick.');
  await f.tick(0); assert.equal((await f.view(view.code)).match.duel.round, 3);
});

test('bots remain connected after restart without guest heartbeats and cannot lose by a human disconnect timer', async t => {
  const f = await fixture(t, { disconnectMs: 15000 }, true);
  let view = await f.fill(), steps = 0;
  while (view.match.slots.includes(0)) { view = await f.step(view); assert.ok(++steps < 100); }
  if (view.phase === 'entrance') { await f.tick(view.match.deadline - f.now); view = await f.view(view.code); }
  assert.equal(view.phase, 'battle');
  await f.restart();
  const botIds = f.service.data.tournaments[view.code].match.playerIds;
  assert.ok(botIds.every(id => !f.service.lastSeen.has(id)));
  view = await f.view(view.code);
  assert.equal(view.phase, 'battle'); assert.ok(view.match.players.every(profile => profile.connected));
  await f.tick(15000); view = await f.view(view.code);
  assert.equal(view.phase, 'battle'); assert.equal(view.match.duel.round, 2);
  assert.ok(view.match.players.every(profile => profile.connected));
});

test('durable restart preserves bot identity, lobby timing, private gear, and an already committed bot action', async t => {
  const f = await fixture(t, {}, true), { view: initial } = await f.enter();
  await f.tick(20000); let view = await f.view(initial.code);
  const before = structuredClone(view.players), deadline = view.nextBotAt;
  await f.tick(5000); await f.restart(); view = await f.view(initial.code);
  assert.deepEqual(view.players, before); assert.equal(view.nextBotAt, deadline);
  await f.tick(14999); assert.equal((await f.view(initial.code)).players.length, 2);
  await f.tick(1); assert.equal((await f.view(initial.code)).players.length, 3);
  for (let index = 0; index < 5; index += 1) await f.tick(20000);
  view = await f.view(initial.code); let steps = 0;
  while (!view.match.slots.includes(0)) { view = await f.step(view); assert.ok(++steps < 300); }
  const humanIndex = view.match.slots.indexOf(0), botIndex = 1 - humanIndex;
  const privateGear = structuredClone(f.service.data.tournaments[view.code].match.loadouts[botIndex]);
  await f.restart(); view = await f.view(view.code);
  assert.deepEqual(f.service.data.tournaments[view.code].match.loadouts[botIndex], privateGear);
  view = await f.commit(view, humanIndex, 'loadout', { loadout: gear() });
  await f.tick(8000); await f.tick(1500); view = await f.view(view.code);
  const actionDeadline = f.service.data.tournaments[view.code].match.botActionAt[botIndex];
  await f.restart(); view = await f.view(view.code);
  assert.equal(f.service.data.tournaments[view.code].match.botActionAt[botIndex], actionDeadline);
  await f.tick(1499); assert.equal((await f.view(view.code)).match.pending[botIndex], false);
  await f.tick(1); view = await f.view(view.code);
  const action = f.service.data.tournaments[view.code].match.actions[botIndex];
  assert.equal(view.match.pending[botIndex], true);
  await f.restart(); view = await f.view(view.code);
  assert.equal(view.match.pending[botIndex], true); assert.equal(f.service.data.tournaments[view.code].match.actions[botIndex], action);
  assert.equal(view.match.duel.round, 1); assert.equal(view.match.players[botIndex].connected, true);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  const raw = await readFile(f.storePath, 'utf8'); assert.ok(!raw.includes(f.sessions[0].token));
});

test('a one-human seven-bot tournament completes all seven matches, spares losers, and persists the real fighter records exactly once', async t => {
  const f = await fixture(t);
  let view = await f.fill(), steps = 0;
  const identity = structuredClone(view.players[0].character);
  while (view.phase !== 'complete') { view = await f.step(view); assert.ok(++steps < 500, 'Bots must keep the tournament advancing.'); }
  assert.equal(view.bracket.filter(match => match.status === 'complete').length, 7);
  assert.notEqual(view.champion, null); assert.equal(view.nextBotAt, null);
  assert.ok(view.players.every(profile => profile.alive));
  assert.ok(view.bracket.every(match => match.advanceReason === 'victory' || match.advanceReason === 'draw_seed'));
  assert.deepEqual(view.players[0].character, identity);
  const humanWins = view.bracket.filter(match => match.winner === 0).length;
  const session = await f.request('GET', '/api/session', f.sessions[0].token);
  assert.deepEqual(session.character, identity); assert.equal(session.alive, true);
  assert.equal(session.duelWins, humanWins); assert.equal(session.tournamentWins, view.champion === 0 ? 1 : 0);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  const completed = structuredClone(view.bracket);
  await f.tick(100000); view = await f.view(view.code);
  assert.deepEqual(view.bracket, completed); assert.equal(view.players[0].duelWins, humanWins);
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[0].token, command(view, 'finished-human-leave'));
  const resumed = await f.request('POST', '/api/tournaments/enter', f.sessions[0].token, { character: session.character });
  assert.deepEqual(resumed.players[resumed.you].character, identity); assert.equal(resumed.players[resumed.you].duelWins, humanWins);
});

test('a failed atomic write rolls back bot insertion and its timer before retrying one seat', async t => {
  let persisted = { schema: 1, sessions: {}, rooms: {} }, rejectWrite = false;
  const store = { async read() { return structuredClone(persisted); }, async write(data) { if (rejectWrite) throw new Error('Disk unavailable'); persisted = structuredClone(data); } };
  const f = await fixture(t, { store }), { view: initial } = await f.enter();
  const before = structuredClone(f.service.data), durable = structuredClone(persisted);
  rejectWrite = true;
  await assert.rejects(f.tick(20000), /Disk unavailable/);
  assert.deepEqual(f.service.data, before); assert.deepEqual(persisted, durable);
  rejectWrite = false; await f.tick(0);
  const view = await f.view(initial.code);
  assert.equal(view.players.length, 2); assert.equal(view.nextBotAt, f.now + 20000); assert.equal(Object.keys(f.service.data.sessions).length, 1);
});

test('a failed atomic write also rolls back a bot action and preserves the original round deadline', async t => {
  let persisted = { schema: 1, sessions: {}, rooms: {} }, rejectWrite = false;
  const store = { async read() { return structuredClone(persisted); }, async write(data) { if (rejectWrite) throw new Error('Disk unavailable'); persisted = structuredClone(data); } };
  const f = await fixture(t, { store }), equipment = await f.humanMatch();
  const humanIndex = equipment.match.slots.indexOf(0), botIndex = 1 - humanIndex;
  let view = await f.commit(equipment, humanIndex, 'loadout', { loadout: gear() });
  await f.tick(8000); view = await f.view(view.code);
  const before = structuredClone(f.service.data.tournaments[view.code]), durable = structuredClone(persisted);
  rejectWrite = true;
  await assert.rejects(f.tick(3000), /Disk unavailable/);
  assert.deepEqual(f.service.data.tournaments[view.code], before); assert.deepEqual(persisted, durable);
  rejectWrite = false; await f.tick(0); view = await f.view(view.code);
  assert.equal(view.match.pending[botIndex], true); assert.equal(view.match.pending[humanIndex], false);
  assert.equal(view.match.deadline, before.match.deadline); assert.equal(view.match.duel.round, 1);
});

test('the last human leaving a waiting lobby stops bot filling and idempotent departure retries do not revive it', async t => {
  const f = await fixture(t), { guest, view: initial } = await f.enter();
  await f.tick(20000); const view = await f.view(initial.code);
  const leaving = command(view, 'last-human-leave');
  assert.deepEqual(await f.request('POST', `/api/tournaments/${view.code}/leave`, guest.token, leaving), { left: true });
  assert.deepEqual(await f.request('POST', `/api/tournaments/${view.code}/leave`, guest.token, leaving), { left: true });
  const remaining = structuredClone(f.service.data.tournaments[view.code].players);
  assert.equal(remaining.length, 1); assert.equal(remaining[0].bot, true);
  assert.equal(f.service.data.tournaments[view.code].nextBotAt, null);
  await f.tick(140000);
  assert.deepEqual(f.service.data.tournaments[view.code].players, remaining);
  assert.equal(f.service.data.tournaments[view.code].nextBotAt, null);
  assert.equal((await f.request('GET', '/api/session', guest.token)).activeTournament, null);
});
