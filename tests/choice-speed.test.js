import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, STAT_KEYS, ATTRIBUTE_LABELS, WEAPONS, ARMORS, TRAITS, validateCharacter, effectiveCharacterStats, currentTraitDescription,
  createDuel, deriveFighterStats, getActionOptions, resolveRound } from '../src/combat.js';
import { DuelService } from '../online/service.mjs';
import { MemoryStore } from '../online/store.mjs';

const stats = { strength: 5, dexterity: 5, defense: 5, intelligence: 5 };
const legacyStats = { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 };
const character = (name = 'Fighter', attributes = stats, trait = 'balanced') => ({ name, stats: { ...attributes }, trait });
const gear = { weapon: 'sword', armor: 'medium', helmet: 'none' };
const pair = (attributes = stats, version = 5) => createDuel(['West', 'East'].map(name => ({ character: character(name, attributes), ...gear })), { version });
const initiative = duel => duel.lastRound.events.find(event => event.type === 'initiative');

test('v5 uses four capped attributes and fairly reuses every preserved Speed point without changing identity', () => {
  assert.equal(RULES.VERSION, 5);
  assert.deepEqual(Object.keys(ATTRIBUTE_LABELS), ['strength', 'dexterity', 'defense', 'intelligence']);
  assert.deepEqual(STAT_KEYS, Object.keys(ATTRIBUTE_LABELS));
  assert.equal(validateCharacter(character()).valid, true);
  assert.equal(validateCharacter(character('Saved', legacyStats)).valid, true);
  const saved = character('Saved', { strength: 0, dexterity: 4, speed: 8, defense: 4, intelligence: 4 });
  const before = structuredClone(saved);
  assert.deepEqual(effectiveCharacterStats(saved), stats);
  assert.deepEqual(effectiveCharacterStats(saved, { version: 4 }), saved.stats);
  assert.deepEqual(saved, before);
  const equal = createDuel([{ character: saved, ...gear }, { character: character(), ...gear }]);
  assert.equal(equal.fighters[0].speed, undefined);
  assert.deepEqual(equal.fighters[0].character, saved);
  const { character: ignoredA, id: ignoredIdA, ...derivedA } = equal.fighters[0];
  const { character: ignoredB, id: ignoredIdB, ...derivedB } = equal.fighters[1];
  assert.deepEqual(derivedA, derivedB);
  // Visit every legal five-stat allocation; none loses a point or exceeds the cap.
  for (let strength = 0; strength <= 8; strength++) for (let dexterity = 0; dexterity <= 8; dexterity++)
    for (let speed = 0; speed <= 8; speed++) for (let defense = 0; defense <= 8; defense++) {
      const intelligence = 20 - strength - dexterity - speed - defense;
      if (intelligence < 0 || intelligence > 8) continue;
      const source = character('Saved', { strength, dexterity, speed, defense, intelligence });
      const effective = effectiveCharacterStats(source);
      assert.equal(Object.values(effective).reduce((sum, value) => sum + value, 0), 20);
      assert.ok(Object.values(effective).every(value => Number.isInteger(value) && value >= 0 && value <= 8));
      assert.equal(source.stats.speed, speed);
    }
  assert.equal(validateCharacter(character('Bad', { ...stats, strength: 6 })).valid, false);
  assert.equal(validateCharacter(character('Bad', { ...stats, speed: 0, extra: 0 })).valid, false);
  for (const version of [3, 4]) assert.throws(() => pair(stats, version), /saved Speed attribute/);
});

test('faster choice determines same-priority initiative in either seat and only changes resolved presentation', () => {
  const before = pair(), copy = structuredClone(before);
  for (const elapsed of [[2100, 600], [600, 2100]]) {
    const after = resolveRound(before, ['strike', 'strike'], { choiceElapsedMs: elapsed });
    assert.deepEqual(after.lastRound.order, elapsed[0] < elapsed[1] ? [0, 1] : [1, 0]);
    assert.equal(initiative(after).reason, 'faster choice');
    assert.deepEqual(initiative(after).choiceElapsedMs, elapsed);
    assert.deepEqual(after.lastRound.choiceElapsedMs, elapsed);
    assert.equal(Object.hasOwn(before, 'choiceElapsedMs'), false);
    assert.deepEqual(before, copy);
  }
  const one = resolveRound(before, ['strike', 'strike']);
  const two = resolveRound(one, ['strike', 'strike'], { choiceElapsedMs: [1200, 1200] });
  assert.deepEqual(one.lastRound.order, [0, 1]);
  assert.deepEqual(two.lastRound.order, [1, 0]);
  assert.equal(initiative(two).reason, 'the alternating choice-time tie');
  for (const invalid of [[-1, 0], [0, Infinity], [0, NaN], [0], [0, 0, 0], ['0', 0], {}])
    assert.throws(() => resolveRound(before, ['strike', 'strike'], { choiceElapsedMs: invalid }), /Choice timing/);
});

test('Guard and Riposte retain their action priority even when chosen later; v5 costs have no Speed discount', () => {
  const before = pair();
  const guarded = resolveRound(before, ['strike', 'guard'], { choiceElapsedMs: [1, 19000] });
  assert.deepEqual(guarded.lastRound.order, [1, 0]);
  assert.equal(initiative(guarded).reason, 'action priority');
  assert.equal(guarded.lastRound.events.find(event => event.type === 'attack').damage, getActionOptions(before, 0)[0].guardedDamage);
  const riposte = createDuel([{ character: character('West'), ...gear }, { character: character('East'), ...gear, weapon: 'dagger' }]);
  const parried = resolveRound(riposte, ['strike', 'technique'], { choiceElapsedMs: [1, 19000] });
  assert.deepEqual(parried.lastRound.order, [1, 0]);
  assert.ok(parried.lastRound.events.some(event => event.counter));
  assert.equal(deriveFighterStats(character(), gear).strikeCost, 3);
  assert.equal(deriveFighterStats(character('Legacy', legacyStats), gear, { version: 4 }).strikeCost, 2);
  const fleet = deriveFighterStats(character('Fleet', stats, 'fleetfoot'), gear);
  const plain = deriveFighterStats(character('Plain', stats, 'balanced'), gear);
  assert.equal(fleet.maxHp, plain.maxHp);
  assert.match(currentTraitDescription('fleetfoot'), /no health penalty/);
  assert.equal(currentTraitDescription('steadfast'), 'Maximum health +6.');
  assert.doesNotMatch(currentTraitDescription('ironhide'), /initiative/);
  assert.match(currentTraitDescription('fleetfoot', 4), /Initiative \+4/);
});

test('v3 and v4 retain literal Speed, stamina and exact resolution regardless of new timing options', () => {
  for (const version of [3, 4]) {
    let before = pair(legacyStats, version);
    const rest = version === 3 ? 'recover' : 'focus';
    for (const actions of [['strike', 'strike'], ['guard', 'strike'], [rest, 'technique']]) {
      const baseline = resolveRound(before, actions);
      assert.deepEqual(resolveRound(before, actions, { choiceElapsedMs: [19000, 1] }), baseline);
      assert.deepEqual(resolveRound(before, actions, { choiceElapsedMs: 'ignored legacy data' }), baseline);
      assert.equal(Object.hasOwn(baseline.lastRound, 'choiceElapsedMs'), false);
      assert.deepEqual(before.fighters[0].character.stats, legacyStats);
      before = baseline;
    }
  }
});

test('v5 current weapons, armors and traits retain affordable bounded command resolution with either faster chooser', () => {
  for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const trait of Object.keys(TRAITS)) {
    const before = createDuel([{ character: character('West', stats, trait), ...gear, weapon, armor }, { character: character('East'), ...gear }]);
    for (const actionA of getActionOptions(before, 0).filter(option => option.enabled))
      for (const actionB of getActionOptions(before, 1).filter(option => option.enabled)) for (const elapsed of [[100, 1000], [1000, 100]]) {
        const after = resolveRound(before, [actionA.id, actionB.id], { choiceElapsedMs: elapsed });
        const first = actionA.priority !== actionB.priority ? actionA.priority > actionB.priority ? 0 : 1 : elapsed[0] < elapsed[1] ? 0 : 1;
        assert.equal(after.lastRound.order[0], first, `${weapon}/${armor}/${trait}/${actionA.id}/${actionB.id}`);
        assert.equal(after.lastRound.events.filter(event => event.type === 'stamina-regeneration').length, 2);
        for (const fighter of after.fighters) assert.ok(fighter.hp >= 0 && fighter.hp <= fighter.maxHp && fighter.stamina >= 0 && fighter.stamina <= fighter.maxStamina);
        assert.equal(after.round, 2);
      }
  }
});

async function fixture(t, mode) {
  let now = 1000000, service, failWrites = false;
  const store = new MemoryStore(), write = store.write.bind(store);
  store.write = async value => { if (failWrites) throw new Error('Synthetic write failure'); await write(value); };
  const config = { store, clock: () => now, disconnectMs: 10000000 };
  service = new DuelService(config); await service.initialized;
  t.after(() => service.close());
  const base = mode === 'tournament' ? '/api/tournaments' : '/api/rooms';
  const guests = []; let view;
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  for (let index = 0; index < (mode === 'tournament' ? 8 : 2); index++) {
    const guest = await request('POST', '/api/session', null, {}); guests.push(guest);
    view = await request('POST', index ? `${base}/join` : base, guest.token,
      { ...(index ? { code: view.code } : {}), character: character(`Fighter ${index}`) });
  }
  const code = view.code, slots = mode === 'tournament' ? view.match.slots : [0, 1], tokens = slots.map(slot => guests[slot].token);
  const f = { tokens, get service() { return service; }, get now() { return now; },
    match: value => value.match ?? value,
    record: () => mode === 'tournament' ? service.data.tournaments[code].match : service.data.rooms[code],
    read: (index = 0) => request('GET', `${base}/${code}`, tokens[index]),
    observe: () => mode === 'tournament' ? request('GET', `/api/arena/tournaments/${code}`) : request('GET', `${base}/${code}`, tokens[1]),
    post: (view, index, kind, payload, commandId) => request('POST', `${base}/${code}/${kind}`, tokens[index], { duelId: view.duelId, commandId, ...payload }),
    async tickTo(at) { now = at; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(config); await service.initialized; },
    fail(value) { failWrites = value; },
  };
  await f.post(view, 0, 'loadout', { loadout: gear }, 'gear0');
  view = await f.post(view, 1, 'loadout', { loadout: gear }, 'gear1');
  if (mode === 'tournament') { await f.tickTo(f.match(view).deadline); view = await f.read(); }
  f.initial = view;
  return f;
}

for (const mode of ['room', 'tournament']) {
  test(`${mode}: first server acknowledgment time is private, durable, immutable on retries and revealed with the resolved round`, async t => {
    const f = await fixture(t, mode), view = f.initial, startsAt = f.match(view).actionOpensAt;
    assert.equal(f.match(view).duel.version, 5);
    await f.tickTo(startsAt + 600);
    const pending = await f.post(view, 1, 'action', { round: 1, action: 'strike' }, 'first-choice');
    assert.deepEqual(f.match(pending).pending, [false, true]);
    assert.deepEqual(f.record().choiceElapsedMs, [null, 600]);
    assert.equal(JSON.stringify(f.match(pending)).includes('choiceElapsedMs'), false);
    assert.equal(JSON.stringify(f.match(await f.observe())).includes('choiceElapsedMs'), false);
    await f.restart(); await f.tickTo(startsAt + 1100);
    await f.post(view, 1, 'action', { round: 1, action: 'strike' }, 'first-choice');
    assert.deepEqual(f.record().choiceElapsedMs, [null, 600]);
    await assert.rejects(f.post(view, 0, 'action', { round: 1, action: 'strike', choiceElapsedMs: 0 }, 'forged-time'), error => error.status === 400);
    await f.tickTo(startsAt + 1700);
    const resolved = f.match(await f.post(view, 0, 'action', { round: 1, action: 'strike' }, 'second-choice'));
    assert.deepEqual(resolved.duel.lastRound.choiceElapsedMs, [1700, 600]);
    assert.deepEqual(resolved.duel.lastRound.order, [1, 0]);
    assert.deepEqual(f.record().choiceElapsedMs, [null, null]);
    const retry = f.match(await f.post(view, 1, 'action', { round: 1, action: 'strike' }, 'first-choice'));
    assert.deepEqual(retry.duel, resolved.duel);
  });

  test(`${mode}: timeout records the logical deadline and failed persistence grants no earlier commitment`, async t => {
    const f = await fixture(t, mode), view = f.initial, startsAt = f.match(view).actionOpensAt;
    await f.tickTo(startsAt + 400); f.fail(true);
    await assert.rejects(f.post(view, 0, 'action', { round: 1, action: 'focus' }, 'failed-write'), /Synthetic write failure/);
    assert.deepEqual(f.record().actions, [null, null]); assert.deepEqual(f.record().choiceElapsedMs, [null, null]);
    f.fail(false); await f.tickTo(startsAt + 700);
    await f.post(view, 0, 'action', { round: 1, action: 'focus' }, 'failed-write');
    await f.tickTo(startsAt + 26000);
    const resolved = f.match(await f.read());
    assert.deepEqual(resolved.duel.lastRound.actions, ['focus', 'focus']);
    assert.deepEqual(resolved.duel.lastRound.choiceElapsedMs, [700, 20000]);
    assert.deepEqual(resolved.duel.lastRound.order, [0, 1]);
    assert.equal(resolved.actionOpensAt, f.now + 4000);
    assert.equal(resolved.deadline - resolved.actionOpensAt, 20000);
  });

  test(`${mode}: accepted v4 choices survive restart and resolve by their original Speed contract`, async t => {
    const f = await fixture(t, mode), original = f.initial;
    await f.service.serialize(() => {
      const record = f.record();
      record.duel = pair(legacyStats, 4);
      delete record.choiceElapsedMs;
      f.service.changed = true;
    });
    const view = await f.read(), before = f.match(view).duel;
    await f.tickTo(f.now + 200);
    await f.post(view, 1, 'action', { round: 1, action: 'strike' }, 'legacy-first');
    await f.restart(); await f.tickTo(f.now + 1200);
    const after = f.match(await f.post(view, 0, 'action', { round: 1, action: 'strike' }, 'legacy-second')).duel;
    assert.deepEqual(after, resolveRound(before, ['strike', 'strike']));
    assert.deepEqual(after.lastRound.order, [0, 1]);
    assert.equal(Object.hasOwn(after.lastRound, 'choiceElapsedMs'), false);
  });
}

test('v5 tournament bots use their scheduled three-second commitment instead of late polling time', async t => {
  const f = await fixture(t, 'tournament'), initial = f.initial, opensAt = f.match(initial).actionOpensAt;
  await f.service.serialize(() => {
    const match = f.record();
    match.players[1].bot = true; match.players[1].botStyle = 'aggressive';
    match.botRound = null; f.service.changed = true;
  });
  await f.tickTo(opensAt + 5000);
  assert.deepEqual(f.record().choiceElapsedMs, [null, 3000]);
  assert.deepEqual(f.match(await f.read()).pending, [false, true]);
  const after = f.match(await f.post(initial, 0, 'action', { round: 1, action: 'strike' }, 'human-after-bot')).duel;
  assert.deepEqual(after.lastRound.choiceElapsedMs, [5000, 3000]);
  assert.deepEqual(after.lastRound.order, [1, 0]);
});
