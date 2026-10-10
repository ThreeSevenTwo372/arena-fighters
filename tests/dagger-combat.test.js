import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RULES, WEAPONS, ARMORS, TRAITS, createDuel as createCurrentDuel, deriveFighterStats as deriveCurrentStats, getActionOptions, resolveRound, chooseCpuAction } from '../src/combat.js';

// Preserve the sealed v3 counter and 13,440-outcome fingerprint; v4 Focus
// counters and passive stamina are exercised in focus-combat.test.js.
const createDuel = entries => createCurrentDuel(entries, { version: 3 });
const deriveFighterStats = (character, loadout) => deriveCurrentStats(character, loadout, { version: 3 });

const legacyWeapons = ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword'];
const builds = [
  { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  { strength: 8, dexterity: 2, speed: 2, defense: 6, intelligence: 2 },
  { strength: 2, dexterity: 8, speed: 6, defense: 2, intelligence: 2 },
  { strength: 2, dexterity: 4, speed: 2, defense: 4, intelligence: 8 },
];
const entry = (name = 'A', weapon = 'dagger', armor = 'medium', stats = builds[0], trait = 'balanced') => ({ character: { name, stats, trait }, weapon, armor });
const duel = (a = entry(), b = entry('B', 'sword')) => createDuel([a, b]);
const option = (state, index, action) => getActionOptions(state, index).find(item => item.id === action);
const edit = (state, change) => { const next = structuredClone(state); change(next); return next; };

test('dagger gives a faster, lighter Dexterity strike and a disclosed conditional counter', () => {
  const state = duel(), dagger = state.fighters[0], sword = state.fighters[1], riposte = option(state, 0, 'technique');
  assert.equal(state.version, 3, 'Saved version-3 duels retain validity.');
  assert.deepEqual([dagger.strikePower, dagger.techniquePower, dagger.speed, dagger.strikeCost, dagger.techniqueCost], [15, 16, 8, 3, 5]);
  assert.deepEqual([option(state, 0, 'strike').damage, riposte.damage, riposte.guardedDamage], [11, 12, 0]);
  assert.deepEqual([riposte.conditional, riposte.trigger, riposte.reduction, riposte.priority], ['riposte', 'strike', 0.5, 2]);
  assert.ok(riposte.enabled && Object.isFrozen(riposte));
  assert.ok(dagger.speed > sword.speed && dagger.strikePower < sword.strikePower);
  assert.match(riposte.description, /Weapon Techniques bypass/); assert.match(riposte.description, /Pay stamina even when it misses/);
  const precise = deriveFighterStats(entry('A', 'dagger', 'medium', builds[2]).character, { weapon: 'dagger', armor: 'medium' });
  const strong = deriveFighterStats(entry('A', 'dagger', 'medium', builds[1]).character, { weapon: 'dagger', armor: 'medium' });
  assert.ok(precise.strikePower > strong.strikePower && precise.techniquePower > strong.techniquePower);
});

test('Riposte halves post-armor ordinary Strikes in either seat and counters exactly once without a second cost', () => {
  for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const side of [0, 1]) {
    const pair = [entry('Riposter', 'dagger', armor), entry('Striker', weapon, 'heavy')];
    const state = createDuel(side === 0 ? pair : pair.reverse()), before = structuredClone(state), other = 1 - side;
    const incoming = option(state, other, 'strike'), riposte = option(state, side, 'technique');
    const actions = side === 0 ? ['technique', 'strike'] : ['strike', 'technique'];
    const after = resolveRound(state, actions), attacks = after.lastRound.events.filter(event => event.type === 'attack');
    assert.deepEqual(after.lastRound.order, [side, other]);
    assert.equal(after.fighters[side].hp, before.fighters[side].hp - Math.max(1, Math.floor(incoming.damage * 0.5)));
    assert.equal(after.fighters[other].hp, before.fighters[other].hp - riposte.damage);
    assert.equal(after.fighters[side].stamina, before.fighters[side].stamina - riposte.cost);
    assert.equal(after.fighters[other].stamina, before.fighters[other].stamina - incoming.cost);
    assert.deepEqual(attacks.map(event => [event.actor, event.target, event.action]), [[other, side, 'strike'], [side, other, 'technique']]);
    assert.equal(attacks[0].parried, true); assert.equal(attacks[1].counter, true);
    assert.equal(after.lastRound.events.filter(event => event.type === 'riposte').length, 1);
    assert.equal(after.lastRound.events.filter(event => event.type === 'riposte-miss').length, 0);
    assert.deepEqual(state, before, 'The public input state remains unchanged.');
  }
});

test('every existing Weapon Technique bypasses Riposte and its ordinary Guard protection is not inherited', () => {
  for (const weapon of legacyWeapons) for (const side of [0, 1]) {
    const pair = [entry('Riposter'), entry('Attacker', weapon)], state = createDuel(side === 0 ? pair : pair.reverse()), other = 1 - side;
    const expected = option(state, other, 'technique'), after = resolveRound(state, ['technique', 'technique']);
    assert.equal(after.fighters[side].hp, state.fighters[side].hp - expected.damage, weapon);
    assert.equal(after.fighters[other].hp, state.fighters[other].hp);
    assert.equal(after.fighters[side].stamina, state.fighters[side].stamina - option(state, side, 'technique').cost);
    const attacks = after.lastRound.events.filter(event => event.type === 'attack');
    assert.equal(attacks.length, 1); assert.equal(attacks[0].actor, other);
    assert.equal(attacks[0].counter, undefined); assert.equal(attacks[0].parried, undefined);
    assert.equal(after.lastRound.events.filter(event => event.type === 'riposte-miss' && event.actor === side).length, 1);
  }
});

test('Guard, Recover and mutual Riposte whiff while paying their promised costs', () => {
  for (const reply of ['guard', 'recover']) {
    const state = duel(), after = resolveRound(state, ['technique', reply]);
    assert.deepEqual(after.fighters.map(fighter => fighter.hp), state.fighters.map(fighter => fighter.hp));
    assert.equal(after.fighters[0].stamina, state.fighters[0].stamina - option(state, 0, 'technique').cost);
    assert.equal(after.lastRound.events.filter(event => event.type === 'attack').length, 0);
    assert.equal(after.lastRound.events.filter(event => event.type === 'riposte-miss').length, 1);
  }
  const state = duel(entry('A'), entry('B', 'dagger')), after = resolveRound(state, ['technique', 'technique']);
  assert.deepEqual(after.fighters.map(fighter => fighter.hp), state.fighters.map(fighter => fighter.hp));
  assert.deepEqual(after.fighters.map(fighter => fighter.stamina), [11, 11]);
  assert.equal(after.lastRound.events.filter(event => event.type === 'riposte').length, 2);
  assert.equal(after.lastRound.events.filter(event => event.type === 'riposte-miss').length, 2);
  assert.equal(after.lastRound.events.filter(event => event.type === 'attack').length, 0);
});

test('a lethal parried Strike still wins and a defeated Riposter never counterattacks', () => {
  const state = edit(duel(), next => { next.fighters[0].hp = 1; });
  const after = resolveRound(state, ['technique', 'strike']);
  assert.deepEqual(after.result, { winner: 1, reason: 'knockout' });
  assert.equal(after.fighters[0].hp, 0); assert.equal(after.fighters[1].hp, state.fighters[1].hp);
  const attacks = after.lastRound.events.filter(event => event.type === 'attack');
  assert.equal(attacks.length, 1); assert.equal(attacks[0].parried, true);
  assert.equal(after.lastRound.events.some(event => event.counter || event.type === 'riposte-miss'), false);
  assert.equal(after.fighters[0].stamina, state.fighters[0].stamina - option(state, 0, 'technique').cost);
});

test('a lethal counter wins once after the incoming Strike, with no recursive counter or second turn', () => {
  const state = edit(duel(entry('A'), entry('B', 'dagger')), next => { next.fighters[1].hp = 1; });
  const after = resolveRound(state, ['technique', 'strike']);
  assert.deepEqual(after.result, { winner: 0, reason: 'knockout' }); assert.equal(after.status, 'complete');
  assert.equal(after.lastRound.events.filter(event => event.type === 'result').length, 1);
  assert.equal(after.lastRound.events.filter(event => event.counter).length, 1);
  assert.equal(after.lastRound.events.filter(event => event.type === 'attack').length, 2);
  assert.equal(after.lastRound.actions.length, 2); assert.equal(after.fighters[0].stamina, 11);
  assert.throws(() => resolveRound(after, ['technique', 'strike']), /already ended/);
});

test('Riposte reduction and full armor counter damage both retain a minimum of one', () => {
  const weak = { strength: 0, dexterity: 0, speed: 8, defense: 8, intelligence: 4 };
  const tank = { strength: 0, dexterity: 0, speed: 4, defense: 8, intelligence: 8 };
  const state = duel(entry('Riposter', 'dagger', 'heavy', weak), entry('Tank', 'sword', 'heavy', tank));
  assert.equal(option(state, 1, 'strike').damage, 1); assert.equal(option(state, 0, 'technique').damage, 1);
  const after = resolveRound(state, ['technique', 'strike']);
  assert.equal(state.fighters[0].hp - after.fighters[0].hp, 1); assert.equal(state.fighters[1].hp - after.fighters[1].hp, 1);
  const lethal = edit(state, next => { next.fighters[0].hp = 1; }), ended = resolveRound(lethal, ['technique', 'strike']);
  assert.equal(ended.result.winner, 1); assert.equal(ended.lastRound.events.some(event => event.counter), false);
});

test('stamina, armor and creation-trait modifiers apply once to Riposte, including a missed stance', () => {
  for (const armor of Object.keys(ARMORS)) for (const trait of Object.keys(TRAITS)) {
    const state = duel(entry('Riposter', 'dagger', armor, builds[3], trait)), cost = option(state, 0, 'technique').cost;
    assert.ok(cost >= RULES.MIN_TECHNIQUE_COST);
    const poor = edit(state, next => { next.fighters[0].stamina = cost - 1; });
    assert.equal(option(poor, 0, 'technique').enabled, false);
    assert.throws(() => resolveRound(poor, ['technique', 'recover']), /cannot afford/);
    const exact = edit(state, next => { next.fighters[0].stamina = cost; });
    const after = resolveRound(exact, ['technique', 'recover']);
    assert.equal(after.fighters[0].stamina, 0, `${armor}/${trait} pays once even on a miss`);
    assert.equal(after.lastRound.events.some(event => event.counter), false);
  }
  const balanced = option(duel(entry('A', 'dagger', 'medium', builds[3])), 0, 'technique').cost;
  const specialist = option(duel(entry('A', 'dagger', 'medium', builds[3], 'specialist')), 0, 'technique').cost;
  assert.equal(specialist, balanced + 1, 'The trait drawback remains after Intelligence discounts.');
});

test('Riposte readiness ends with the round and leaves no persistent fighter status behind', () => {
  const before = duel(), first = resolveRound(before, ['technique', 'strike']);
  const incoming = option(first, 1, 'strike').damage, second = resolveRound(first, ['recover', 'strike']);
  assert.equal(first.fighters[0].hp - second.fighters[0].hp, incoming);
  assert.equal(second.lastRound.events.some(event => event.counter || event.parried), false);
  assert.deepEqual(Object.keys(first.fighters[0]), Object.keys(before.fighters[0]));
  const fresh = duel(); assert.deepEqual(fresh.fighters, before.fighters);
});

test('conditional options and CPU predictions ignore unrevealed choices and do not assume a lethal counter', () => {
  const state = edit(duel(), next => { next.fighters[1].hp = 12; });
  assert.equal(option(state, 0, 'strike').damage, 11); assert.equal(option(state, 0, 'technique').damage, 12);
  assert.equal(chooseCpuAction(state, 0), 'strike', 'Possible counter damage is not an unconditional finisher.');
  const predicting = edit(state, next => { next.lastRound = { actions: ['guard', 'strike'] }; });
  assert.equal(chooseCpuAction(predicting, 0), 'technique');
  const spentRival = edit(predicting, next => { next.fighters[1].stamina = 0; });
  assert.equal(chooseCpuAction(spentRival, 0), 'strike');
  for (const hidden of ['strike', 'technique', 'guard', 'recover']) {
    const secret = edit(predicting, next => { next.pendingActions = [null, hidden]; next.secret = { selectedAction: hidden }; });
    assert.deepEqual(getActionOptions(secret, 0), getActionOptions(predicting, 0));
    assert.equal(chooseCpuAction(secret, 0), chooseCpuAction(predicting, 0));
  }
});

test('all original definitions and 13440 legal original-weapon outcomes match the sealed pre-dagger fingerprint', () => {
  const hash = createHash('sha256');
  // V4 changes help text and adds passive-regeneration metadata. Hash the
  // current numeric legacy effects with their sealed v3 public descriptors,
  // then every actual v3 state/CPU choice/resolution against the original hash.
  const rules = { ...RULES, VERSION: 3 }; delete rules.FOCUS_DAMAGE_BONUS;
  rules.description = 'Choose secretly, reveal together. Priority acts first, then speed. Equal speed alternates its first player each round. At 24 rounds, remaining health percentage, then stamina percentage decides; an exact tie is a draw.';
  const oldArmorDescriptions = {
    light: 'No armor protection or speed penalty. Base recovery 8; Speed and Intelligence improve it. Personal Defense still protects.',
    medium: 'Blocks 2 plus 1 damage per 4 Defense; costs 2 initiative. Base recovery 7, improved by Speed and Intelligence.',
    heavy: 'Blocks 4 plus 1 damage per 2 Defense; costs 4 initiative and 1 stamina per attack. Base recovery 6, improved by Speed and Intelligence.',
  };
  const armors = Object.fromEntries(Object.entries(ARMORS).map(([id, armor]) => [id, { ...armor, description: oldArmorDescriptions[id] }]));
  const traits = Object.fromEntries(Object.entries(TRAITS).map(([id, trait]) => {
    const legacy = { ...trait }; delete legacy.regenerationBonus;
    if (id === 'ironhide') legacy.description = 'Personal protection +2; initiative -3; stamina recovery -2.';
    if (id === 'vigorous') legacy.description = 'Maximum stamina +5; stamina recovery +2; attack power -2.';
    return [id, legacy];
  }));
  hash.update(JSON.stringify({ rules, weapons: Object.fromEntries(legacyWeapons.map(id => [id, WEAPONS[id]])), armors, traits }));
  let count = 0;
  for (const stats of builds) for (const weapon of legacyWeapons) for (const armor of Object.keys(ARMORS)) for (const trait of Object.keys(TRAITS)) {
    const state = createDuel([entry('A', weapon, armor, stats, trait), entry('B', 'sword', 'medium', builds[0], 'balanced')]);
    hash.update(JSON.stringify(state)); hash.update(JSON.stringify([chooseCpuAction(state, 0), chooseCpuAction(state, 1)]));
    for (const a of ['strike', 'technique', 'guard', 'recover']) for (const b of ['strike', 'technique', 'guard', 'recover']) {
      hash.update(JSON.stringify(resolveRound(state, [a, b]))); count++;
    }
  }
  assert.equal(count, 13440); assert.equal(hash.digest('hex'), 'cdc5f8e3a92287bf99d36265dbf7e00ea0448614d6e37f5076b38556eca37ac1');
});

test('dagger has winning and losing public-policy matchups in both seats and every sampled duel terminates', t => {
  const results = { wins: 0, losses: 0, draws: 0, duels: 0, capped: 0, rounds: [] };
  const pressure = (state, index) => {
    const strike = option(state, index, 'strike'), technique = option(state, index, 'technique');
    if (!strike.enabled) return 'recover';
    if (technique.enabled && !technique.conditional && technique.damage / technique.cost > strike.damage / strike.cost) return 'technique';
    return 'strike';
  };
  const winsBySeat = [0, 0], lossesBySeat = [0, 0];
  for (const stats of builds) for (const armor of Object.keys(ARMORS)) for (const weapon of legacyWeapons) for (const enemyArmor of Object.keys(ARMORS)) for (const side of [0, 1]) for (const enemyPolicy of [chooseCpuAction, pressure]) {
    const pair = [entry('Dagger', 'dagger', armor, stats), entry('Opponent', weapon, enemyArmor, stats)];
    let state = createDuel(side === 0 ? pair : pair.reverse()), rounds = 0;
    while (state.status === 'active') {
      const actions = state.fighters.map((_, index) => (index === side ? chooseCpuAction : enemyPolicy)(state, index));
      state = resolveRound(state, actions); rounds++;
      assert.ok(rounds <= RULES.MAX_ROUNDS);
      for (const fighter of state.fighters) assert.ok(fighter.hp >= 0 && fighter.hp <= fighter.maxHp && fighter.stamina >= 0 && fighter.stamina <= fighter.maxStamina);
    }
    results.duels++; results.rounds.push(rounds); if (rounds === RULES.MAX_ROUNDS) results.capped++;
    if (state.result.winner === side) { results.wins++; winsBySeat[side]++; }
    else if (state.result.winner === null) results.draws++;
    else { results.losses++; lossesBySeat[side]++; }
  }
  assert.equal(results.duels, 1008);
  assert.ok(winsBySeat.every(count => count > 0) && lossesBySeat.every(count => count > 0));
  results.rounds.sort((a, b) => a - b);
  t.diagnostic(JSON.stringify({ ...results, rounds: undefined, medianRounds: results.rounds[Math.floor(results.rounds.length / 2)], maximumRounds: results.rounds.at(-1) }));
});

test('repeated mutual Riposte remains a bounded draw rather than an endless reaction loop', () => {
  let state = duel(entry('A'), entry('B', 'dagger')), rounds = 0;
  while (state.status === 'active') {
    const actions = state.fighters.map((_, index) => option(state, index, 'technique').enabled ? 'technique' : 'recover');
    state = resolveRound(state, actions); rounds++;
    assert.equal(state.lastRound.events.filter(event => event.type === 'attack').length, 0);
    assert.ok(rounds <= RULES.MAX_ROUNDS);
  }
  assert.equal(rounds, 24); assert.deepEqual(state.result, { winner: null, reason: 'draw' });
});

test('dagger CPU mirrors keep attacking between predictions rather than spending most rounds in mutual misses', t => {
  const lengths = [];
  let mutualMisses = 0, strikes = 0;
  for (const stats of builds) for (const armor of Object.keys(ARMORS)) for (const trait of Object.keys(TRAITS)) {
    let state = duel(entry('A', 'dagger', armor, stats, trait), entry('B', 'dagger', armor, stats, trait));
    let rounds = 0, missedRounds = 0, strikeRounds = 0;
    while (state.status === 'active') {
      const actions = [chooseCpuAction(state, 0), chooseCpuAction(state, 1)];
      if (actions.every(action => action === 'technique')) missedRounds++;
      if (actions.includes('strike')) strikeRounds++;
      state = resolveRound(state, actions); rounds++;
      assert.ok(rounds <= RULES.MAX_ROUNDS);
    }
    assert.ok(strikeRounds > missedRounds, `${armor}/${trait}: ${strikeRounds} attack rounds, ${missedRounds} mutual misses`);
    lengths.push(rounds); mutualMisses += missedRounds; strikes += strikeRounds;
  }
  lengths.sort((a, b) => a - b);
  assert.equal(lengths.length, 120);
  t.diagnostic(JSON.stringify({ duels: lengths.length, capped: lengths.filter(rounds => rounds === RULES.MAX_ROUNDS).length,
    minimumRounds: lengths[0], medianRounds: lengths[Math.floor(lengths.length / 2)], maximumRounds: lengths.at(-1),
    strikeRounds: strikes, mutualMissRounds: mutualMisses }));
});
