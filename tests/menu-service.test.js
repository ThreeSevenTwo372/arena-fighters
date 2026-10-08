import test from 'node:test';
import assert from 'node:assert/strict';
import { DuelService } from '../online/service.mjs';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b87333', appearance: { sex: 'female', facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' } });
const command = (view, id, extra = {}) => ({ commandId: id, duelId: view.duelId, ...extra });
const apiError = (status, code) => error => error.status === status && (!code || error.code === code);
const gear = { weapon: 'greatsword', armor: 'heavy', helmet: 'greathelm' };

async function fixture(t, options = {}) {
  let now = 1000000, memory = { schema: 1, sessions: {}, rooms: {} }, failing = false, service;
  const store = { async read() { return structuredClone(memory); }, async write(data) {
    if (failing) throw new Error('Synthetic write failure');
    memory = structuredClone(data);
  } };
  const configuration = { store, clock: () => now, winnerMs: 0, disconnectMs: 10000000, ...options };
  service = new DuelService(configuration);
  const guests = [];
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const f = {
    request, guests, get service() { return service; }, get now() { return now; },
    fail(value) { failing = value; },
    async tick(delta) { now += delta; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(configuration); await service.initialized; },
    async guest() { const guest = await request('POST', '/api/session', null, {}); guests.push(guest); return guest; },
    async pair() {
      const one = await this.guest(), two = await this.guest();
      const waiting = await request('POST', '/api/rooms', one.token, { character: character('Cassian') });
      const room = await request('POST', '/api/rooms/join', two.token, { code: waiting.code, character: character('Mira') });
      return { one, two, room };
    },
    async lobby() {
      let view;
      for (let index = 0; index < 8; index++) {
        const guest = await this.guest();
        view = await request('POST', index ? '/api/tournaments/join' : '/api/tournaments', guest.token,
          { ...(index ? { code: view.code } : {}), character: character(`Human ${index + 1}`) });
      }
      return view;
    },
    tokenAt(view, slot) {
      const id = service.data.tournaments[view.code].playerIds[slot];
      return guests.find(guest => guest.playerId === id).token;
    },
    async roomMercy(pair) {
      await request('POST', `/api/rooms/${pair.room.code}/leave`, pair.two.token, command(pair.room, 'loser-leaves'));
      return request('GET', `/api/rooms/${pair.room.code}`, pair.one.token);
    },
  };
  t.after(() => service.close());
  return f;
}

test('public menu reads need no guest, while the personal graveyard requires its bearer', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.request('GET', '/api/arena/tournaments'), { tournaments: [], sessionMode: 'persistent' });
  assert.deepEqual(await f.request('GET', '/api/arena/leaderboard', 'expired-or-malformed-token'), { fighters: [], sessionMode: 'persistent' });
  assert.equal(Object.keys(f.service.data.sessions).length, 0);
  await assert.rejects(f.request('GET', '/api/graveyard'), apiError(401, 'unauthorized'));
  await assert.rejects(f.request('POST', '/api/arena/tournaments', null, {}), apiError(405));
  const guest = await f.guest();
  assert.deepEqual(await f.request('GET', '/api/graveyard', guest.token), { graves: [], sessionMode: 'persistent' });
  await assert.rejects(f.request('POST', '/api/graveyard', guest.token, { graves: [] }), apiError(405));
});

test('match browsing shows waiting and active tournaments, keeps completed playback available, and exposes no auth records', async t => {
  const f = await fixture(t), owner = await f.guest();
  const waiting = await f.request('POST', '/api/tournaments', owner.token, { character: character('Waiting human') });
  const active = await f.lobby();
  const list = await f.request('GET', '/api/arena/tournaments');
  assert.equal(list.tournaments.length, 2);
  const open = list.tournaments.find(lobby => lobby.code === waiting.code);
  assert.deepEqual(open, { code: waiting.code, phase: 'waiting', playerCount: 1, currentMatchLabel: null, fighters: ['Waiting human'] });
  const running = list.tournaments.find(lobby => lobby.code === active.code);
  assert.equal(running.currentMatchLabel, 'Quarterfinal 1');
  assert.equal(running.playerCount, 8);
  assert.deepEqual(running.fighters, active.match.players.map(player => player.character.name));
  const serialized = JSON.stringify(list);
  for (const guest of f.guests) { assert.ok(!serialized.includes(guest.token)); assert.ok(!serialized.includes(guest.playerId)); }
  assert.ok(!serialized.includes('roomStarts'));
  await f.service.serialize(() => { f.service.data.tournaments[active.code].phase = 'complete'; f.service.changed = true; });
  assert.equal((await f.request('GET', '/api/arena/tournaments')).tournaments.some(lobby => lobby.code === active.code), false);
  assert.equal((await f.request('GET', `/api/arena/tournaments/${active.code}`)).phase, 'complete');
  await assert.rejects(f.request('GET', '/api/arena/tournaments/ABC234'), apiError(404, 'room_not_found'));
});

test('outside observers have no roster seat, private gear, pending choices, votes, or gameplay authority', async t => {
  const f = await fixture(t), view = await f.lobby(), outsider = await f.guest();
  const duelist = f.tokenAt(view, view.match.slots[0]);
  await f.request('POST', `/api/tournaments/${view.code}/loadout`, duelist, command(view, 'private-gear', { loadout: gear }));
  const beforeIds = structuredClone(f.service.data.tournaments[view.code].playerIds);
  const observing = await f.request('GET', `/api/arena/tournaments/${view.code}`, outsider.token);
  assert.equal(observing.you, null); assert.equal(observing.role, 'spectator'); assert.equal(observing.spectator, true);
  assert.equal(observing.match.you, null); assert.equal(observing.match.yourLoadout, null); assert.equal(observing.match.duel, null);
  assert.equal(observing.match.canRematch, false); assert.deepEqual(observing.match.ready, [true, false]);
  for (const privateId of Object.values(gear)) assert.ok(!JSON.stringify(observing).includes(privateId));
  for (const guest of f.guests) { assert.ok(!JSON.stringify(observing).includes(guest.token)); assert.ok(!JSON.stringify(observing).includes(guest.playerId)); }
  assert.deepEqual(f.service.data.tournaments[view.code].playerIds, beforeIds);
  assert.equal((await f.request('GET', '/api/session', outsider.token)).activeTournament, null);
  const payloads = { loadout: { loadout: gear }, action: { round: 1, action: 'strike' }, mercy: { decision: 'execute' }, vote: { decision: 'execute' }, leave: {} };
  for (const [kind, payload] of Object.entries(payloads)) {
    await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/${kind}`, outsider.token,
      command(view, `outside-${kind}`, payload)), apiError(403, 'forbidden'));
  }
  assert.deepEqual(f.service.data.tournaments[view.code].playerIds, beforeIds);
  // A genuine entrant retains their vote in the participant endpoint; observing does not confer it.
  const loser = view.match.slots[1], winner = view.match.slots[0];
  await f.request('POST', `/api/tournaments/${view.code}/leave`, f.tokenAt(view, loser), command(view, 'forfeit'));
  const mercy = await f.request('GET', `/api/tournaments/${view.code}`, f.tokenAt(view, winner));
  await f.request('POST', `/api/tournaments/${view.code}/mercy`, f.tokenAt(view, winner), command(mercy, 'ask-crowd', { decision: 'crowd' }));
  const spectatorSlot = view.players.findIndex((_, slot) => !view.match.slots.includes(slot));
  const participant = await f.request('GET', `/api/tournaments/${view.code}`, f.tokenAt(view, spectatorSlot));
  assert.equal(participant.crowdVote.canVote, true);
  const publicCrowd = await f.request('GET', `/api/arena/tournaments/${view.code}`, f.tokenAt(view, spectatorSlot));
  assert.equal(publicCrowd.crowdVote.canVote, false); assert.equal(publicCrowd.crowdVote.yourVote, null);
  assert.equal(publicCrowd.match.crowdVote.canVote, false);
});

test('the leaderboard ranks living human identities by battle wins, with crowns separate and stable ties', async t => {
  const f = await fixture(t), view = await f.lobby();
  const profiles = f.guests.map(guest => f.service.sessionForPlayer(guest.playerId).profile);
  await f.service.serialize(() => {
    profiles[0].duelWins = 4; profiles[0].tournamentWins = 1;
    profiles[1].duelWins = 4; profiles[1].tournamentWins = 3;
    profiles[2].duelWins = 100; profiles[2].alive = false;
    profiles[3].duelWins = 100; profiles[3].bot = true;
    delete profiles[4].tournamentWins; // Earlier persistent saves omit this counter.
    f.service.changed = true;
  });
  const board = await f.request('GET', '/api/arena/leaderboard');
  assert.equal(board.fighters.length, 6);
  assert.equal(board.fighters[0].character.id, profiles[1].character.id);
  assert.equal(board.fighters[1].character.id, profiles[0].character.id);
  assert.deepEqual(board.fighters.map(fighter => fighter.rank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(board.fighters.slice(2).map(fighter => fighter.character.id), profiles.slice(4).map(profile => profile.character.id).sort());
  assert.equal(board.fighters.find(fighter => fighter.character.id === profiles[4].character.id).tournamentWins, 0);
  for (const fighter of board.fighters) assert.deepEqual(Object.keys(fighter.character).sort(), ['appearance', 'color', 'id', 'name']);
  const serialized = JSON.stringify(board);
  for (const guest of f.guests) { assert.ok(!serialized.includes(guest.token)); assert.ok(!serialized.includes(guest.playerId)); }
  assert.equal(serialized.includes('stats'), false); assert.equal(serialized.includes('activeTournament'), false);
  assert.equal(view.players.length, 8);
});

test('accepted execution creates one private grave with the exact saved identity, surviving replacement and restart', async t => {
  const f = await fixture(t), pair = await f.pair();
  const identity = structuredClone(pair.room.players[1].character);
  const mercy = await f.roomMercy(pair), verdict = command(mercy, 'accepted-execution', { decision: 'execute' });
  await f.request('POST', `/api/rooms/${mercy.code}/mercy`, pair.one.token, verdict);
  await f.request('POST', `/api/rooms/${mercy.code}/mercy`, pair.one.token, verdict);
  const result = await f.request('GET', '/api/graveyard', pair.two.token);
  assert.deepEqual(result.graves, [{ character: identity, duelWins: 0, tournamentWins: 0,
    diedAt: f.now, killedBy: 'Cassian', code: mercy.code }]);
  assert.deepEqual((await f.request('GET', '/api/graveyard', pair.one.token)).graves, []);
  const next = await f.request('POST', '/api/rooms', pair.two.token, { character: character('Successor') });
  assert.notEqual(next.players[0].character.id, identity.id);
  await f.restart();
  assert.deepEqual(await f.request('GET', '/api/graveyard', pair.two.token), result);
  const board = await f.request('GET', '/api/arena/leaderboard');
  assert.equal(board.fighters.some(fighter => fighter.character.id === identity.id), false);
  assert.equal(board.fighters.some(fighter => fighter.character.id === next.players[0].character.id), true);
});

test('tournament execution archives the human loser through the same authoritative verdict path', async t => {
  const f = await fixture(t), view = await f.lobby();
  const [loser, winner] = view.match.slots, losingToken = f.tokenAt(view, loser), winningToken = f.tokenAt(view, winner);
  const identity = structuredClone(view.players[loser].character);
  await f.request('POST', `/api/tournaments/${view.code}/leave`, losingToken, command(view, 'leave-active-duel'));
  const mercy = await f.request('GET', `/api/tournaments/${view.code}`, winningToken);
  const verdict = command(mercy, 'kill-defeated-fighter', { decision: 'execute' });
  await f.request('POST', `/api/tournaments/${view.code}/mercy`, winningToken, verdict);
  await f.request('POST', `/api/tournaments/${view.code}/mercy`, winningToken, verdict);
  const graves = (await f.request('GET', '/api/graveyard', losingToken)).graves;
  assert.equal(graves.length, 1); assert.deepEqual(graves[0].character, identity);
  assert.equal(graves[0].killedBy, view.players[winner].character.name); assert.equal(graves[0].code, view.code);
  await f.request('POST', '/api/tournaments/enter', losingToken, { character: character('New tournament fighter') });
  assert.deepEqual((await f.request('GET', '/api/graveyard', losingToken)).graves, graves);
});

test('successive replacement deaths retain every grave for the same player', async t => {
  const f = await fixture(t), pair = await f.pair(), firstMercy = await f.roomMercy(pair);
  await f.request('POST', `/api/rooms/${firstMercy.code}/mercy`, pair.one.token,
    command(firstMercy, 'first-death', { decision: 'execute' }));
  const firstGrave = (await f.request('GET', '/api/graveyard', pair.two.token)).graves[0];
  await f.tick(1000);
  const successor = await f.request('POST', '/api/rooms', pair.two.token, { character: character('Successor') });
  const challenger = await f.guest();
  const joined = await f.request('POST', '/api/rooms/join', challenger.token,
    { code: successor.code, character: character('Challenger') });
  await f.request('POST', `/api/rooms/${joined.code}/leave`, pair.two.token, command(joined, 'successor-forfeits'));
  const secondMercy = await f.request('GET', `/api/rooms/${joined.code}`, challenger.token);
  await f.request('POST', `/api/rooms/${joined.code}/mercy`, challenger.token,
    command(secondMercy, 'second-death', { decision: 'execute' }));
  await f.restart();
  const graves = (await f.request('GET', '/api/graveyard', pair.two.token)).graves;
  assert.equal(graves.length, 2); assert.deepEqual(graves[0], firstGrave);
  assert.equal(graves[1].character.id, successor.players[0].character.id);
  assert.equal(graves[1].character.name, 'Successor'); assert.equal(graves[1].killedBy, 'Challenger');
  assert.equal(graves[1].diedAt, firstGrave.diedAt + 1000);
});

test('crowd votes create a grave only when their authoritative execution resolves at the deadline', async t => {
  const f = await fixture(t), view = await f.lobby(), [loser, winner] = view.match.slots;
  const losingToken = f.tokenAt(view, loser), winningToken = f.tokenAt(view, winner);
  await f.request('POST', `/api/tournaments/${view.code}/leave`, losingToken, command(view, 'crowd-loser-forfeits'));
  const mercy = await f.request('GET', `/api/tournaments/${view.code}`, winningToken);
  const crowd = await f.request('POST', `/api/tournaments/${view.code}/mercy`, winningToken,
    command(mercy, 'delegate-verdict', { decision: 'crowd' }));
  const voters = view.players.map((_, slot) => slot).filter(slot => !view.match.slots.includes(slot));
  for (const slot of voters.slice(0, 4)) await f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenAt(view, slot),
    command(crowd, `vote-${slot}`, { decision: 'execute' }));
  assert.deepEqual((await f.request('GET', '/api/graveyard', losingToken)).graves, []);
  await f.tick(19999);
  assert.deepEqual((await f.request('GET', '/api/graveyard', losingToken)).graves, []);
  await f.tick(1);
  const graves = (await f.request('GET', '/api/graveyard', losingToken)).graves;
  assert.equal(graves.length, 1); assert.equal(graves[0].diedAt, f.now);
  assert.equal(graves[0].character.id, view.players[loser].character.id);
  await f.restart();
  assert.deepEqual((await f.request('GET', '/api/graveyard', losingToken)).graves, graves);
});

test('rejected or spare verdicts do not create graves, and failed persistence rolls back the entire death', async t => {
  const f = await fixture(t), pair = await f.pair(), mercy = await f.roomMercy(pair);
  await assert.rejects(f.request('POST', `/api/rooms/${mercy.code}/mercy`, pair.two.token,
    command(mercy, 'loser-cannot-kill', { decision: 'execute' })), apiError(403));
  assert.deepEqual((await f.request('GET', '/api/graveyard', pair.two.token)).graves, []);
  const accepted = command(mercy, 'save-verdict-atomically', { decision: 'execute' });
  f.fail(true);
  await assert.rejects(f.request('POST', `/api/rooms/${mercy.code}/mercy`, pair.one.token, accepted), /Synthetic write failure/);
  f.fail(false);
  assert.equal((await f.request('GET', '/api/session', pair.two.token)).alive, true);
  assert.deepEqual((await f.request('GET', '/api/graveyard', pair.two.token)).graves, []);
  await f.request('POST', `/api/rooms/${mercy.code}/mercy`, pair.one.token, accepted);
  assert.equal((await f.request('GET', '/api/graveyard', pair.two.token)).graves.length, 1);
  const spared = await f.pair(), sparedMercy = await f.roomMercy(spared);
  await f.request('POST', `/api/rooms/${sparedMercy.code}/mercy`, spared.one.token,
    command(sparedMercy, 'show-mercy', { decision: 'spare' }));
  assert.deepEqual((await f.request('GET', '/api/graveyard', spared.two.token)).graves, []);
});

test('temporary menu heartbeats preserve the fighter and graves until expiration, then public records clear', async t => {
  const f = await fixture(t, { temporarySessions: true, disconnectMs: 90000 }), pair = await f.pair();
  const mercy = await f.roomMercy(pair);
  await f.request('POST', `/api/rooms/${mercy.code}/mercy`, pair.one.token, command(mercy, 'temporary-execution', { decision: 'execute' }));
  await f.tick(89999);
  const board = await f.request('GET', '/api/arena/leaderboard', pair.one.token);
  assert.equal(board.sessionMode, 'temporary'); assert.equal(board.fighters.length, 1);
  assert.equal((await f.request('GET', '/api/graveyard', pair.two.token)).graves.length, 1);
  await f.tick(1);
  assert.equal((await f.request('GET', '/api/graveyard', pair.two.token)).graves.length, 1);
  await f.tick(90000);
  assert.deepEqual(await f.request('GET', '/api/arena/leaderboard'), { fighters: [], sessionMode: 'temporary' });
  await assert.rejects(f.request('GET', '/api/graveyard', pair.two.token), apiError(401));
  assert.equal(Object.keys(f.service.data.sessions).length, 0);
});
