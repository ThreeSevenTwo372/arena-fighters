import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuelService } from '../online/service.mjs';
import { validateCharacter, chooseCpuAction } from '../src/combat.js';

const character = name => ({ name, stats: { strength: 5, dexterity: 5, defense: 5, intelligence: 5 },
  trait: 'balanced', color: '#b87333', appearance: { sex: 'male', skin: 'ivory', hairColor: 'chestnut', facePreset: 'p05' } });
const gear = { weapon: 'sword', armor: 'medium', helmet: 'none' };
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const error = (status, code) => actual => { assert.equal(actual.status, status); if (code) assert.equal(actual.code, code); return true; };

async function fixture(t, persistent = false, configuration = {}) {
  let now = 1000000, service, failNextWrite = false, memory = { schema: 1, sessions: {}, rooms: {} };
  const writes = [];
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'arena-single-player-')) : null;
  const storePath = directory ? join(directory, 'state.json') : null;
  const store = directory ? undefined : {
    async read() { return structuredClone(memory); },
    async write(data) {
      if (failNextWrite) { failNextWrite = false; throw new Error('Simulated atomic write failure.'); }
      memory = structuredClone(data); writes.push(structuredClone(data));
    },
  };
  const options = { storePath, store, clock: () => now, winnerMs: 0, disconnectMs: 10000000, ...configuration };
  service = new DuelService(options);
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  t.after(async () => { await service.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
  return {
    request, writes, storePath, get now() { return now; }, get service() { return service; },
    session() { return request('POST', '/api/session', undefined, {}); },
    enter(guest, fighter = character('Aster')) { return request('POST', '/api/tournaments/single-player', guest.token, { character: fighter }); },
    view(view, guest) { return request('GET', `/api/tournaments/${view.code}`, guest.token); },
    async tick(delta) { now += delta; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(options); await service.initialized; },
    changePersisted(change) { change(memory); },
    failNextWrite() { failNextWrite = true; },
  };
}

test('Single Player atomically starts eight legal fighters with the human in the first equipment choice', async t => {
  const f = await fixture(t), guest = await f.session();
  f.writes.length = 0;
  const view = await f.enter(guest);
  assert.equal(view.singlePlayer, true); assert.equal(view.phase, 'equipment');
  assert.equal(view.players.length, 8); assert.equal(view.players.filter(player => player.bot === true).length, 7);
  assert.equal(view.you, 0); assert.equal(view.players[view.you].character.name, 'Aster');
  assert.equal(view.spectator, false); assert.equal(view.currentMatchIndex, 0);
  assert.equal(view.match.you, 0); assert.equal(view.match.slots[0], view.you);
  assert.equal(view.match.players[0].bot, undefined); assert.equal(view.match.players[1].bot, true);
  assert.deepEqual(view.match.ready, [false, true]); assert.equal(view.match.yourLoadout, null);
  assert.equal(view.match.duel, null); assert.equal(view.nextBotAt, null);
  assert.equal(view.bracket.length, 7); assert.equal(view.bracket.filter(match => match.status === 'active').length, 1);
  assert.deepEqual(view.bracket.slice(0, 4).flatMap(match => match.slots).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(view.players.map(player => player.seed).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(view.players[view.you].seed, 1);
  assert.equal(new Set(view.players.map(player => player.character.id)).size, 8);
  assert.equal(new Set(view.players.map(player => player.character.name.toLowerCase())).size, 8);
  for (const player of view.players) assert.equal(validateCharacter(player.character).valid, true);
  const stored = f.service.data.tournaments[view.code];
  assert.equal(stored.singlePlayer, true); assert.equal(stored.playerIds[0], guest.playerId);
  assert.ok(stored.playerIds.slice(1).every(id => id.startsWith('bot:') && !f.service.sessionForPlayer(id)));
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  assert.equal(f.writes.length, 1, 'No partially filled waiting room may be committed.');
  assert.equal(f.writes[0].tournaments[view.code].phase, 'equipment');
  assert.equal(f.writes[0].tournaments[view.code].players.length, 8);
  assert.equal(f.service.sessionForPlayer(guest.playerId).roomStarts.length, 1);
});

test('Single Player leaves existing multiplayer lobbies untouched and ordinary entry still finds them', async t => {
  const f = await fixture(t), host = await f.session(), solo = await f.session();
  const lobby = await f.request('POST', '/api/tournaments', host.token, { character: character('Multiplayer host') });
  const before = structuredClone(f.service.data.tournaments[lobby.code]);
  const single = await f.enter(solo);
  assert.notEqual(single.code, lobby.code);
  assert.deepEqual(f.service.data.tournaments[lobby.code], before);
  const newcomer = await f.session();
  const multiplayer = await f.request('POST', '/api/tournaments/enter', newcomer.token, { character: character('New contender') });
  assert.equal(multiplayer.code, lobby.code); assert.equal(multiplayer.singlePlayer, false);
  assert.equal(multiplayer.players.length, 2);
  assert.equal((await f.view(single, solo)).players.filter(player => player.bot !== true).length, 1);
});

test('concurrent repeated Single Player entry resumes one roster and validates the surviving identity', async t => {
  const f = await fixture(t), guest = await f.session();
  const [first, retry] = await Promise.all([f.enter(guest), f.enter(guest)]);
  assert.equal(retry.code, first.code); assert.equal(retry.duelId, first.duelId);
  assert.deepEqual(retry.players, first.players); assert.deepEqual(retry.bracket, first.bracket);
  assert.equal(Object.keys(f.service.data.tournaments).length, 1);
  assert.equal(f.service.sessionForPlayer(guest.playerId).roomStarts.length, 1);
  const saved = await f.request('GET', '/api/session', guest.token);
  const resume = await f.enter(guest, saved.character);
  assert.equal(resume.code, first.code); assert.equal(resume.match.deadline, first.match.deadline);
  await assert.rejects(f.enter(guest, { ...saved.character, name: 'Different fighter' }), error(409, 'identity_locked'));
  await assert.rejects(f.enter(guest, { ...saved.character, id: 'another-identity' }), error(409, 'identity_locked'));
  await assert.rejects(f.enter(guest, { ...saved.character, stats: { strength: 999 } }), error(400));
  assert.equal((await f.view(first, guest)).players.length, 8);
});

test('authentication, malformed input and active multiplayer guards cannot create or replace a solo bracket', async t => {
  const f = await fixture(t);
  await assert.rejects(f.request('POST', '/api/tournaments/single-player', undefined, { character: character('Aster') }), error(401, 'unauthorized'));
  const guest = await f.session();
  await assert.rejects(f.request('POST', '/api/tournaments/single-player', guest.token, {}), error(400));
  await assert.rejects(f.request('POST', '/api/tournaments/single-player', guest.token, { character: character('Aster'), botCount: 1 }), error(400));
  await assert.rejects(f.enter(guest, { ...character('Aster'), stats: { strength: 20, dexterity: 20, defense: 20, intelligence: 20 } }), error(400));
  assert.equal(Object.keys(f.service.data.tournaments).length, 0);
  assert.equal((await f.request('GET', '/api/session', guest.token)).character, null);
  const room = await f.request('POST', '/api/rooms', guest.token, { character: character('Aster') });
  await assert.rejects(f.enter(guest), error(409, 'active_room'));
  assert.equal((await f.request('GET', '/api/session', guest.token)).activeRoom, room.code);
  const entrant = await f.session();
  const lobby = await f.request('POST', '/api/tournaments', entrant.token, { character: character('Contender') });
  await assert.rejects(f.enter(entrant, character('Contender')), error(409, 'active_room'));
  assert.equal((await f.request('GET', '/api/session', entrant.token)).activeTournament, lobby.code);
  assert.equal(Object.keys(f.service.data.tournaments).length, 1);
});

test('a Single Player roster rejects human joins even in a restored waiting lobby and is excluded from matchmaking', async t => {
  const f = await fixture(t), solo = await f.session(), single = await f.enter(solo);
  const outsider = await f.session();
  await assert.rejects(f.request('POST', '/api/tournaments/join', outsider.token,
    { code: single.code, character: character('Outsider') }), error(409, 'single_player_room'));
  // A damaged or older waiting record still reserves every non-human slot for bots.
  f.changePersisted(data => {
    const room = data.tournaments[single.code];
    room.phase = 'waiting'; room.match = null; room.bracket = [];
    for (const key of ['playerIds', 'players', 'left', 'eliminated', 'seeds']) room[key] = room[key].slice(0, 1);
    room.nextBotAt = f.now + 20000;
  });
  await f.restart();
  await assert.rejects(f.request('POST', '/api/tournaments/join', outsider.token,
    { code: single.code, character: character('Outsider') }), error(409, 'single_player_room'));
  const multiplayer = await f.request('POST', '/api/tournaments/enter', outsider.token, { character: character('Outsider') });
  assert.notEqual(multiplayer.code, single.code); assert.equal(multiplayer.singlePlayer, false);
  const reserved = await f.view(single, solo);
  assert.equal(reserved.singlePlayer, true); assert.equal(reserved.players.length, 1);
  assert.equal((await f.request('GET', '/api/session', outsider.token)).activeTournament, multiplayer.code);
});

test('Single Player uses the existing creation quota and rollback leaves no partial roster', async t => {
  const f = await fixture(t), guest = await f.session();
  f.service.sessionForPlayer(guest.playerId).roomStarts = Array(20).fill(f.now);
  await assert.rejects(f.enter(guest), error(429, 'rate_limited'));
  assert.equal(Object.keys(f.service.data.tournaments).length, 0);
  assert.equal(f.service.sessionForPlayer(guest.playerId).profile, null);
  f.service.sessionForPlayer(guest.playerId).roomStarts = Array(20).fill(f.now - 3600000);
  const view = await f.enter(guest);
  assert.equal(view.players.length, 8); assert.equal(f.service.sessionForPlayer(guest.playerId).roomStarts.length, 1);
});

test('an atomic write failure creates no solo roster or fighter identity before a successful retry', async t => {
  const f = await fixture(t), guest = await f.session();
  f.failNextWrite();
  await assert.rejects(f.enter(guest), /Simulated atomic write failure/);
  assert.equal(Object.keys(f.service.data.tournaments).length, 0);
  const failed = await f.request('GET', '/api/session', guest.token);
  assert.equal(failed.character, null); assert.equal(failed.activeTournament, null);
  assert.equal(f.service.sessionForPlayer(guest.playerId).roomStarts.length, 0);
  const retried = await f.enter(guest);
  assert.equal(retried.phase, 'equipment'); assert.equal(retried.players.length, 8);
  assert.equal(Object.keys(f.service.data.tournaments).length, 1);
  assert.equal(f.service.sessionForPlayer(guest.playerId).roomStarts.length, 1);
});

test('durable restart keeps the solo flag, bracket and same private equipment choice without generating more bots', async t => {
  const f = await fixture(t, true), guest = await f.session(), first = await f.enter(guest);
  const chosen = { weapon: 'greatsword', armor: 'heavy', helmet: 'greathelm' };
  const entrance = await f.request('POST', `/api/tournaments/${first.code}/loadout`, guest.token,
    command(first, 'solo-equipment', { loadout: chosen }));
  assert.equal(entrance.phase, 'entrance'); assert.deepEqual(entrance.match.yourLoadout, chosen);
  const stored = JSON.parse(await readFile(f.storePath, 'utf8'));
  assert.equal(stored.tournaments[first.code].singlePlayer, true);
  await f.restart();
  const saved = await f.request('GET', '/api/session', guest.token);
  const resume = await f.enter(guest, saved.character);
  assert.equal(resume.singlePlayer, true); assert.equal(resume.code, first.code); assert.equal(resume.duelId, entrance.duelId);
  assert.deepEqual(resume.players, entrance.players); assert.deepEqual(resume.bracket, entrance.bracket);
  assert.deepEqual(resume.match.yourLoadout, chosen); assert.equal(resume.match.deadline, entrance.match.deadline);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  const observer = await f.request('GET', `/api/arena/tournaments/${first.code}`);
  assert.equal(observer.singlePlayer, true); assert.equal(observer.you, null); assert.equal(observer.match.you, null);
  assert.equal(observer.match.yourLoadout, null); assert.equal(observer.spectator, true);
});

test('solo leave retains existing mercy authority and permits a fresh bot bracket only after resolution', async t => {
  const f = await fixture(t, false, { winnerMs: 5000 }), guest = await f.session(), first = await f.enter(guest);
  const saved = await f.request('GET', '/api/session', guest.token);
  const leave = command(first, 'solo-leave');
  assert.deepEqual(await f.request('POST', `/api/tournaments/${first.code}/leave`, guest.token, leave), { left: true });
  assert.deepEqual(await f.request('POST', `/api/tournaments/${first.code}/leave`, guest.token, leave), { left: true });
  await assert.rejects(f.enter(guest, saved.character), error(409, 'pending_mercy'));
  await f.tick(5000);
  const next = await f.enter(guest, saved.character);
  assert.notEqual(next.code, first.code); assert.equal(next.singlePlayer, true);
  assert.deepEqual(next.players[next.you].character, saved.character);
  assert.equal(next.players[next.you].alive, true); assert.equal(next.players.filter(player => player.bot === true).length, 7);
  assert.equal(f.service.data.tournaments[first.code].left[first.you], true);
  assert.equal(f.service.data.tournaments[first.code].bracket[0].advanceReason, 'forfeit');
});

test('the full solo bracket advances all seven matches using existing bot schedules and records without bot sessions', async t => {
  const f = await fixture(t), guest = await f.session();
  let view = await f.enter(guest), steps = 0;
  const identities = view.players.map(player => structuredClone(player.character));
  while (view.phase !== 'complete') {
    assert.ok(++steps < 700, 'All bot matches must advance without external guests.');
    if (view.phase === 'equipment') {
      assert.equal(view.spectator, false);
      view = await f.request('POST', `/api/tournaments/${view.code}/loadout`, guest.token,
        command(view, `solo-gear-${view.currentMatchIndex}`, { loadout: gear }));
    } else if (view.phase === 'entrance') await f.tick(view.match.deadline - f.now);
    else if (view.phase === 'battle') {
      if (view.match.actionOpensAt > f.now) {
        await f.tick(view.match.actionOpensAt - f.now);
        view = await f.view(view, guest);
      }
      const round = view.match.duel.round;
      if (!view.spectator && !view.match.pending[view.match.you]) {
        view = await f.request('POST', `/api/tournaments/${view.code}/action`, guest.token,
          command(view, `solo-action-${view.currentMatchIndex}-${round}`,
            { round, action: chooseCpuAction(view.match.duel, view.match.you) }));
      }
      if (view.phase === 'battle' && view.match.duel.round === round) await f.tick(3000);
    } else if (view.phase === 'mercy') {
      if (view.match.mercyOpensAt > f.now) await f.tick(view.match.mercyOpensAt - f.now);
      view = await f.view(view, guest);
      if (view.phase === 'mercy') view = await f.request('POST', `/api/tournaments/${view.code}/mercy`, guest.token,
        command(view, `solo-mercy-${view.currentMatchIndex}`, { decision: 'spare' }));
    } else if (view.phase === 'intermission') await f.tick(view.nextMatchAt - f.now);
    view = await f.view(view, guest);
  }
  assert.equal(view.bracket.filter(match => match.status === 'complete').length, 7);
  assert.deepEqual(view.players.map(player => player.character), identities);
  assert.equal(view.players[view.champion].tournamentWins, 1);
  assert.equal(Object.keys(f.service.data.sessions).length, 1);
  const saved = await f.request('GET', '/api/session', guest.token);
  assert.deepEqual(saved.character, identities[view.you]);
  assert.equal(saved.duelWins, view.players[view.you].duelWins);
  assert.equal(saved.tournamentWins, view.players[view.you].tournamentWins);
  await f.tick(20000);
  assert.equal((await f.view(view, guest)).players[view.champion].tournamentWins, 1);
});

function captureGeneratedMatches(f) {
  const generated = [];
  const store = f.service.tournaments, original = store.resolveSoloBotMatch;
  store.resolveSoloBotMatch = function (tournament, now) {
    original.call(this, tournament, now);
    generated.push({ match: structuredClone(tournament.match), bracket: structuredClone(tournament.bracket[tournament.currentMatchIndex]) });
  };
  return generated;
}

// Use the existing service forfeit authority to select deterministic human win/loss
// fixtures; the generated bot matches themselves still play every legal round.
async function finishHumanFixture(f, view, guest, humanWins) {
  await f.service.serialize(() => {
    const tournament = f.service.data.tournaments[view.code];
    const human = tournament.match.slots.indexOf(view.you);
    f.service.forfeit(tournament.match, humanWins ? 1 - human : human, f.now);
    f.service.tournaments.syncMatch(tournament, f.now);
    f.service.tournaments.touch(tournament);
  });
  view = await f.view(view, guest);
  if (view.phase === 'mercy') {
    await f.tick(view.match.mercyOpensAt - f.now);
    view = await f.view(view, guest);
    if (view.phase === 'mercy') view = await f.request('POST', `/api/tournaments/${view.code}/mercy`, guest.token,
      command(view, `fixture-mercy-${view.currentMatchIndex}`, { decision: 'spare' }));
  }
  return view;
}

test('solo quarterfinal advances directly to the human semifinal and final after each existing intermission', async t => {
  const f = await fixture(t, false, { winnerMs: 5000 }), guest = await f.session();
  let view = await f.enter(guest);
  const generated = captureGeneratedMatches(f);
  view = await finishHumanFixture(f, view, guest, true);
  assert.equal(view.phase, 'intermission'); assert.equal(view.currentMatchIndex, 0);
  const acceptedMatch = structuredClone(view.match), next = view.nextMatchAt;
  await f.tick(5999); view = await f.view(view, guest);
  assert.equal(view.currentMatchIndex, 0); assert.deepEqual(view.match, acceptedMatch);
  assert.equal(generated.length, 0, 'The human outcome remains available during its presentation interval.');
  await f.tick(1); view = await f.view(view, guest);
  assert.equal(f.now, next); assert.equal(view.currentMatchIndex, 4); assert.equal(view.phase, 'equipment');
  assert.equal(view.spectator, false); assert.equal(view.match.players[view.match.you].bot, undefined);
  assert.equal(view.match.deadline, f.now + 120000, 'Generated rounds must not advance the real human equipment clock.');
  assert.deepEqual(generated.map(result => result.bracket.index), [1, 2, 3]);
  assert.equal(view.bracket.filter(match => match.status === 'complete').length, 4);
  view = await finishHumanFixture(f, view, guest, true);
  await f.tick(6000); view = await f.view(view, guest);
  assert.equal(view.currentMatchIndex, 6); assert.equal(view.phase, 'equipment'); assert.equal(view.spectator, false);
  assert.deepEqual(generated.map(result => result.bracket.index), [1, 2, 3, 5]);
  view = await finishHumanFixture(f, view, guest, true);
  assert.equal(view.phase, 'complete'); assert.equal(view.champion, view.you);
  assert.equal(view.bracket.filter(match => match.status === 'complete').length, 7);
  assert.equal(view.players[view.you].duelWins, 3); assert.equal(view.players[view.you].tournamentWins, 1);
  for (const { match, bracket } of generated) {
    assert.ok(match.players.every(player => player.bot === true));
    assert.equal(match.duel.status, 'complete'); assert.ok(match.duel.round <= 24);
    assert.equal(bracket.status, 'complete'); assert.ok(Number.isInteger(bracket.winner));
    for (const event of match.duel.log.filter(event => event.type === 'initiative')) {
      assert.deepEqual(event.choiceElapsedMs, [3000, 3000]);
    }
    if (match.duel.result.winner !== null) assert.equal(match.decision.decision, 'spare');
    assert.equal(match.phase, 'complete'); assert.equal(match.deadline, null);
    assert.equal(match.mercyOpensAt, null);
  }
  await f.tick(60000); view = await f.view(view, guest);
  assert.equal(generated.length, 4); assert.equal(view.players[view.you].tournamentWins, 1);
});

test('human elimination completes all remaining bot nodes at one intermission boundary and never awards a second title', async t => {
  const f = await fixture(t, false, { winnerMs: 5000 }), guest = await f.session();
  let view = await f.enter(guest);
  const generated = captureGeneratedMatches(f);
  view = await finishHumanFixture(f, view, guest, false);
  assert.equal(view.phase, 'intermission'); assert.equal(view.players[view.you].eliminated, true);
  assert.equal(generated.length, 0);
  await f.tick(6000); view = await f.view(view, guest);
  assert.equal(view.phase, 'complete'); assert.equal(view.bracket.filter(match => match.status === 'complete').length, 7);
  assert.equal(generated.length, 6); assert.equal(view.players[view.champion].bot, true);
  assert.equal(view.players[view.champion].tournamentWins, 1); assert.equal(view.players[view.you].tournamentWins, 0);
  const completed = structuredClone(view.bracket), champion = view.champion;
  for (let repeat = 0; repeat < 3; repeat += 1) { await f.tick(20000); view = await f.enter(guest, view.players[view.you].character); }
  assert.deepEqual(view.bracket, completed); assert.equal(generated.length, 6);
  assert.equal(view.players[champion].tournamentWins, 1);
});

test('durable restart preserves a human intermission then skips bot rounds once into the same semifinal', async t => {
  const f = await fixture(t, true), guest = await f.session();
  let view = await f.enter(guest);
  view = await finishHumanFixture(f, view, guest, true);
  const deadline = view.nextMatchAt, acceptedMatch = structuredClone(view.match);
  await f.tick(3000); await f.restart(); view = await f.view(view, guest);
  assert.equal(view.nextMatchAt, deadline); assert.deepEqual(view.match, acceptedMatch);
  const generated = captureGeneratedMatches(f);
  await f.tick(3000); view = await f.view(view, guest);
  assert.equal(view.currentMatchIndex, 4); assert.equal(view.phase, 'equipment'); assert.equal(generated.length, 3);
  const semifinalId = view.duelId, roster = structuredClone(view.players);
  await f.restart(); view = await f.enter(guest, view.players[view.you].character);
  assert.equal(view.duelId, semifinalId); assert.deepEqual(view.players, roster);
  assert.equal(view.currentMatchIndex, 4); assert.equal(view.bracket.filter(match => match.status === 'complete').length, 4);
});

test('failed persistence rolls back every skipped bot result and crown before the complete bracket retries once', async t => {
  const f = await fixture(t), guest = await f.session();
  let view = await f.enter(guest);
  view = await finishHumanFixture(f, view, guest, false);
  const before = structuredClone(f.service.data.tournaments[view.code]);
  f.failNextWrite();
  await assert.rejects(f.tick(6000), /Simulated atomic write failure/);
  assert.deepEqual(f.service.data.tournaments[view.code], before);
  assert.equal(before.champion, null); assert.equal(before.bracket.filter(match => match.status === 'complete').length, 1);
  await f.tick(0); view = await f.view(view, guest);
  assert.equal(view.phase, 'complete'); assert.equal(view.bracket.filter(match => match.status === 'complete').length, 7);
  assert.equal(view.players[view.champion].tournamentWins, 1);
  await f.tick(60000); view = await f.view(view, guest);
  assert.equal(view.players[view.champion].tournamentWins, 1);
});
