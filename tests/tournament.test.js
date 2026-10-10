import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DuelService } from '../online/service.mjs';
import { createAppServer } from '../server.mjs';
import { createDuel, resolveRound, getActionOptions } from '../src/combat.js';

const character = (name, extra = {}) => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b87333', appearance: { sex: 'male', hairstyle: 'shag', skin: 'ivory', hairColor: 'chestnut', eyes: 'amber', facePreset: 'p10' }, ...extra });
const gear = (weapon = 'sword', armor = 'medium', helmet = 'none') => ({ weapon, armor, helmet });
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const error = (status, code) => actual => { assert.equal(actual.status, status); if (code) assert.equal(actual.code, code); return true; };

async function fixture(t, options = {}, persistent = false) {
  let now = 1000000, service;
  let memory = { schema: 1, sessions: {}, rooms: {} };
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'arena-tournament-')) : null;
  const storePath = directory ? join(directory, 'state.json') : null;
  const store = directory ? undefined : { async read() { return structuredClone(memory); }, async write(data) { memory = structuredClone(data); } };
  const configuration = { storePath, store, clock: () => now, winnerMs: 0, disconnectMs: 10000000, ...options };
  service = new DuelService(configuration);
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const sessions = [];
  t.after(async () => { await service.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  return {
    request, storePath, get service() { return service; }, get now() { return now; }, sessions,
    async session() { const guest = await request('POST', '/api/session', undefined, {}); sessions.push(guest); return guest; },
    async tick(delta) { now += delta; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(configuration); await service.initialized; },
    view(code, rosterIndex = 0) { return request('GET', `/api/tournaments/${code}`, sessions[rosterIndex].token); },
    async lobby() {
      const host = await this.session();
      let view = await request('POST', '/api/tournaments', host.token, { character: character('Fighter 1') });
      for (let index = 1; index < 8; index += 1) {
        const guest = await this.session();
        view = await request('POST', '/api/tournaments/join', guest.token, { code: view.code, character: character(`Fighter ${index + 1}`) });
      }
      return this.view(view.code);
    },
    commit(view, localIndex, action, payload = {}, id = `${view.currentMatchIndex}-${action}-${view.match?.duel?.round ?? 0}-${localIndex}`) {
      const slot = view.match.slots[localIndex];
      return request('POST', `/api/tournaments/${view.code}/${action}`, sessions[slot].token, command(view, id, payload));
    },
    async battle(view, a = gear(), b = gear('spear', 'light')) {
      await this.commit(view, 0, 'loadout', { loadout: a });
      const entrance = await this.commit(view, 1, 'loadout', { loadout: b });
      assert.equal(entrance.phase, 'entrance');
      await this.tick(8000);
      return this.view(view.code, view.match.slots[0]);
    },
    async finish(view, decision = 'spare') {
      let rounds = 0;
      while (view.phase === 'battle') {
        if (view.match.actionOpensAt > now) await this.tick(view.match.actionOpensAt - now);
        const choices = view.match.duel.fighters.map((_, index) => getActionOptions(view.match.duel, index).find(option => option.id === 'strike' && option.enabled) ? 'strike' : 'focus');
        await this.commit(view, 0, 'action', { round: view.match.duel.round, action: choices[0] });
        view = await this.commit(view, 1, 'action', { round: view.match.duel.round, action: choices[1] });
        assert.ok(++rounds <= 24);
      }
      if (view.phase === 'mercy') {
        if (view.match.mercyOpensAt > now) await this.tick(view.match.mercyOpensAt - now);
        view = await this.commit(view, view.match.duel.result.winner, 'mercy', { decision });
      }
      return view;
    },
  };
}

test('eight authenticated entrants start exactly one shuffled quarterfinal and automatic placement fills the oldest lobby', async t => {
  const f = await fixture(t);
  const one = await f.session(), two = await f.session();
  const oldest = await f.request('POST', '/api/tournaments', one.token, { character: character('Oldest') });
  await f.tick(1);
  const newer = await f.request('POST', '/api/tournaments', two.token, { character: character('Newer') });
  const firstIdentity = (await f.request('GET', '/api/session', one.token)).character;
  const resume = await f.request('POST', '/api/tournaments/enter', one.token, { character: firstIdentity });
  assert.equal(resume.code, oldest.code); assert.equal(resume.players.length, 1);
  for (let i = 2; i < 9; i += 1) {
    const guest = await f.session();
    const entry = await f.request('POST', '/api/tournaments/enter', guest.token, { character: character(`Auto ${i}`) });
    assert.equal(entry.code, oldest.code);
    assert.equal(entry.players.length, i);
    assert.equal(entry.phase, i === 8 ? 'equipment' : 'waiting');
  }
  const outsider = await f.session();
  const placed = await f.request('POST', '/api/tournaments/enter', outsider.token, { character: character('Next lobby') });
  assert.equal(placed.code, newer.code);
  const view = await f.request('GET', `/api/tournaments/${oldest.code}`, one.token);
  assert.equal(view.bracket.filter(match => match.status === 'active').length, 1);
  assert.equal(view.currentMatchIndex, 0); assert.equal(view.match.players.length, 2);
  assert.deepEqual(view.players.map(player => player.seed).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(view.bracket.slice(0, 4).flatMap(match => match.slots).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  await assert.rejects(f.request('POST', '/api/tournaments/join', outsider.token, { code: oldest.code, character: character('Next lobby') }), error(409, 'active_room'));
  const stranger = await f.session();
  await assert.rejects(f.request('GET', `/api/tournaments/${oldest.code}`, stranger.token), error(403, 'forbidden'));
  await assert.rejects(f.request('POST', '/api/tournaments/join', stranger.token, { code: oldest.code, character: character('Too late') }), error(409, 'room_full'));
  await assert.rejects(f.request('POST', '/api/rooms', one.token, { character: firstIdentity }), error(409, 'active_room'));
});

test('all six spectators and the opponent see no private loadout or pending action; spectators cannot fight or choose mercy', async t => {
  const f = await fixture(t), view = await f.lobby();
  const chosen = gear('greatsword', 'heavy', 'greathelm');
  const own = await f.commit(view, 0, 'loadout', { loadout: chosen });
  assert.deepEqual(own.match.yourLoadout, chosen); assert.deepEqual(own.match.ready, [true, false]);
  const spectators = view.players.map((_, i) => i).filter(i => !view.match.slots.includes(i));
  assert.equal(spectators.length, 6);
  for (const slot of [...spectators, view.match.slots[1]]) {
    const hidden = await f.view(view.code, slot);
    assert.equal(hidden.match.yourLoadout, null); assert.equal(hidden.match.duel, null);
    for (const secret of Object.values(chosen)) assert.ok(!JSON.stringify(hidden).includes(secret));
  }
  for (const kind of ['loadout', 'action', 'mercy']) {
    const payload = kind === 'loadout' ? { loadout: gear() } : kind === 'action' ? { round: 1, action: 'strike' } : { decision: 'execute' };
    await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/${kind}`, f.sessions[spectators[0]].token, command(view, `spectator-${kind}`, payload)), error(403, 'spectator'));
  }
  const entrance = await f.commit(view, 1, 'loadout', { loadout: gear() });
  assert.equal(entrance.match.duel.fighters[0].weapon, 'greatsword');
  assert.equal(entrance.phase, 'entrance'); assert.equal(entrance.match.deadline, f.now + 8000);
  await assert.rejects(f.commit(entrance, 0, 'action', { round: 1, action: 'strike' }), error(409, 'wrong_phase'));
  await f.tick(7999); assert.equal((await f.view(view.code)).phase, 'entrance');
  await f.tick(1);
  const initial = await f.view(view.code, view.match.slots[0]);
  assert.equal(initial.phase, 'battle'); assert.equal(initial.match.deadline, f.now + 20000);
  const a = command(initial, 'pending-private', { round: 1, action: 'technique' });
  const pending = await f.request('POST', `/api/tournaments/${view.code}/action`, f.sessions[view.match.slots[0]].token, a);
  assert.deepEqual(pending.match.duel, initial.match.duel); assert.deepEqual(pending.match.pending, [true, false]);
  for (const slot of spectators) {
    const watching = await f.view(view.code, slot);
    assert.deepEqual(watching.match.duel, initial.match.duel);
    assert.equal(watching.match.yourLoadout, null); assert.equal(watching.match.you, null); assert.equal(watching.spectator, true);
    assert.ok(!Object.hasOwn(watching.match, 'actions'));
  }
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/action`, f.sessions[view.match.slots[0]].token, { ...a, action: 'guard' }), error(409, 'command_conflict'));
  const next = await f.commit(initial, 1, 'action', { round: 1, action: 'guard' });
  assert.deepEqual(next.match.duel, resolveRound(initial.match.duel, ['technique', 'guard']));
  const replay = await f.request('POST', `/api/tournaments/${view.code}/action`, f.sessions[view.match.slots[0]].token, a);
  assert.deepEqual(replay.match.duel, next.match.duel);
});

test('seven sequential matches form four quarterfinals, two semifinals and one final; champion and survivors retain records', async t => {
  const f = await fixture(t);
  let view = await f.lobby();
  const identities = structuredClone(view.players.map(player => player.character));
  const expectedWins = Array(8).fill(0);
  for (let matchIndex = 0; matchIndex < 7; matchIndex += 1) {
    assert.equal(view.currentMatchIndex, matchIndex);
    assert.equal(view.bracket.filter(match => match.status === 'active').length, 1);
    assert.equal(view.bracket.filter(match => match.status === 'complete').length, matchIndex);
    const previousDuelId = view.duelId;
    view = await f.battle(view);
    view = await f.finish(view);
    const bracket = view.bracket[matchIndex];
    expectedWins[bracket.winner] += 1;
    assert.equal(bracket.status, 'complete'); assert.equal(view.players[bracket.loser].eliminated, true);
    assert.deepEqual(view.players.map(player => player.character), identities);
    assert.deepEqual(view.players.map(player => player.duelWins), expectedWins);
    if (matchIndex < 6) {
      assert.equal(view.phase, 'intermission'); assert.equal(view.nextMatchAt, f.now + 6000);
      await f.tick(5999);
      assert.equal((await f.view(view.code)).currentMatchIndex, matchIndex);
      await f.tick(1); view = await f.view(view.code);
      assert.notEqual(view.duelId, previousDuelId);
      const oldCommand = { commandId: `earlier-match-${matchIndex}`, duelId: previousDuelId, loadout: gear() };
      await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/loadout`, f.sessions[view.match.slots[0]].token, oldCommand), error(409, 'stale_duel'));
    }
  }
  assert.equal(view.phase, 'complete'); assert.equal(view.bracket.filter(match => match.status === 'complete').length, 7);
  assert.deepEqual(view.bracket.slice(4, 6).map(match => match.slots), [[view.bracket[0].winner, view.bracket[1].winner], [view.bracket[2].winner, view.bracket[3].winner]]);
  assert.deepEqual(view.bracket[6].slots, [view.bracket[4].winner, view.bracket[5].winner]);
  assert.equal(view.champion, view.bracket[6].winner);
  assert.equal(expectedWins[view.champion], 3);
  assert.equal(view.players[view.champion].tournamentWins, 1);
  if (view.match.duel.result.winner !== null) {
    const winner = view.match.duel.result.winner;
    const duplicate = await f.commit(view, winner, 'mercy', { decision: 'spare' });
    assert.equal(duplicate.players[duplicate.champion].tournamentWins, 1);
    assert.deepEqual(duplicate.bracket, view.bracket);
  }
  for (const slot of [view.champion, view.bracket[0].loser]) {
    const session = await f.request('GET', '/api/session', f.sessions[slot].token);
    assert.equal(session.activeTournament, view.code); assert.deepEqual(session.character, identities[slot]);
    assert.equal(session.duelWins, expectedWins[slot]); assert.equal(session.tournamentWins, slot === view.champion ? 1 : 0);
    await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[slot].token, command(view, `finished-leave-${slot}`));
    const fresh = await f.request('POST', '/api/tournaments/enter', f.sessions[slot].token, { character: session.character });
    assert.notEqual(fresh.code, view.code); assert.deepEqual(fresh.players[fresh.you].character, identities[slot]);
    assert.equal(fresh.players[fresh.you].duelWins, expectedWins[slot]);
  }
  await f.tick(20000);
  const champion = await f.request('GET', '/api/session', f.sessions[view.champion].token);
  assert.equal(champion.tournamentWins, 1, 'Polling a completed bracket must not award another title.');
});

test('durable restart restores shuffled bracket, private gear, entrance clock, pending choices and intermission', async t => {
  const f = await fixture(t, {}, true), lobby = await f.lobby();
  const chosen = gear('halberd', 'heavy', 'barbute');
  await f.commit(lobby, 0, 'loadout', { loadout: chosen });
  await f.restart();
  let restored = await f.view(lobby.code, lobby.match.slots[0]);
  assert.deepEqual(restored.bracket, lobby.bracket); assert.deepEqual(restored.match.yourLoadout, chosen);
  const watcher = lobby.players.map((_, i) => i).find(i => !lobby.match.slots.includes(i));
  assert.equal((await f.view(lobby.code, watcher)).match.duel, null);
  const entrance = await f.commit(restored, 1, 'loadout', { loadout: gear() });
  await f.tick(3000); await f.restart(); restored = await f.view(lobby.code);
  assert.equal(restored.phase, 'entrance'); assert.equal(restored.match.deadline, entrance.match.deadline);
  await f.tick(5000); restored = await f.view(lobby.code, lobby.match.slots[0]);
  const pending = command(restored, 'saved-action', { round: 1, action: 'strike' });
  await f.request('POST', `/api/tournaments/${lobby.code}/action`, f.sessions[lobby.match.slots[0]].token, pending);
  await f.restart();
  const watching = await f.view(lobby.code, watcher);
  assert.deepEqual(watching.match.pending, [true, false]); assert.deepEqual(watching.match.duel, restored.match.duel);
  let progressed = await f.commit(restored, 1, 'action', { round: 1, action: 'focus' });
  progressed = await f.finish(progressed);
  await f.restart();
  const intermission = await f.view(lobby.code, watcher);
  assert.equal(intermission.phase, 'intermission'); assert.equal(intermission.nextMatchAt, progressed.nextMatchAt);
  assert.deepEqual(intermission.bracket, progressed.bracket);
  const raw = await readFile(f.storePath, 'utf8');
  for (const session of f.sessions) assert.ok(!raw.includes(session.token));
});

test('equipment, action and mercy deadlines advance one event at a time; an exact draw uses the recorded original seed', async t => {
  const f = await fixture(t, { equipmentMs: 100, actionMs: 80, mercyMs: 40 }), lobby = await f.lobby();
  await f.tick(100);
  let view = await f.view(lobby.code);
  assert.equal(view.phase, 'entrance');
  assert.deepEqual(view.match.duel, createDuel(view.match.players.map(player => ({ character: player.character, ...gear() }))));
  await f.tick(8000); view = await f.view(lobby.code);
  assert.equal(view.phase, 'battle'); assert.equal(view.match.deadline, f.now + 80);
  for (let round = 1; round <= 24; round += 1) {
    await f.tick(view.match.deadline - f.now); view = await f.view(lobby.code);
    if (round < 24) { assert.equal(view.phase, 'battle'); assert.equal(view.match.duel.round, round + 1); }
  }
  assert.equal(view.phase, 'intermission'); assert.equal(view.match.duel.result.winner, null);
  assert.equal(view.bracket[0].advanceReason, 'draw_seed');
  const lowestSeed = [...view.match.slots].sort((a, b) => view.players[a].seed - view.players[b].seed)[0];
  assert.equal(view.bracket[0].winner, lowestSeed);
  assert.equal(view.players[lowestSeed].duelWins, 1);
  await f.tick(6000); view = await f.view(lobby.code);
  view = await f.battle(view);
  const loser = view.match.slots[1];
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[loser].token, command(view, 'forfeit-deadline'));
  await f.tick(39); assert.equal((await f.view(view.code, view.match.slots[0])).phase, 'mercy');
  await f.tick(1); assert.equal((await f.view(view.code, view.match.slots[0])).phase, 'intermission');
});

test('waiting departures free seats and retry exactly; spectators leaving cannot disturb the current duel', async t => {
  const f = await fixture(t), one = await f.session(), two = await f.session();
  let waiting = await f.request('POST', '/api/tournaments', one.token, { character: character('Host') });
  waiting = await f.request('POST', '/api/tournaments/join', two.token, { code: waiting.code, character: character('Leaving') });
  const departure = command(waiting, 'leave-seat');
  await f.request('POST', `/api/tournaments/${waiting.code}/leave`, two.token, departure);
  assert.deepEqual(await f.request('POST', `/api/tournaments/${waiting.code}/leave`, two.token, departure), { left: true });
  assert.equal((await f.request('GET', `/api/tournaments/${waiting.code}`, one.token)).players.length, 1);
  for (let index = 2; index < 9; index += 1) {
    const guest = await f.session();
    waiting = await f.request('POST', '/api/tournaments/join', guest.token, { code: waiting.code, character: character(`Seat ${index}`) });
  }
  const watcher = waiting.players.map((_, i) => i).find(i => !waiting.match.slots.includes(i));
  const watcherId = f.service.data.tournaments[waiting.code].playerIds[watcher];
  const watcherGuest = f.sessions.find(guest => guest.playerId === watcherId);
  const before = structuredClone(waiting.match);
  await f.request('POST', `/api/tournaments/${waiting.code}/leave`, watcherGuest.token, command(waiting, 'spectator-leave'));
  const after = await f.request('GET', `/api/tournaments/${waiting.code}`, f.sessions.find(guest => guest.playerId === f.service.data.tournaments[waiting.code].playerIds[waiting.match.slots[0]]).token);
  assert.equal(after.phase, 'equipment'); assert.equal(after.currentMatchIndex, 0);
  assert.equal(after.match.duelId, before.duelId); assert.deepEqual(after.match.ready, before.ready);
  assert.equal(after.players[watcher].left, true);
});

test('an active departure forfeits, mercy blocks reuse and execution requires a new identity', async t => {
  const f = await fixture(t), view = await f.lobby();
  const winnerSlot = view.match.slots[0], loserSlot = view.match.slots[1];
  const loserProfile = view.players[loserSlot];
  const departure = command(view, 'forfeit-before-entry');
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[loserSlot].token, departure);
  const verdict = await f.view(view.code, winnerSlot);
  assert.equal(verdict.phase, 'mercy'); assert.equal(verdict.match.duel.result.winner, 0);
  const pending = await f.request('GET', '/api/session', f.sessions[loserSlot].token);
  assert.equal(pending.activeTournament, null); assert.equal(pending.pendingMercyTournament, view.code);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.sessions[loserSlot].token, { character: pending.character }), error(409, 'pending_mercy'));
  await assert.rejects(f.request('POST', '/api/rooms', f.sessions[loserSlot].token, { character: pending.character }), error(409, 'pending_mercy'));
  const executed = await f.commit(verdict, 0, 'mercy', { decision: 'execute' });
  assert.equal(executed.players[loserSlot].alive, false);
  assert.equal((await f.request('GET', '/api/session', f.sessions[loserSlot].token)).pendingMercyTournament, null);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.sessions[loserSlot].token, { character: loserProfile.character }), error(409, 'character_dead'));
  const replacement = await f.request('POST', '/api/tournaments/enter', f.sessions[loserSlot].token, { character: character('Successor') });
  assert.notEqual(replacement.players[replacement.you].character.id, loserProfile.character.id);
  assert.equal(replacement.players[replacement.you].duelWins, 0);
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[winnerSlot].token, command(executed, 'survivor-leave'));
  const winner = await f.request('GET', '/api/session', f.sessions[winnerSlot].token);
  assert.deepEqual(winner.character, view.players[winnerSlot].character);
  assert.equal(winner.duelWins, 1);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.sessions[winnerSlot].token, { character: winner.character }), error(409, 'pending_mercy'));
});

test('withdrawn future entrants automatically lose their scheduled match without interrupting another pair', async t => {
  const f = await fixture(t), view = await f.lobby();
  const withdrawn = view.bracket[1].slots[0];
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[withdrawn].token, command(view, 'future-withdrawal'));
  const awaiting = await f.request('GET', '/api/session', f.sessions[withdrawn].token);
  assert.equal(awaiting.pendingMercyTournament, view.code);
  assert.equal(awaiting.pendingMercyTournamentDeadline, null, 'An unrelated current match is not this withdrawn fighter\'s verdict countdown.');
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.sessions[withdrawn].token, { character: awaiting.character }), error(409, 'pending_mercy'));
  let current = await f.view(view.code, view.match.slots[0]);
  assert.equal(current.currentMatchIndex, 0); assert.equal(current.phase, 'equipment');
  current = await f.battle(current); current = await f.finish(current);
  await f.tick(6000);
  const winnerSlot = view.bracket[1].slots[1];
  current = await f.view(view.code, winnerSlot);
  assert.equal(current.currentMatchIndex, 1); assert.equal(current.phase, 'mercy');
  assert.equal(current.match.duel.result.winner, 1); assert.equal(current.players[winnerSlot].duelWins, 1);
  assert.equal((await f.request('GET', '/api/session', f.sessions[withdrawn].token)).pendingMercyTournamentDeadline, current.match.deadline);
  current = await f.commit(current, 1, 'mercy', { decision: 'spare' });
  assert.equal(current.bracket[1].loser, withdrawn); assert.equal(current.bracket[1].advanceReason, 'forfeit');
  assert.equal((await f.request('GET', '/api/session', f.sessions[withdrawn].token)).pendingMercyTournament, null);
  const returning = await f.request('POST', '/api/tournaments/enter', f.sessions[withdrawn].token, { character: awaiting.character });
  assert.deepEqual(returning.players[returning.you].character, awaiting.character);
});

test('an eliminated spared fighter can enter a fresh lobby during the remaining six matches', async t => {
  const f = await fixture(t);
  let view = await f.lobby();
  view = await f.battle(view); view = await f.finish(view);
  const loser = view.bracket[0].loser, identity = view.players[loser].character;
  assert.equal(view.players[loser].alive, true);
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.sessions[loser].token, command(view, 'eliminated-leave'));
  const session = await f.request('GET', '/api/session', f.sessions[loser].token);
  assert.equal(session.pendingMercyTournament, null);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.sessions[loser].token, { character: { ...identity, name: 'Changed survivor' } }), error(409, 'identity_locked'));
  const next = await f.request('POST', '/api/tournaments/enter', f.sessions[loser].token, { character: identity });
  assert.notEqual(next.code, view.code); assert.deepEqual(next.players[next.you].character, identity);
  const spectator = view.players.map((_, i) => i).find(i => i !== loser);
  const continuing = await f.view(view.code, spectator);
  assert.equal(continuing.phase, 'intermission'); assert.equal(continuing.currentMatchIndex, 0);
  await f.tick(6000);
  assert.equal((await f.view(view.code, spectator)).currentMatchIndex, 1);
  assert.deepEqual((await f.request('GET', '/api/session', f.sessions[loser].token)).character, identity);
});

test('persistence failure rolls back tournament joins and combat choices before acknowledgment', async t => {
  let state = { schema: 1, sessions: {}, rooms: {} }, rejectWrite = false;
  const store = { async read() { return structuredClone(state); }, async write(data) { if (rejectWrite) throw new Error('Disk unavailable'); state = structuredClone(data); } };
  const f = await fixture(t, { store }), lobby = await f.lobby();
  const privateChoice = command(lobby, 'durable-choice', { loadout: gear('flail', 'heavy') });
  rejectWrite = true;
  await assert.rejects(f.request('POST', `/api/tournaments/${lobby.code}/loadout`, f.sessions[lobby.match.slots[0]].token, privateChoice), /Disk unavailable/);
  rejectWrite = false;
  const unchanged = await f.view(lobby.code, lobby.match.slots[0]);
  assert.deepEqual(unchanged.match.ready, [false, false]);
  const committed = await f.request('POST', `/api/tournaments/${lobby.code}/loadout`, f.sessions[lobby.match.slots[0]].token, privateChoice);
  assert.deepEqual(committed.match.yourLoadout, privateChoice.loadout);
});

test('HTTP tournament endpoints authenticate eight distinct guests and expose a spectator-safe snapshot', async t => {
  let memory = { schema: 1, sessions: {}, rooms: {} };
  const server = createAppServer({ store: { async read() { return structuredClone(memory); }, async write(data) { memory = structuredClone(data); } }, tickMs: 100000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.duels.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = [];
  const request = async (path, token, body) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  assert.equal((await request('/api/tournaments/ABC234')).status, 401);
  let view;
  for (let index = 0; index < 8; index += 1) {
    tokens.push((await request('/api/session', undefined, {})).value.token);
    const entering = await request('/api/tournaments/enter', tokens[index], { character: character(`HTTP ${index + 1}`) });
    assert.equal(entering.status, 200); view = entering.value;
  }
  assert.equal(view.phase, 'equipment'); assert.equal(view.players.length, 8);
  const committed = await request(`/api/tournaments/${view.code}/loadout`, tokens[view.match.slots[0]], command(view, 'http-private', { loadout: gear('flail', 'heavy', 'greathelm') }));
  assert.equal(committed.status, 200);
  const spectator = view.players.map((_, index) => index).find(index => !view.match.slots.includes(index));
  const watching = await request(`/api/tournaments/${view.code}`, tokens[spectator]);
  assert.equal(watching.status, 200); assert.equal(watching.value.spectator, true);
  assert.equal(watching.value.match.yourLoadout, null); assert.equal(watching.value.match.duel, null);
  for (const secret of ['flail', 'heavy', 'greathelm']) assert.ok(!JSON.stringify(watching.value).includes(secret));
  const recovered = await request('/api/session', tokens[spectator]);
  assert.equal(recovered.value.activeTournament, view.code);
  assert.equal((await request('/online/tournament-store.mjs')).status, 404);
});

test('an entirely withdrawn field completes its bracket without awarding an absent champion a title', async t => {
  const f = await fixture(t), initial = await f.lobby();
  let current = initial;
  for (let index = 0; index < 8; index += 1) {
    await f.request('POST', `/api/tournaments/${initial.code}/leave`, f.sessions[index].token, command(current, `empty-field-${index}`));
    // All departures occur during the first match or its intermission, sharing that match ID.
    current = { ...current, duelId: f.service.data.tournaments[initial.code].match.duelId };
  }
  const before = f.service.data.tournaments[initial.code].players.map(profile => profile.duelWins);
  for (let index = 1; index < 7; index += 1) await f.tick(6000);
  const ended = f.service.data.tournaments[initial.code];
  assert.equal(ended.phase, 'complete'); assert.equal(ended.bracket.filter(match => match.status === 'complete').length, 7);
  assert.equal(ended.champion, null); assert.ok(ended.left.every(Boolean));
  assert.deepEqual(ended.players.map(profile => profile.duelWins), before, 'Later double-abandoned matches must not fabricate duel wins.');
  for (const guest of f.sessions) {
    const session = await f.request('GET', '/api/session', guest.token);
    assert.equal(session.tournamentWins, 0); assert.equal(session.pendingMercyTournament, null);
    assert.equal(session.pendingMercyTournamentDeadline, null);
  }
  await f.tick(6000);
  assert.equal(f.service.data.tournaments[initial.code].champion, null);
});

test('a seed-advanced withdrawn fighter remains locked until their later scheduled loss resolves', async t => {
  const f = await fixture(t), initial = await f.lobby();
  for (const slot of initial.bracket[1].slots) {
    await f.request('POST', `/api/tournaments/${initial.code}/leave`, f.sessions[slot].token, command(initial, `double-withdraw-${slot}`));
  }
  let current = await f.battle(initial); current = await f.finish(current);
  await f.tick(6000); current = await f.view(initial.code, initial.match.slots[0]);
  assert.equal(current.currentMatchIndex, 1); assert.equal(current.phase, 'intermission');
  const advanced = current.bracket[1].winner;
  const saved = await f.request('GET', '/api/session', f.sessions[advanced].token);
  assert.equal(saved.pendingMercyTournament, initial.code);
  assert.equal(saved.pendingMercyTournamentDeadline, null);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.sessions[advanced].token, { character: saved.character }), error(409, 'pending_mercy'));
  for (let index = 2; index < 4; index += 1) {
    await f.tick(6000); current = await f.view(initial.code, initial.match.slots[0]);
    assert.equal(current.currentMatchIndex, index);
    current = await f.battle(current); current = await f.finish(current);
  }
  await f.tick(6000); current = await f.view(initial.code, current.bracket[0].winner);
  assert.equal(current.currentMatchIndex, 4); assert.equal(current.phase, 'mercy');
  assert.equal(current.match.slots[1], advanced);
  assert.equal((await f.request('GET', '/api/session', f.sessions[advanced].token)).pendingMercyTournamentDeadline, current.match.deadline);
  current = await f.commit(current, 0, 'mercy', { decision: 'spare' });
  assert.equal(current.bracket[4].loser, advanced);
  assert.equal((await f.request('GET', '/api/session', f.sessions[advanced].token)).pendingMercyTournament, null);
  const next = await f.request('POST', '/api/tournaments/enter', f.sessions[advanced].token, { character: saved.character });
  assert.deepEqual(next.players[next.you].character, saved.character);
});
