import test from 'node:test';
import assert from 'node:assert/strict';
import { DuelService, ROUND_PRESENTATION_MS } from '../online/service.mjs';
import { MemoryStore } from '../online/store.mjs';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
const gear = { weapon: 'sword', armor: 'medium', helmet: 'none' };
const error = code => actual => actual.status === 409 && actual.code === code;

async function fixture(t, mode, options = {}) {
  let now = 1000000, service;
  const store = new MemoryStore(), config = { store, clock: () => now, disconnectMs: 10000000, ...options };
  service = new DuelService(config); await service.initialized;
  t.after(() => service.close());
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const base = mode === 'tournament' ? '/api/tournaments' : '/api/rooms';
  const guests = []; let view;
  for (let index = 0; index < (mode === 'tournament' ? 8 : 2); index++) {
    const guest = await request('POST', '/api/session', null, {}); guests.push(guest);
    view = await request('POST', index ? `${base}/join` : base, guest.token,
      { ...(index ? { code: view.code } : {}), character: character(`Fighter ${index + 1}`) });
  }
  const slots = mode === 'tournament' ? view.match.slots : [0, 1];
  const tokens = slots.map(slot => guests[slot].token);
  const matchOf = view => view.match ?? view;
  const f = { get service() { return service; }, get now() { return now; }, guests, tokens,
    match: matchOf, read: () => request('GET', `${base}/${view.code}`, tokens[0]),
    async tick(delta) { now += delta; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(config); await service.initialized; },
    post(view, index, action, payload = {}, id = `${action}-${matchOf(view).duel?.round ?? 0}-${index}`) {
      return request('POST', `${base}/${view.code}/${action}`, tokens[index], { commandId: id, duelId: view.duelId, ...payload });
    },
  };
  await f.post(view, 0, 'loadout', { loadout: gear });
  view = await f.post(view, 1, 'loadout', { loadout: gear });
  if (mode === 'tournament') { await f.tick(8000); view = await f.read(); }
  f.initial = view;
  return f;
}

for (const mode of ['room', 'tournament']) {
  test(`${mode}: a resolved round reserves presentation before a full server choice window, including restart and exact boundary retries`, async t => {
    const f = await fixture(t, mode); let view = f.initial, match = f.match(view);
    assert.equal(match.actionOpensAt, f.now); assert.equal(match.deadline - match.actionOpensAt, 20000);
    await f.post(view, 0, 'action', { round: 1, action: 'recover' });
    view = await f.post(view, 1, 'action', { round: 1, action: 'guard' }); match = f.match(view);
    const state = structuredClone(match.duel), deadline = match.deadline, opensAt = match.actionOpensAt;
    assert.equal(opensAt, f.now + ROUND_PRESENTATION_MS); assert.equal(match.presentationEndsAt, opensAt);
    assert.equal(deadline, opensAt + 20000);
    await assert.rejects(f.post(view, 0, 'action', { round: 2, action: 'strike' }, 'after-playback'), error('actions_not_open'));
    await f.tick(3999); await f.restart();
    match = f.match(await f.read());
    assert.deepEqual(match.duel, state); assert.deepEqual(match.pending, [false, false]);
    assert.equal(match.actionOpensAt, opensAt); assert.equal(match.deadline, deadline);
    await assert.rejects(f.post(view, 0, 'action', { round: 2, action: 'strike' }, 'after-playback'), error('actions_not_open'));
    await f.tick(1);
    view = await f.post(view, 0, 'action', { round: 2, action: 'strike' }, 'after-playback');
    assert.equal(f.match(view).deadline - f.now, 20000); assert.deepEqual(f.match(view).pending, [true, false]);
    await f.tick(19999); assert.equal(f.match(await f.read()).duel.round, 2);
    await f.tick(1); match = f.match(await f.read());
    assert.equal(match.duel.round, 3); assert.deepEqual(match.duel.lastRound.actions, ['strike', 'recover']);
    assert.equal(match.actionOpensAt, f.now + 4000); assert.equal(match.deadline - match.actionOpensAt, 20000);
    await f.tick(0); assert.equal(f.match(await f.read()).duel.round, 3);
  });

  test(`${mode}: a knockout keeps battle playback, winner reveal and mercy as distinct complete intervals`, async t => {
    const f = await fixture(t, mode);
    // Place one fighter at the lethal boundary, then resolve a real legal round.
    await f.service.serialize(() => {
      const room = mode === 'tournament' ? f.service.data.tournaments[f.initial.code].match : f.service.data.rooms[f.initial.code];
      room.duel = structuredClone(room.duel);
      room.duel.fighters[1].hp = 1; f.service.changed = true;
    });
    let view = await f.read();
    await f.post(view, 0, 'action', { round: 1, action: 'strike' });
    view = await f.post(view, 1, 'action', { round: 1, action: 'recover' });
    const match = f.match(view), originalDeadline = match.deadline;
    assert.equal(match.phase, 'mercy'); assert.equal(match.duel.result.winner, 0);
    assert.equal(match.presentationEndsAt, f.now + 4000);
    assert.equal(match.mercyOpensAt, f.now + 4000 + 5000);
    assert.equal(match.deadline, match.mercyOpensAt + 20000);
    await assert.rejects(f.post(view, 0, 'mercy', { decision: 'execute' }, 'verdict-after-reveal'), error('verdict_not_open'));
    await f.tick(4000); await f.restart();
    assert.equal(f.match(await f.read()).deadline, originalDeadline);
    await f.tick(4999);
    await assert.rejects(f.post(view, 0, 'mercy', { decision: 'execute' }, 'verdict-after-reveal'), error('verdict_not_open'));
    await f.tick(1);
    view = await f.post(view, 0, 'mercy', { decision: 'execute' }, 'verdict-after-reveal');
    assert.equal(f.match(view).decision.decision, 'execute'); assert.equal(f.match(view).players[1].alive, false);
    const replay = await f.post(view, 0, 'mercy', { decision: 'execute' }, 'verdict-after-reveal');
    assert.equal(f.match(replay).players[0].duelWins, 1);
  });

  test(`${mode}: disconnect expiry during playback still forfeits once without adding an unrelated round playback interval`, async t => {
    const f = await fixture(t, mode, { disconnectMs: 10000 });
    let view = f.initial;
    await f.post(view, 0, 'action', { round: 1, action: 'guard' });
    view = await f.post(view, 1, 'action', { round: 1, action: 'recover' });
    // Reach the absent opponent's grace boundary while the other fighter is present.
    await f.service.request({ method: 'GET', path: '/api/session', token: f.tokens[0] });
    const opponentId = f.service.session(f.tokens[1]).playerId;
    f.service.lastSeen.set(opponentId, f.now - 10000);
    await f.tick(0); view = await f.read();
    assert.equal(f.match(view).duel.result.reason, 'forfeit'); assert.equal(f.match(view).duel.result.winner, 0);
    assert.equal(f.match(view).presentationEndsAt, f.now);
    assert.equal(f.match(view).mercyOpensAt, f.now + 5000);
    assert.equal(f.match(view).players[0].duelWins, 1);
    await f.tick(0); assert.equal(f.match(await f.read()).players[0].duelWins, 1);
  });
}
