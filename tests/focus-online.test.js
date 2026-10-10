import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { DuelService } from '../online/service.mjs';
import { MemoryStore } from '../online/store.mjs';
import { createDuel as createCurrentDuel, getActionOptions, getFighterStatuses, resolveRound } from '../src/combat.js';
import { createAppServer } from '../server.mjs';

const character = (name, stats = { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }) => ({ name, stats,
  trait: 'balanced', appearance: { sex: 'male', facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' } });
const gear = { weapon: 'sword', armor: 'medium', helmet: 'none' };
const createDuel = (entries, options = {}) => createCurrentDuel(entries, { version: 4, ...options });
const apiError = (status, code) => error => error.status === status && (!code || error.code === code);
const matchOf = view => view.match ?? view;
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });

async function fixture(t, tournament = false, options = {}) {
  let now = 1000000, service, failWrites = false;
  const store = new MemoryStore(), originalWrite = store.write.bind(store);
  store.write = async value => { if (failWrites) throw new Error('Synthetic write failure'); await originalWrite(value); };
  const config = { store, clock: () => now, winnerMs: 0, disconnectMs: 10000000, ...options };
  service = new DuelService(config); await service.initialized;
  t.after(() => service.close());
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const base = `/api/${tournament ? 'tournaments' : 'rooms'}`;
  const guests = []; let initial;
  for (let index = 0; index < (tournament ? 8 : 2); index++) {
    const guest = await request('POST', '/api/session', null, {}); guests.push(guest);
    initial = await request('POST', index ? `${base}/join` : base, guest.token,
      { ...(index ? { code: initial.code } : {}), character: character(`Fighter ${index + 1}`) });
  }
  const slots = tournament ? initial.match.slots : [0, 1], tokens = slots.map(slot => guests[slot].token);
  const f = { initial, slots, tokens, guests, base, request, store, get service() { return service; }, get now() { return now; },
    fail(value) { failWrites = value; },
    record() { return tournament ? service.data.tournaments[initial.code].match : service.data.rooms[initial.code]; },
    read(index = 0) { return request('GET', `${base}/${initial.code}`, tokens[index]); },
    observe() { return tournament ? request('GET', `/api/arena/tournaments/${initial.code}`) : this.read(1); },
    post(view, index, kind, payload, id = `${kind}-${matchOf(view).duel?.round ?? 0}-${index}`) {
      return request('POST', `${base}/${initial.code}/${kind}`, tokens[index], command(view, id, payload));
    },
    async tickTo(at) { now = Math.max(now, at); await service.tick(); },
    async restart() { await service.close(); service = new DuelService(config); await service.initialized; },
    async edit(edit) {
      await service.serialize(() => {
        const room = this.record(); room.duel = structuredClone(room.duel); edit(room);
        service.touch(tournament ? service.data.tournaments[initial.code] : room);
      });
    },
  };
  await f.post(initial, 0, 'loadout', { loadout: gear });
  let view = await f.post(initial, 1, 'loadout', { loadout: gear });
  if (tournament) { await f.tickTo(matchOf(view).deadline); view = await f.read(); }
  // Protect the already-active v4 service path, including acknowledged choices and restarts.
  await service.serialize(() => {
    const record = f.record();
    record.duel = createDuel(record.players.map((player, index) => ({ character: player.character, ...record.loadouts[index] })));
    service.touch(tournament ? service.data.tournaments[initial.code] : record);
  });
  view = await f.read();
  f.initial = view;
  return f;
}

for (const tournament of [false, true]) {
  const label = tournament ? 'tournament' : 'quick duel';

  test(`${label}: Focus remains private until reveal, then its bounded bonus and one regeneration serialize and retry exactly`, async t => {
    const f = await fixture(t, tournament), initial = f.initial, before = matchOf(initial).duel;
    assert.equal(before.version, 4);
    const identities = structuredClone(matchOf(initial).players.map(player => player.character));
    const chosen = command(initial, 'private-focus', { round: 1, action: 'focus' });
    const path = `${f.base}/${initial.code}/action`;
    await f.request('POST', path, f.tokens[0], chosen);
    const pending = matchOf(await f.observe());
    assert.deepEqual(pending.duel, before); assert.deepEqual(pending.pending, [true, false]);
    assert.equal(Object.hasOwn(pending, 'actions'), false); assert.deepEqual(getFighterStatuses(pending.duel, 0), []);
    await f.restart();
    assert.equal(f.record().actions[0], 'focus'); assert.deepEqual(matchOf(await f.observe()).duel, before);
    const result = await f.post(initial, 1, 'action', { round: 1, action: 'strike' }, 'resolve-private-focus');
    const after = matchOf(result).duel;
    assert.deepEqual(after, resolveRound(before, ['focus', 'strike']));
    const status = getFighterStatuses(after, 0).find(status => status.id === 'focused');
    assert.deepEqual(status, { id: 'focused', label: 'Focused', damageBonus: 3, expiresAfterRound: 2 });
    assert.equal(after.lastRound.events.filter(event => event.type === 'focus').length, 1);
    assert.equal(after.lastRound.events.filter(event => event.type === 'stamina-regeneration').length, 2);
    const retries = await Promise.all([f.request('POST', path, f.tokens[0], chosen), f.request('POST', path, f.tokens[0], chosen)]);
    for (const retry of retries) assert.deepEqual(matchOf(retry).duel, after);
    await assert.rejects(f.request('POST', path, f.tokens[0], { ...chosen, action: 'strike' }), apiError(409, 'command_conflict'));
    await f.tickTo(matchOf(result).actionOpensAt);
    const strike = getActionOptions(after, 0).find(option => option.id === 'strike');
    assert.equal(strike.focusDamageBonus, 3);
    await f.post(result, 0, 'action', { round: 2, action: 'strike' }, 'boosted-strike');
    const next = await f.post(result, 1, 'action', { round: 2, action: 'guard' }, 'guard-boost');
    assert.equal(matchOf(next).duel.lastRound.events.find(event => event.type === 'attack').damage, strike.guardedDamage);
    assert.equal(getFighterStatuses(matchOf(next).duel, 0).some(status => status.id === 'focused'), false);
    assert.deepEqual(matchOf(next).players.map(player => player.character), identities);
  });

  test(`${label}: a timeout defaults to Focus and restores each Dexterity tier only after the resolved round`, async t => {
    const f = await fixture(t, tournament), initial = f.initial;
    await f.edit(room => {
      room.duel = structuredClone(createDuel([
        { character: character('High Dexterity', { strength: 4, dexterity: 8, speed: 4, defense: 2, intelligence: 2 }), ...gear },
        { character: character('Low Dexterity', { strength: 6, dexterity: 0, speed: 6, defense: 4, intelligence: 4 }), ...gear },
      ]));
      room.duel.fighters.forEach(fighter => { fighter.stamina = 0; });
    });
    const before = matchOf(await f.read()).duel;
    assert.deepEqual(before.fighters.map(fighter => fighter.staminaRegen), [3, 2]);
    await f.tickTo(matchOf(initial).deadline - 1);
    assert.deepEqual(matchOf(await f.read()).duel.fighters.map(fighter => fighter.stamina), [0, 0]);
    await f.tickTo(matchOf(initial).deadline);
    const after = matchOf(await f.read()).duel;
    assert.deepEqual(after.lastRound.actions, ['focus', 'focus']);
    assert.deepEqual(after.fighters.map(fighter => fighter.stamina), [3, 2]);
    assert.deepEqual(after.lastRound.events.filter(event => event.type === 'stamina-regeneration').map(event => event.restored).sort(), [2, 3]);
    const resolved = structuredClone(after); await f.tickTo(f.now); await f.restart();
    assert.deepEqual(matchOf(await f.read()).duel, resolved, 'Polling and restart never grant extra regeneration or Focus.');
  });

  test(`${label}: new duels reject Recover, forged Focus fields and unaffordable attacks while zero-cost Focus remains legal`, async t => {
    const f = await fixture(t, tournament), initial = f.initial;
    await f.edit(room => { room.duel.fighters[0].stamina = 0; });
    let view = await f.read();
    await assert.rejects(f.post(view, 0, 'action', { round: 1, action: 'recover' }, 'old-client-recover'), apiError(400));
    await assert.rejects(f.post(view, 0, 'action', { round: 1, action: 'focus', damageBonus: 100 }, 'forged-focus'), apiError(400));
    await assert.rejects(f.post(view, 0, 'action', { round: 1, action: 'strike' }, 'empty-strike'), error => apiError(409, 'unaffordable')(error) && /Choose Focus/.test(error.message));
    assert.deepEqual(matchOf(await f.read()).pending, [false, false]);
    view = await f.post(view, 0, 'action', { round: 1, action: 'focus' }, 'legal-focus');
    assert.deepEqual(matchOf(view).pending, [true, false]);
    assert.equal(matchOf(view).duel.fighters[0].stamina, 0);
  });

  test(`${label}: a failed round write rolls back both Focus and regeneration before the same exact command succeeds`, async t => {
    const f = await fixture(t, tournament), initial = f.initial;
    await f.edit(room => { room.duel.fighters.forEach(fighter => { fighter.stamina = 0; }); });
    let view = await f.read();
    await f.post(view, 0, 'action', { round: 1, action: 'focus' }, 'first-focus');
    const before = structuredClone(f.record()); f.fail(true);
    await assert.rejects(f.post(view, 1, 'action', { round: 1, action: 'focus' }, 'second-focus'), /Synthetic write failure/);
    assert.deepEqual(f.record(), before);
    f.fail(false); view = await f.post(view, 1, 'action', { round: 1, action: 'focus' }, 'second-focus');
    assert.deepEqual(matchOf(view).duel.fighters.map(fighter => fighter.stamina), [2, 2]);
    const after = structuredClone(matchOf(view).duel);
    assert.deepEqual(matchOf(await f.post(view, 1, 'action', { round: 1, action: 'focus' }, 'second-focus')).duel, after);
  });

  test(`${label}: Speed discounts the server-owned attack cost before trait costs, and retries never repeat payment or regeneration`, async t => {
    const f = await fixture(t, tournament);
    await f.edit(room => {
      const fast = character('Fast Berserker', { strength: 4, dexterity: 4, speed: 8, defense: 4, intelligence: 0 });
      const slow = character('Slow Berserker', { strength: 4, dexterity: 4, speed: 0, defense: 8, intelligence: 4 });
      fast.trait = slow.trait = 'berserker';
      room.duel = structuredClone(createDuel([fast, slow].map(character => ({ character, weapon: 'greatsword', armor: 'heavy' }))));
      room.duel.fighters[0].stamina = 8; room.duel.fighters[1].stamina = 10;
    });
    let view = await f.read(); const before = matchOf(view).duel;
    assert.deepEqual(before.fighters.map(fighter => [fighter.strikeCost, fighter.techniqueCost, fighter.staminaRegen]), [[5, 8, 2], [7, 10, 2]]);
    await assert.rejects(f.post(view, 0, 'action', { round: 1, action: 'technique', speedDiscount: 100 }, 'forged-discount'), apiError(400));
    const paid = command(view, 'fast-paid-technique', { round: 1, action: 'technique' });
    const path = `${f.base}/${view.code}/action`;
    await f.request('POST', path, f.tokens[0], paid);
    assert.deepEqual(matchOf(await f.observe()).duel, before, 'Payment and regeneration wait until both choices resolve.');
    view = await f.post(view, 1, 'action', { round: 1, action: 'technique' }, 'slow-paid-technique');
    const after = matchOf(view).duel;
    assert.deepEqual(after.fighters.map(fighter => fighter.stamina), [2, 2]);
    assert.deepEqual(after.lastRound.events.filter(event => event.type === 'stamina-regeneration').map(event => event.restored), [2, 2]);
    await f.restart();
    assert.deepEqual(matchOf(await f.request('POST', path, f.tokens[0], paid)).duel, after);
    assert.deepEqual(matchOf(await f.read()).duel, after);
  });

  test(`${label}: acknowledged legacy Recover choices, receipts, identities and deadlines survive restart and keep their original resolution`, async t => {
    const f = await fixture(t, tournament), initial = f.initial;
    await f.edit(room => {
      room.duel = structuredClone(createDuel(room.players.map(player => ({ character: player.character, ...gear })), { version: 3 }));
      room.duel.fighters[0].stamina = 0;
    });
    let view = await f.read();
    const before = structuredClone(matchOf(view).duel), identities = structuredClone(matchOf(view).players.map(player => player.character));
    assert.equal(before.version, 3); assert.equal(Object.hasOwn(before.fighters[0], 'staminaRegen'), false);
    assert.deepEqual(before.fighters.map(fighter => [fighter.strikeCost, fighter.techniqueCost]), [[3, 4], [3, 4]], 'Legacy Speed still has no attack-cost discount.');
    const chosen = command(view, 'acknowledged-recover', { round: 1, action: 'recover' });
    const path = `${f.base}/${view.code}/action`;
    await f.request('POST', path, f.tokens[0], chosen);
    const committed = structuredClone(f.record()), durable = await f.store.read();
    await f.restart(); assert.deepEqual(f.record(), committed); assert.deepEqual(await f.store.read(), durable);
    view = await f.request('POST', path, f.tokens[0], chosen);
    assert.deepEqual(matchOf(view).pending, [true, false]); assert.deepEqual(f.record().commands ?? f.service.data.tournaments[view.code].commands,
      committed.commands ?? durable.tournaments[view.code].commands);
    await assert.rejects(f.post(view, 1, 'action', { round: 1, action: 'focus' }, 'legacy-focus'), apiError(400));
    view = await f.post(view, 1, 'action', { round: 1, action: 'strike' }, 'legacy-strike');
    const after = matchOf(view).duel;
    assert.deepEqual(after, resolveRound(before, ['recover', 'strike']));
    assert.deepEqual(after.lastRound.actions, ['recover', 'strike']);
    assert.equal(after.lastRound.events.some(event => ['focus', 'stamina-regeneration'].includes(event.type)), false);
    assert.deepEqual(matchOf(view).players.map(player => player.character), identities);
    await f.tickTo(matchOf(view).deadline);
    view = await f.read(); assert.deepEqual(matchOf(view).duel.lastRound.actions, ['recover', 'recover']);
    assert.equal(matchOf(view).duel.version, 3);
    const nextGuest = await f.request('POST', '/api/session', null, {});
    const fresh = await f.request('POST', '/api/rooms', nextGuest.token, { character: character('New fighter') });
    assert.equal(fresh.phase, 'waiting');
    const nextRival = await f.request('POST', '/api/session', null, {});
    let newBattle = await f.request('POST', '/api/rooms/join', nextRival.token, { code: fresh.code, character: character('New rival') });
    for (const [index, guest] of [nextGuest, nextRival].entries()) newBattle = await f.request('POST', `/api/rooms/${fresh.code}/loadout`, guest.token,
      command(newBattle, `fresh-gear-${index}`, { loadout: gear }));
    assert.equal(newBattle.duel.version, 5);
    assert.deepEqual(getActionOptions(newBattle.duel, 0).map(option => option.id), ['strike', 'technique', 'guard', 'focus']);
    assert.deepEqual(newBattle.duel.fighters.map(fighter => [fighter.strikeCost, fighter.techniqueCost]), [[3, 4], [3, 4]], 'New v5 duels use choice timing and no saved Speed cost discount.');
    // Both versions coexist; no old fighter profile or resolved verdict is rebuilt.
    assert.deepEqual(matchOf(await f.read()).players.map(player => player.character), identities);
  });

  test(`${label}: restarting a legacy verdict preserves its ballot, winner record and exact idempotent decision`, async t => {
    const f = await fixture(t, tournament), initial = f.initial;
    await f.edit(room => {
      room.duel = structuredClone(createDuel(room.players.map(player => ({ character: player.character, ...gear })), { version: 3 }));
      room.duel.fighters[1].hp = 1;
    });
    let view = await f.read(); const identities = structuredClone(matchOf(view).players.map(player => player.character));
    await f.post(view, 0, 'action', { round: 1, action: 'strike' }, 'legacy-winning-strike');
    view = await f.post(view, 1, 'action', { round: 1, action: 'recover' }, 'legacy-last-recover');
    assert.equal(matchOf(view).phase, 'mercy'); assert.equal(matchOf(view).duel.version, 3);
    const mercy = structuredClone(f.record()); await f.restart(); assert.deepEqual(f.record(), mercy);
    await f.tickTo(matchOf(view).mercyOpensAt);
    const ballotCommand = command(view, 'legacy-verdict-crowd', { decision: 'crowd' });
    view = await f.request('POST', `${f.base}/${view.code}/mercy`, f.tokens[0], ballotCommand);
    const ballot = structuredClone(f.record()); await f.restart(); assert.deepEqual(f.record(), ballot);
    assert.deepEqual(matchOf(await f.request('POST', `${f.base}/${view.code}/mercy`, f.tokens[0], ballotCommand)).crowdVote,
      matchOf(view).crowdVote);
    await f.tickTo(matchOf(view).deadline); view = await f.read();
    assert.equal(matchOf(view).decision.decision, 'spare'); assert.equal(matchOf(view).players[0].duelWins, 1);
    assert.equal(matchOf(view).players[1].alive, true); assert.deepEqual(matchOf(view).players.map(player => player.character), identities);
    const completed = structuredClone(f.record()); await f.restart(); assert.deepEqual(f.record(), completed);
    const replay = await f.request('POST', `${f.base}/${view.code}/mercy`, f.tokens[0], ballotCommand);
    assert.equal(matchOf(replay).players[0].duelWins, 1); assert.equal(matchOf(replay).duel.version, 3);
  });
}

test('HTTP Focus sends carry only an intention; public observer reads gain no seat, pending effect or forged regeneration authority', async t => {
  let now = 1000000;
  const server = createAppServer({ store: new MemoryStore(), clock: () => now });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token, body, expected = 200) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const guests = []; let view;
  for (let slot = 0; slot < 8; slot++) {
    const guest = await call('/api/session', null, {}); guests.push(guest);
    view = await call(slot ? '/api/tournaments/join' : '/api/tournaments', guest.token,
      { ...(slot ? { code: view.code } : {}), character: character(`HTTP ${slot + 1}`) });
  }
  const tokens = view.match.slots.map(slot => guests[slot].token);
  for (let index = 0; index < 2; index++) view = await call(`/api/tournaments/${view.code}/loadout`, tokens[index], command(view, `http-gear-${index}`, { loadout: gear }));
  now = view.match.deadline; await server.duels.tick();
  view = await call(`/api/tournaments/${view.code}`, tokens[0]); const before = structuredClone(view.match.duel);
  await call(`/api/tournaments/${view.code}/action`, tokens[0], command(view, 'forged-passive', { round: 1, action: 'focus', staminaRegen: 99 }), 400);
  const intention = command(view, 'http-focus', { round: 1, action: 'focus' });
  await call(`/api/tournaments/${view.code}/action`, tokens[0], intention);
  const observer = await call(`/api/arena/tournaments/${view.code}`);
  assert.equal(observer.you, null); assert.equal(observer.match.you, null); assert.equal(observer.match.yourLoadout, null);
  assert.deepEqual(observer.match.duel, before); assert.equal(Object.hasOwn(observer.match, 'actions'), false);
  await call(`/api/tournaments/${view.code}/action`, null, command(view, 'anonymous-focus', { round: 1, action: 'focus' }), 401);
  const resolved = await call(`/api/tournaments/${view.code}/action`, tokens[1], command(view, 'http-strike', { round: 1, action: 'strike' }));
  assert.deepEqual(resolved.match.duel, resolveRound(before, ['focus', 'strike']));
  assert.deepEqual((await call(`/api/tournaments/${view.code}/action`, tokens[0], intention)).match.duel, resolved.match.duel);
});
