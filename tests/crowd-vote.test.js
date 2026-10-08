import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DuelService } from '../online/service.mjs';
import { createAppServer } from '../server.mjs';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b87333', appearance: { sex: 'male', facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut', eyes: 'amber' } });
const gear = { weapon: 'sword', armor: 'medium', helmet: 'none' };
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const apiError = (status, code) => error => { assert.equal(error.status, status); if (code) assert.equal(error.code, code); return true; };

async function fixture(t, options = {}) {
  let now = 1000000, memory = { schema: 1, sessions: {}, rooms: {} }, failing = false, service;
  const store = { async read() { return structuredClone(memory); }, async write(value) {
    if (failing) throw new Error('Synthetic atomic write failure');
    memory = structuredClone(value);
  } };
  const configuration = { store, clock: () => now, disconnectMs: 10000000, ...options };
  service = new DuelService(configuration);
  const guests = [];
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const f = {
    request, guests, get service() { return service; }, get now() { return now; }, get durable() { return structuredClone(memory); },
    fail(value = true) { failing = value; },
    async tick(delta) { now += delta; await service.tick(); },
    async restart(overrides = {}) { await service.close(); Object.assign(configuration, overrides); service = new DuelService(configuration); await service.initialized; },
    async guest() { const guest = await request('POST', '/api/session', undefined, {}); guests.push(guest); return guest; },
    tokenFor(view, slot) {
      const id = service.data.tournaments[view.code].playerIds[slot];
      return guests.find(guest => guest.playerId === id)?.token;
    },
    view(code, slot = 0) { return request('GET', `/api/tournaments/${code}`, this.tokenFor({ code }, slot)); },
    post(view, slot, kind, payload, id = `${kind}-${slot}-${view.revision}`) {
      return request('POST', `/api/tournaments/${view.code}/${kind}`, this.tokenFor(view, slot), command(view, id, payload));
    },
    async lobby(humans = 8) {
      let view;
      for (let index = 0; index < humans; index++) {
        const guest = await this.guest();
        view = await request('POST', index ? '/api/tournaments/join' : '/api/tournaments', guest.token,
          { ...(index ? { code: view.code } : {}), character: character(`Human ${index + 1}`) });
      }
      while (view.players.length < 8) { await this.tick(20000); view = await this.view(view.code); }
      return this.view(view.code);
    },
    async mercy(view, winner = 0) {
      for (let index = 0; index < 2; index++) if (!view.match.ready[index]) {
        view = await this.post(view, view.match.slots[index], 'loadout', { loadout: gear });
      }
      if (view.phase === 'entrance') await this.tick(8000);
      // Finish through the same authoritative forfeit/settlement path as a
      // disconnect, keeping ballot tests independent of weapon balance.
      await service.serialize(() => {
        const tournament = service.data.tournaments[view.code];
        service.forfeit(tournament.match, 1 - winner, now);
        service.tournaments.syncMatch(tournament, now);
        service.touch(tournament);
      });
      return this.view(view.code);
    },
    async open(view) { const gate = view.match.mercyOpensAt; if (gate > now) await this.tick(gate - now); return this.view(view.code); },
    crowd(view) { return this.post(view, view.match.slots[view.match.duel.result.winner], 'mercy', { decision: 'crowd' }); },
    spectators(view) { return view.players.map((_, slot) => slot).filter(slot => !view.match.slots.includes(slot) && !view.players[slot].left && view.players[slot].alive); },
  };
  t.after(() => service.close());
  return f;
}

test('the server reserves the winner reveal then gives the winner a complete twenty-second mercy window', async t => {
  const f = await fixture(t);
  let view = await f.mercy(await f.lobby());
  assert.equal(view.match.rules.winnerMs, 5000);
  assert.equal(view.match.rules.mercyMs, 20000);
  assert.equal(view.match.mercyOpensAt, f.now + 5000);
  assert.equal(view.match.deadline, view.match.mercyOpensAt + 20000);
  assert.equal(view.crowdVote, null);
  await assert.rejects(f.crowd(view), apiError(409, 'verdict_not_open'));
  await f.tick(4999);
  assert.equal((await f.view(view.code)).phase, 'mercy');
  await assert.rejects(f.crowd(view), apiError(409, 'verdict_not_open'));
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.match.deadline - f.now, 20000);
  await f.tick(19999); assert.equal((await f.view(view.code)).phase, 'mercy');
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.phase, 'intermission');
  assert.equal(view.match.decision.decision, 'spare');
  assert.ok(view.match.players.every(player => player.alive));
});

test('six spectators vote on a fresh twenty-second crowd clock; majority execution is final only at the deadline', async t => {
  const f = await fixture(t);
  let view = await f.open(await f.mercy(await f.lobby(), 1));
  const loser = view.match.slots[0], winner = view.match.slots[1], identity = structuredClone(view.players[loser].character);
  view = await f.crowd(view);
  const spectators = f.spectators(view);
  assert.equal(view.phase, 'crowd'); assert.equal(view.match.phase, 'crowd');
  assert.deepEqual(view.crowdVote, { deadline: f.now + 20000, eligibleCount: 6, counts: { spare: 0, execute: 0 }, yourVote: null, canVote: spectators.includes(view.you) });
  assert.deepEqual(view.crowdVote, view.match.crowdVote);
  assert.equal(view.match.decision, null); assert.equal(view.players[loser].alive, true);
  for (const [index, slot] of spectators.entries()) await f.post(view, slot, 'vote', { decision: index < 4 ? 'execute' : 'spare' });
  view = await f.view(view.code, winner);
  assert.deepEqual(view.crowdVote.counts, { spare: 2, execute: 4 });
  assert.equal(view.match.decision, null, 'Even a complete ballot waits for the published deadline');
  assert.equal(view.bracket[0].status, 'active');
  await f.tick(19999); assert.equal((await f.view(view.code)).phase, 'crowd');
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.phase, 'intermission'); assert.equal(view.crowdVote, null);
  assert.deepEqual(view.match.decision, { decision: 'execute', winner: 1, loser: 0 });
  assert.equal(view.players[loser].alive, false); assert.equal(view.bracket[0].winner, winner);
  const session = await f.request('GET', '/api/session', f.tokenFor(view, loser));
  assert.equal(session.alive, false); assert.deepEqual(session.character, identity);
  const wins = view.players[winner].duelWins;
  await f.tick(0); assert.equal((await f.view(view.code)).players[winner].duelWins, wins);
});

test('ties and empty ballots spare the loser; a majority of votes cast needs no invented quorum', async t => {
  for (const ballots of [[], ['spare', 'execute'], ['execute', 'execute', 'spare']]) {
    const f = await fixture(t, { winnerMs: 0 });
    let view = await f.crowd(await f.mercy(await f.lobby()));
    for (const [index, decision] of ballots.entries()) await f.post(view, f.spectators(view)[index], 'vote', { decision });
    await f.tick(20000); view = await f.view(view.code);
    const expected = ballots.length === 3 ? 'execute' : 'spare';
    assert.equal(view.match.decision.decision, expected);
    assert.equal(view.players[view.match.slots[1]].alive, expected !== 'execute');
  }
});

test('ballots authenticate one frozen living spectator, protect private votes, and reject forged or stale commands', async t => {
  const f = await fixture(t, { winnerMs: 0 });
  let view = await f.crowd(await f.mercy(await f.lobby()));
  const [voter, other] = f.spectators(view), outsider = await f.guest();
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/vote`, undefined, command(view, 'no-auth', { decision: 'execute' })), apiError(401));
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/vote`, outsider.token, command(view, 'outsider', { decision: 'execute' })), apiError(403, 'forbidden'));
  for (const slot of view.match.slots) await assert.rejects(f.post(view, slot, 'vote', { decision: 'execute' }), apiError(403, 'spectator'));
  await assert.rejects(f.post(view, voter, 'vote', { decision: 'crowd' }), apiError(400));
  await assert.rejects(f.post(view, voter, 'vote', { decision: 'execute', playerId: outsider.playerId }), apiError(400));
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenFor(view, voter), { commandId: 'old', duelId: 'earlier-match', decision: 'execute' }), apiError(409, 'stale_duel'));
  const body = command(view, 'ballot', { decision: 'execute' });
  await f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenFor(view, voter), body);
  await f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenFor(view, voter), body);
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenFor(view, voter), { ...body, decision: 'spare' }), apiError(409, 'command_conflict'));
  await assert.rejects(f.post(view, voter, 'vote', { decision: 'spare' }, 'second-vote'), apiError(409, 'choice_locked'));
  const own = await f.view(view.code, voter), otherView = await f.view(view.code, other);
  assert.equal(own.crowdVote.yourVote, 'execute'); assert.equal(own.crowdVote.canVote, false);
  assert.equal(otherView.crowdVote.yourVote, null); assert.equal(otherView.crowdVote.canVote, true);
  assert.deepEqual(otherView.crowdVote.counts, { spare: 0, execute: 1 });
  const publicText = JSON.stringify(otherView);
  for (const id of f.service.data.tournaments[view.code].playerIds) assert.equal(publicText.includes(id), false);
  assert.equal(publicText.includes('botVotes'), false); assert.equal(publicText.includes('eligible"'), false);
  await f.tick(20000);
  await assert.rejects(f.post(view, other, 'vote', { decision: 'spare' }), apiError(409, 'wrong_phase'));
});

test('already retired and withdrawn spectators are excluded when the crowd opens', async t => {
  const f = await fixture(t, { winnerMs: 0 });
  let view = await f.mercy(await f.lobby());
  const retired = view.match.slots[1];
  view = await f.post(view, view.match.slots[0], 'mercy', { decision: 'execute' });
  await f.tick(6000); view = await f.mercy(await f.view(view.code));
  const withdrawn = f.spectators(view).find(slot => slot !== retired);
  await f.post(view, withdrawn, 'leave');
  view = await f.crowd(await f.view(view.code, view.match.slots[0]));
  assert.equal(view.crowdVote.eligibleCount, 4);
  const retiredView = await f.view(view.code, retired);
  assert.equal(retiredView.crowdVote.canVote, false);
  await assert.rejects(f.post(view, retired, 'vote', { decision: 'execute' }), apiError(403, 'spectator'));
  await assert.rejects(f.post(view, withdrawn, 'vote', { decision: 'execute' }), apiError(403, 'forbidden'));
});

test('an accepted vote survives departure; a later departure cannot acquire or alter a ballot', async t => {
  const f = await fixture(t, { winnerMs: 0 });
  let view = await f.crowd(await f.mercy(await f.lobby()));
  const [voter, leaving] = f.spectators(view);
  await f.post(view, voter, 'vote', { decision: 'execute' });
  await f.post(view, voter, 'leave'); await f.post(view, leaving, 'leave');
  const active = await f.view(view.code, view.match.slots[0]);
  assert.equal(active.crowdVote.eligibleCount, 6, 'Published eligibility is frozen for this match ballot');
  assert.deepEqual(active.crowdVote.counts, { spare: 0, execute: 1 });
  await assert.rejects(f.post(view, leaving, 'vote', { decision: 'spare' }), apiError(403, 'forbidden'));
});

test('both duelists leaving a delegated crowd cannot cancel its verdict or reuse the pending loser', async t => {
  const f = await fixture(t, { winnerMs: 0 });
  let view = await f.crowd(await f.mercy(await f.lobby()));
  const [winner, loser] = view.match.slots, spectator = f.spectators(view)[0];
  await f.post(view, spectator, 'vote', { decision: 'execute' });
  await f.post(view, winner, 'leave'); await f.post(view, loser, 'leave');
  view = await f.view(view.code, spectator);
  assert.equal(view.phase, 'crowd'); assert.equal(view.match.decision, null);
  const pending = await f.request('GET', '/api/session', f.tokenFor(view, loser));
  assert.equal(pending.pendingMercyTournament, view.code);
  assert.equal(pending.pendingMercyTournamentDeadline, view.match.deadline);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.tokenFor(view, loser), { character: pending.character }), apiError(409, 'pending_mercy'));
  await f.tick(20000); view = await f.view(view.code, spectator);
  assert.equal(view.match.decision.decision, 'execute'); assert.equal(view.players[loser].alive, false);
  const final = await f.request('GET', '/api/session', f.tokenFor(view, loser));
  assert.equal(final.pendingMercyTournament, null); assert.equal(final.alive, false);
  await assert.rejects(f.request('POST', '/api/tournaments/enter', f.tokenFor(view, loser), { character: pending.character }), apiError(409, 'character_dead'));
});

test('crowd votes and reveal deadlines persist without extension and atomic write failures leave no partial ballot', async t => {
  const f = await fixture(t);
  let view = await f.mercy(await f.lobby());
  const open = view.match.mercyOpensAt, deadline = view.match.deadline;
  await f.tick(1000); await f.restart(); view = await f.view(view.code);
  assert.equal(view.match.mercyOpensAt, open); assert.equal(view.match.deadline, deadline);
  view = await f.crowd(await f.open(view));
  const voter = f.spectators(view)[0], body = command(view, 'durable-ballot', { decision: 'execute' });
  const before = f.durable;
  f.fail();
  await assert.rejects(f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenFor(view, voter), body), /Synthetic atomic write failure/);
  assert.deepEqual(f.durable, before);
  assert.deepEqual(f.service.data.tournaments[view.code].match.crowdVote.votes, {});
  f.fail(false);
  await f.request('POST', `/api/tournaments/${view.code}/vote`, f.tokenFor(view, voter), body);
  await f.tick(12000); await f.restart();
  const resumed = await f.view(view.code, voter);
  assert.equal(resumed.crowdVote.deadline, view.crowdVote.deadline);
  assert.equal(resumed.crowdVote.yourVote, 'execute');
  await f.tick(7999); assert.equal((await f.view(view.code)).phase, 'crowd');
  f.fail();
  await assert.rejects(f.tick(1), /Synthetic atomic write failure/);
  assert.equal(f.service.data.tournaments[view.code].phase, 'crowd');
  assert.equal(f.service.data.tournaments[view.code].players[view.match.slots[1]].alive, true);
  f.fail(false); await f.tick(0);
  assert.equal((await f.view(view.code)).match.decision.decision, 'execute');
});

test('legacy two-player crowd has no voters and spares at its own deadline; leaving cannot resurrect the pending loser', async t => {
  const f = await fixture(t, { winnerMs: 0 }), [one, two] = [await f.guest(), await f.guest()];
  const waiting = await f.request('POST', '/api/rooms', one.token, { character: character('Cassian') });
  let view = await f.request('POST', '/api/rooms/join', two.token, { code: waiting.code, character: character('Mira') });
  for (const [index, guest] of [one, two].entries()) view = await f.request('POST', `/api/rooms/${view.code}/loadout`, guest.token, command(view, `gear-${index}`, { loadout: gear }));
  await f.request('POST', `/api/rooms/${view.code}/leave`, two.token, command(view, 'loser-left'));
  view = await f.request('GET', `/api/rooms/${view.code}`, one.token);
  view = await f.request('POST', `/api/rooms/${view.code}/mercy`, one.token, command(view, 'crowd', { decision: 'crowd' }));
  assert.equal(view.crowdVote.eligibleCount, 0); assert.equal(view.crowdVote.canVote, false);
  await assert.rejects(f.request('POST', `/api/rooms/${view.code}/vote`, one.token, command(view, 'vote', { decision: 'execute' })), apiError(403, 'spectator'));
  await assert.rejects(f.request('POST', '/api/rooms', two.token, { character: character('Replacement') }), apiError(409, 'pending_mercy'));
  await f.tick(19999); assert.equal((await f.request('GET', `/api/rooms/${view.code}`, one.token)).phase, 'crowd');
  await f.tick(1); view = await f.request('GET', `/api/rooms/${view.code}`, one.token);
  assert.equal(view.decision.decision, 'spare'); assert.equal(view.players[1].alive, true);
  assert.equal((await f.request('GET', '/api/session', two.token)).pendingMercyRoom, null);
});

test('restoring old longer mercy or crowd clocks caps only their remainder and never extends shorter deadlines', async t => {
  const f = await fixture(t, { winnerMs: 0, mercyMs: 60000, crowdMs: 60000 });
  let view = await f.mercy(await f.lobby());
  await f.tick(1000); await f.restart({ mercyMs: 20000, crowdMs: 20000 }); view = await f.view(view.code);
  assert.equal(view.match.deadline, f.now + 20000);
  view = await f.crowd(view);
  await f.tick(10000); const remaining = view.match.deadline;
  await f.restart(); assert.equal((await f.view(view.code)).match.deadline, remaining);
  const old = await fixture(t, { winnerMs: 0, crowdMs: 60000 });
  let long = await old.crowd(await old.mercy(await old.lobby()));
  await old.tick(1000); await old.restart({ crowdMs: 20000 }); long = await old.view(long.code);
  assert.equal(long.match.deadline, old.now + 20000);
  assert.equal(long.crowdVote.deadline, long.match.deadline);
  await old.tick(10000); const shortDeadline = long.match.deadline;
  await old.restart(); assert.equal((await old.view(long.code)).match.deadline, shortDeadline);
});

test('older mercy snapshots without a reveal gate gain no new delay or extension during migration', async t => {
  for (const remaining of [14000, 60000]) {
    const f = await fixture(t, { winnerMs: 0, mercyMs: remaining });
    let view = await f.mercy(await f.lobby());
    await f.service.serialize(() => {
      const tournament = f.service.data.tournaments[view.code];
      delete tournament.match.mercyOpensAt;
      f.service.touch(tournament);
    });
    await f.restart({ winnerMs: 5000, mercyMs: 20000 }); view = await f.view(view.code);
    assert.equal(view.match.mercyOpensAt, f.now);
    assert.equal(view.match.deadline, f.now + Math.min(remaining, 20000));
    const restored = f.durable.tournaments[view.code].match;
    assert.equal(restored.mercyOpensAt, view.match.mercyOpensAt); assert.equal(restored.deadline, view.match.deadline);
    assert.equal((await f.crowd(view)).phase, 'crowd', 'An old already-open verdict remains selectable immediately');
  }
});

test('real bot spectators cast one paced persisted server vote each without exposing their private choices', async t => {
  const f = await fixture(t);
  let view = await f.lobby(2), visited = 0;
  while (view.match.players.every(player => player.bot === true)) {
    assert.ok(++visited < 4, 'One of the four quarterfinals must contain a human');
    while (!['intermission', 'complete'].includes(view.phase)) {
      await f.tick(view.phase === 'entrance' ? 8000 : view.phase === 'mercy' ? 5000 : 3000);
      view = await f.view(view.code);
    }
    await f.tick(6000); view = await f.view(view.code);
  }
  const winner = view.match.players.findIndex(player => player.bot !== true);
  view = await f.crowd(await f.open(await f.mercy(view, winner)));
  const ballot = structuredClone(f.service.data.tournaments[view.code].match.crowdVote);
  const schedules = Object.entries(ballot.botVotes);
  assert.ok(schedules.length >= 4);
  assert.equal(view.crowdVote.eligibleCount, 6);
  assert.deepEqual(view.crowdVote.counts, { spare: 0, execute: 0 });
  assert.equal(JSON.stringify(view).includes('botVotes'), false);
  for (const [id, scheduled] of schedules) {
    assert.ok(ballot.eligible.includes(id));
    assert.ok(['spare', 'execute'].includes(scheduled.decision));
    assert.ok(scheduled.at >= f.now + 3000 && scheduled.at <= f.now + 15000);
    assert.equal(f.service.sessionForPlayer(id), undefined, 'Bots have no authenticated vote impersonation path');
  }
  const first = Math.min(...schedules.map(([, scheduled]) => scheduled.at));
  await f.tick(first - f.now - 1);
  assert.deepEqual((await f.view(view.code)).crowdVote.counts, { spare: 0, execute: 0 });
  const before = f.durable;
  f.fail(); await assert.rejects(f.tick(1), /Synthetic atomic write failure/);
  assert.deepEqual(f.durable, before); assert.deepEqual(f.service.data.tournaments[view.code].match.crowdVote.votes, {});
  f.fail(false); await f.tick(0); view = await f.view(view.code);
  assert.ok(view.crowdVote.counts.spare + view.crowdVote.counts.execute >= 1);
  await f.restart();
  assert.deepEqual(f.service.data.tournaments[view.code].match.crowdVote.botVotes, ballot.botVotes);
  await f.tick(view.match.deadline - f.now - 1); view = await f.view(view.code);
  const expected = { spare: 0, execute: 0 };
  for (const [, scheduled] of schedules) expected[scheduled.decision]++;
  assert.deepEqual(view.crowdVote.counts, expected);
  await f.tick(0); assert.deepEqual((await f.view(view.code)).crowdVote.counts, expected);
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.match.decision.decision, expected.execute > expected.spare ? 'execute' : 'spare');
});

test('a bot winner preserves the authoritative winner reveal before automatic mercy', async t => {
  const f = await fixture(t);
  let view = await f.lobby(1);
  const botWinner = view.match.players.findIndex(player => player.bot === true);
  view = await f.mercy(view, botWinner);
  assert.equal(view.phase, 'mercy'); assert.equal(view.match.decision, null);
  await f.tick(4999); assert.equal((await f.view(view.code)).phase, 'mercy');
  await f.tick(1); view = await f.view(view.code);
  assert.equal(view.phase, 'intermission'); assert.equal(view.match.decision.decision, 'spare');
});

test('HTTP crowd voting uses the existing authenticated origin-checked server endpoint', async t => {
  const f = await fixture(t, { winnerMs: 0 });
  let view = await f.crowd(await f.mercy(await f.lobby()));
  const server = createAppServer({ store: { async read() { return f.durable; }, async write() {} },
    clock: () => f.now, winnerMs: 0, disconnectMs: 10000000, tickMs: 100000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.duels.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const token = f.tokenFor(view, f.spectators(view)[0]), body = command(view, 'http-vote', { decision: 'execute' });
  const send = (authorization, origin = url) => fetch(`${url}/api/tournaments/${view.code}/vote`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await send(undefined)).status, 401);
  assert.equal((await send(token, 'http://foreign.invalid')).status, 403);
  const response = await send(token); assert.equal(response.status, 200);
  view = await response.json(); assert.equal(view.crowdVote.yourVote, 'execute'); assert.equal(view.crowdVote.canVote, false);
  assert.deepEqual(view.crowdVote.counts, { spare: 0, execute: 1 });
});
