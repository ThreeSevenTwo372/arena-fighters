import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, WEAPONS, ARMORS, HELMETS, TRAITS, ATTRIBUTE_LABELS, ATTRIBUTE_HELP, validateCharacter, deriveFighterStats, createDuel, getActionOptions, resolveRound, forfeitDuel, chooseCpuAction } from '../src/combat.js';

const balanced = { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 };
const strong = { strength: 8, dexterity: 2, speed: 2, defense: 6, intelligence: 2 };
const swift = { strength: 2, dexterity: 6, speed: 4, defense: 4, intelligence: 4 };
const character = (name = 'A', stats = { ...balanced }, trait = 'balanced') => ({ name, stats, trait, color: '#b87333', appearance: { crest: 'red' } });
const entry = (name = 'A', weapon = 'sword', armor = 'light', stats, trait) => ({ character: character(name, stats, trait), weapon, armor });
const duel = (a = entry('A'), b = entry('B'), options) => createDuel([a, b], options);
const edited = (state, apply) => { const copy = structuredClone(state); apply(copy); return copy; };

test('character validation enforces an exact capped integer allocation and one known trait', () => {
  assert.equal(validateCharacter(character()).valid, true);
  assert.equal(validateCharacter(character('A', strong)).valid, true);
  for (const stats of [ { ...balanced, strength: 5 }, { ...balanced, strength: 9, dexterity: 0 }, { ...balanced, strength: -1, dexterity: 8 }, { ...balanced, strength: 4.5, dexterity: 3.5 }, { ...balanced, strength: NaN }, { strength: 4, dexterity: 4, speed: 4, defense: 8 }, { ...balanced, might: 0 }, { might: 4, agility: 4, vitality: 4 }, null, [] ]) assert.equal(validateCharacter(character('A', stats)).valid, false);
  assert.equal(validateCharacter(character('')).valid, false);
  assert.equal(validateCharacter(character('x'.repeat(25))).valid, false);
  assert.equal(validateCharacter(character('A', undefined, 'unknown')).valid, false);
  assert.equal(validateCharacter({ ...character(), color: 'red' }).valid, false);
  assert.throws(() => duel(entry('A', 'unknown')), /weapon/);
  assert.throws(() => createDuel([entry()]), /two/);
});

test('creation preserves isolated metadata, exposes equipment tradeoffs, and resets duel resources', () => {
  const input = entry();
  const state = duel(input, entry('B', 'axe', 'heavy'));
  input.character.appearance.crest = 'blue';
  assert.equal(state.fighters[0].character.appearance.crest, 'red');
  assert.equal(state.fighters[0].hp, state.fighters[0].maxHp);
  assert.equal(state.fighters[1].stamina, state.fighters[1].maxStamina);
  assert.equal(state.fighters[1].speed, 3);
  assert.equal(getActionOptions(state, 1).find((action) => action.id === 'strike').cost, 5);
  assert.equal(getActionOptions(state, 1).find((action) => action.id === 'recover').recovery, 8);
  assert.equal(getActionOptions(state, 0).find((action) => action.id === 'strike').damage, 10);
  for (const weapon of Object.values(WEAPONS)) assert.ok(weapon.name && weapon.description);
  for (const armor of Object.values(ARMORS)) assert.ok(armor.name && armor.description);
  for (const trait of Object.values(TRAITS)) assert.ok(trait.name && trait.description);
  assert.equal(RULES.POINT_BUDGET, 20);
  assert.equal(RULES.STAT_CAP, 8);
  assert.deepEqual(Object.keys(ATTRIBUTE_LABELS), ['strength', 'dexterity', 'speed', 'defense', 'intelligence']);
  assert.ok(Object.keys(ATTRIBUTE_LABELS).every(key => ATTRIBUTE_HELP[key]));
  const derived = deriveFighterStats(input.character, input);
  for (const key of Object.keys(derived)) assert.equal(state.fighters[0][key], derived[key]);
  assert.ok(Object.isFrozen(derived));
});

test('all ten lifelong traits expose their complete bonuses and balancing drawbacks in equipment previews', () => {
  const fields = ['maxHp', 'maxStamina', 'speed', 'personalProtection', 'recovery', 'strikePower', 'techniquePower', 'strikeCost', 'techniqueCost'];
  // Balanced attributes, Sword, Medium Armor. Exact numbers protect the
  // original three traits and distinguish each new specialization and risk.
  const expected = {
    balanced:   [98, 16, 6, 1, 9, 17, 15, 3, 4],
    relentless: [98, 12, 6, 1, 9, 19, 17, 3, 4],
    steadfast:  [104, 14, 5, 1, 9, 17, 15, 3, 4],
    berserker:  [88, 14, 6, 1, 9, 21, 19, 4, 5],
    fleetfoot:  [90, 14, 10, 1, 9, 17, 15, 3, 4],
    ironhide:   [98, 14, 3, 3, 7, 17, 15, 3, 4],
    vigorous:   [98, 19, 6, 1, 11, 15, 13, 3, 4],
    brawler:    [98, 14, 6, 1, 9, 21, 12, 4, 4],
    specialist: [98, 14, 6, 1, 9, 14, 19, 3, 5],
    efficient:  [98, 14, 6, 1, 9, 15, 13, 2, 3],
  };
  assert.deepEqual(Object.keys(TRAITS), Object.keys(expected));
  for (const [trait, values] of Object.entries(expected)) {
    const fighter = character(trait, balanced, trait);
    assert.equal(validateCharacter(fighter).valid, true);
    const preview = deriveFighterStats(fighter, { weapon: 'sword', armor: 'medium' });
    assert.deepEqual(fields.map(field => preview[field]), values, trait);
    assert.equal(preview.mitigation, preview.personalProtection + preview.armorProtection);
    assert.equal(preview.armorProtection, 3, 'traits never silently change armor ownership');
    assert.equal(preview.fortuneBonus, 0, 'traits do not alter Intelligence fortune');
    assert.ok(TRAITS[trait].description.includes('+') || TRAITS[trait].description.includes('-'));
    if (trait !== 'balanced') assert.ok(TRAITS[trait].description.includes('-'), `${trait} must disclose its drawback`);
    assert.ok(Object.isFrozen(TRAITS[trait]));
  }
});

test('trait attack, stamina, initiative, and recovery previews match deterministic round resolution', () => {
  for (const trait of Object.keys(TRAITS)) {
    const initial = duel(entry('A', 'sword', 'medium', balanced, trait), entry('B', 'sword', 'medium'));
    const snapshot = structuredClone(initial);
    const options = getActionOptions(initial, 0);
    for (const action of options.filter(option => ['strike', 'technique'].includes(option.id))) {
      const resolved = resolveRound(initial, [action.id, 'recover']);
      assert.equal(resolved.fighters[1].hp, initial.fighters[1].hp - action.damage, `${trait} ${action.id} damage`);
      assert.equal(resolved.fighters[0].stamina, initial.fighters[0].stamina - action.cost, `${trait} ${action.id} cost`);
      assert.deepEqual(resolveRound(initial, [action.id, 'recover']), resolved, `${trait} remains deterministic`);
    }
    const empty = edited(initial, state => { state.fighters[0].stamina = 0; });
    const recovered = resolveRound(empty, ['recover', 'recover']);
    assert.equal(recovered.fighters[0].stamina, initial.fighters[0].recovery, `${trait} recovery`);
    const full = resolveRound(initial, ['recover', 'recover']);
    assert.equal(full.fighters[0].stamina, initial.fighters[0].maxStamina, `${trait} recovery cap`);
    assert.deepEqual(initial, snapshot);
  }
  const fast = duel(entry('Fleet', 'sword', 'medium', balanced, 'fleetfoot'), entry('Measured', 'sword', 'medium'));
  assert.deepEqual(resolveRound(fast, ['strike', 'strike']).lastRound.order, [0, 1]);
  const slow = duel(entry('Iron', 'sword', 'medium', balanced, 'ironhide'), entry('Measured', 'sword', 'medium'));
  assert.deepEqual(resolveRound(slow, ['strike', 'strike']).lastRound.order, [1, 0]);
});

test('Ironhide protection survives armor piercing and its recovery drawback remains real', () => {
  const plain = duel(entry('Mace', 'mace'), entry('Target', 'sword', 'heavy', balanced, 'balanced'));
  const iron = duel(entry('Mace', 'mace'), entry('Target', 'sword', 'heavy', balanced, 'ironhide'));
  const plainHit = getActionOptions(plain, 0)[1];
  const ironHit = getActionOptions(iron, 0)[1];
  assert.equal(plainHit.damage - ironHit.damage, 2);
  const resolved = resolveRound(iron, ['technique', 'recover']);
  assert.equal(resolved.lastRound.events.find(event => event.type === 'attack').damage, ironHit.damage);
  assert.equal(iron.fighters[1].recovery, 6);
});

test('each trait has winning and losing equal-equipment matchups in both seats', () => {
  const loadouts = Object.keys(WEAPONS).flatMap(weapon => Object.keys(ARMORS).map(armor => ({ weapon, armor })));
  for (const trait of Object.keys(TRAITS)) {
    const wins = [0, 0];
    for (const other of Object.keys(TRAITS)) {
      if (other === trait) continue;
      for (const gear of loadouts) for (const side of [0, 1]) {
        const own = entry(trait, gear.weapon, gear.armor, balanced, trait);
        const opponent = entry(other, gear.weapon, gear.armor, balanced, other);
        let state = createDuel(side === 0 ? [own, opponent] : [opponent, own]);
        while (state.status === 'active') state = resolveRound(state, [chooseCpuAction(state, 0), chooseCpuAction(state, 1)]);
        if (state.result.winner !== null) wins[state.result.winner === side ? 0 : 1] += 1;
      }
    }
    // A broad regression guard against unusable or dominant traits; a single
    // deterministic CPU policy cannot establish human competitive balance.
    const share = wins[0] / (wins[0] + wins[1]);
    assert.ok(share >= 0.15 && share <= 0.85, `${trait}: ${wins[0]} wins, ${wins[1]} losses`);
  }
});

test('Guard acts before fast attacks, while weapon techniques have distinct counterplay', () => {
  const stats = swift;
  const slow = strong;
  const swordState = duel(entry('Fast', 'sword', 'light', stats), entry('Slow', 'sword', 'heavy', slow));
  const guarded = resolveRound(swordState, ['strike', 'guard']);
  assert.deepEqual(guarded.lastRound.order, [1, 0]);
  assert.equal(guarded.fighters[1].hp, swordState.fighters[1].hp - getActionOptions(swordState, 0)[0].guardedDamage);
  const feinted = resolveRound(swordState, ['technique', 'guard']);
  assert.ok(feinted.fighters[1].hp < guarded.fighters[1].hp);
  assert.equal(feinted.lastRound.events.find((event) => event.type === 'attack').bypassedGuard, true);
  const spearState = duel(entry('Spear', 'spear', 'light', slow), entry('Sword', 'sword', 'light', stats));
  assert.deepEqual(resolveRound(spearState, ['technique', 'strike']).lastRound.order, [0, 1]);
  const axeState = duel(entry('Axe', 'axe', 'light', stats), entry('Sword', 'sword', 'light', slow));
  assert.deepEqual(resolveRound(axeState, ['technique', 'strike']).lastRound.order, [1, 0]);
  assert.equal(resolveRound(axeState, ['technique', 'guard']).lastRound.events.find((event) => event.type === 'attack').bypassedGuard, true);
});

test('flails bypass Guard, while halberds and maces pressure armor with a guarded counter', () => {
  const incoming = (weapon, armor, response = 'recover') => {
    const state = duel(entry('Attacker', weapon), entry('Defender', 'sword', armor));
    const resolved = resolveRound(state, ['technique', response]);
    return resolved.lastRound.events.find(event => event.type === 'attack' && event.actor === 0);
  };
  const flailOpen = incoming('flail', 'heavy');
  const flailGuarded = incoming('flail', 'heavy', 'guard');
  assert.equal(flailGuarded.damage, flailOpen.damage);
  assert.equal(flailGuarded.bypassedGuard, true);
  assert.equal(incoming('flail', 'light').damage - flailOpen.damage, 6);
  assert.equal(incoming('halberd', 'light').damage - incoming('halberd', 'heavy').damage, 1);
  assert.equal(incoming('mace', 'light').damage, incoming('mace', 'heavy').damage);
  for (const weapon of ['halberd', 'mace', 'greatsword']) {
    const open = incoming(weapon, 'heavy');
    const guarded = incoming(weapon, 'heavy', 'guard');
    assert.ok(guarded.damage < open.damage, `${weapon} must retain a Guard counter`);
    assert.equal(guarded.bypassedGuard, false);
  }
});

test('new weapon power has initiative and stamina tradeoffs, preserving the original choices', () => {
  const options = weapon => getActionOptions(duel(entry('A', weapon), entry('B')), 0);
  const sword = options('sword');
  const spear = options('spear');
  const axe = options('axe');
  const flail = options('flail');
  const halberd = options('halberd');
  const mace = options('mace');
  const greatsword = options('greatsword');
  assert.ok(flail[0].damage > sword[0].damage && flail[0].cost > sword[0].cost);
  assert.ok(flail[1].damage < axe[1].damage && flail[1].cost < axe[1].cost && flail[1].priority > axe[1].priority);
  assert.ok(halberd[1].priority < spear[1].priority && halberd[1].cost > spear[1].cost);
  assert.ok(mace[0].damage < axe[0].damage && mace[0].cost < axe[0].cost);
  assert.ok(greatsword[0].damage > axe[0].damage && greatsword[0].cost > axe[0].cost);
  assert.ok(WEAPONS.greatsword.speedBonus < WEAPONS.axe.speedBonus);
  assert.ok(Object.entries(WEAPONS).filter(([id]) => id !== 'dagger').every(([, weapon]) => weapon.speedBonus <= WEAPONS.spear.speedBonus));
  assert.deepEqual(Object.keys(WEAPONS), ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger']);
});

test('full helmets are validated cosmetic choices and preserve all combat outcomes', () => {
  const baseline = duel(entry('A', 'halberd', 'medium'), entry('B', 'flail', 'heavy'));
  assert.equal(baseline.fighters[0].helmet, 'none');
  const withoutHelmet = state => {
    const copy = structuredClone(state);
    copy.fighters.forEach(fighter => { delete fighter.helmet; });
    return copy;
  };
  for (const helmet of Object.keys(HELMETS)) {
    let original = baseline;
    let covered = duel({ ...entry('A', 'halberd', 'medium'), helmet }, { ...entry('B', 'flail', 'heavy'), helmet });
    assert.equal(covered.fighters[0].helmet, helmet);
    while (original.status === 'active') {
      assert.deepEqual(getActionOptions(covered, 0), getActionOptions(original, 0));
      const actions = [chooseCpuAction(original, 0), chooseCpuAction(original, 1)];
      assert.deepEqual([chooseCpuAction(covered, 0), chooseCpuAction(covered, 1)], actions);
      original = resolveRound(original, actions);
      covered = resolveRound(covered, actions);
      assert.deepEqual(withoutHelmet(covered), withoutHelmet(original));
    }
  }
  assert.throws(() => duel({ ...entry('A'), helmet: 'unknown' }), /helmet/);
  assert.throws(() => duel({ ...entry('A'), helmet: '__proto__' }), /helmet/);
});

test('equal priority uses speed; equal speed alternates by round without randomness', () => {
  const first = duel();
  const roundOne = resolveRound(first, ['strike', 'strike']);
  assert.deepEqual(roundOne.lastRound.order, [0, 1]);
  const roundTwo = resolveRound(roundOne, ['strike', 'strike']);
  assert.deepEqual(roundTwo.lastRound.order, [1, 0]);
  const faster = duel(entry('Fast', 'sword', 'light', swift), entry('Slow', 'sword', 'light', strong));
  assert.deepEqual(resolveRound(faster, ['strike', 'strike']).lastRound.order, [0, 1]);
  assert.deepEqual(resolveRound(first, ['strike', 'strike']), roundOne);
});

test('stamina rejects unaffordable commitments atomically; Recover is always available and capped', () => {
  const low = edited(duel(), (state) => { state.fighters[0].stamina = 0; });
  const snapshot = structuredClone(low);
  assert.throws(() => resolveRound(low, ['strike', 'strike']), /cannot afford/);
  assert.deepEqual(low, snapshot);
  assert.deepEqual(getActionOptions(low, 0).filter((action) => action.enabled).map((action) => action.id), ['recover']);
  const recovered = resolveRound(low, ['recover', 'guard']);
  assert.equal(recovered.fighters[0].stamina, 10);
  const full = resolveRound(duel(), ['recover', 'recover']);
  assert.equal(full.fighters[0].stamina, full.fighters[0].maxStamina);
});

test('resolution never mutates inputs and deeply freezes states, options, and logs', () => {
  const original = duel();
  const snapshot = structuredClone(original);
  const resolved = resolveRound(original, ['strike', 'guard']);
  assert.deepEqual(original, snapshot);
  assert.notEqual(original, resolved);
  assert.ok(Object.isFrozen(resolved.fighters[0].character.stats));
  assert.ok(Object.isFrozen(resolved.lastRound.events));
  assert.ok(Object.isFrozen(getActionOptions(original, 0)[0]));
  assert.throws(() => { resolved.fighters[0].hp = 999; }, TypeError);
});

test('lethal first action prevents defeated fighter spending stamina or acting', () => {
  const state = edited(duel(entry('Fast', 'spear'), entry('Slow', 'axe')), (copy) => { copy.fighters[1].hp = 1; });
  const resolved = resolveRound(state, ['technique', 'strike']);
  assert.equal(resolved.status, 'complete');
  assert.deepEqual(resolved.result, { winner: 0, reason: 'knockout' });
  assert.equal(resolved.fighters[1].hp, 0);
  assert.equal(resolved.fighters[1].stamina, state.fighters[1].stamina);
  assert.equal(resolved.lastRound.events.filter((event) => event.type === 'attack').length, 1);
  assert.equal(resolved.lastRound.events.filter((event) => event.type === 'skipped').length, 1);
  assert.throws(() => resolveRound(resolved, ['recover', 'recover']), /already ended/);
  assert.ok(getActionOptions(resolved, 0).every((action) => !action.enabled));
});

test('round limits end stalling with proportional health, stamina tiebreak, or a draw', () => {
  let state = duel();
  for (let i = 0; i < RULES.MAX_ROUNDS; i += 1) state = resolveRound(state, ['recover', 'recover']);
  assert.equal(state.status, 'complete');
  assert.equal(state.round, RULES.MAX_ROUNDS);
  assert.deepEqual(state.result, { winner: null, reason: 'draw' });
  const wounded = edited(duel(entry('A'), entry('B'), { maxRounds: 1 }), (copy) => { copy.fighters[0].hp -= 1; });
  assert.deepEqual(resolveRound(wounded, ['recover', 'recover']).result, { winner: 1, reason: 'round-limit' });
  const stamina = duel(entry('A'), entry('B'), { maxRounds: 1 });
  assert.deepEqual(resolveRound(stamina, ['guard', 'recover']).result, { winner: 1, reason: 'round-limit' });
  // A lower absolute HP total can still win on health percentage.
  const proportional = edited(duel(entry('A', 'sword', 'light', swift), entry('B', 'sword', 'light', strong), { maxRounds: 1 }), (copy) => { copy.fighters[0].hp = 39; copy.fighters[1].hp = 40; });
  assert.deepEqual(resolveRound(proportional, ['recover', 'recover']).result, { winner: 0, reason: 'round-limit' });
});

test('CPU depends on public state and revealed history, never attached pending secret choices', () => {
  for (const weapon of Object.keys(WEAPONS)) {
    const state = duel(entry('A'), entry('B', weapon));
    const a = edited(state, (copy) => { copy.pendingActions = ['guard', null]; copy.secret = { selectedAction: 'guard' }; });
    const b = edited(state, (copy) => { copy.pendingActions = ['technique', null]; copy.secret = { selectedAction: 'technique' }; });
    assert.equal(chooseCpuAction(a, 1), chooseCpuAction(b, 1));
    const low = edited(state, (copy) => { copy.fighters[1].stamina = 0; });
    assert.equal(chooseCpuAction(low, 1), 'recover');
  }
});

test('Strength and Dexterity have different weapon affinities; heavy handling has real thresholds', () => {
  const precise = { ...strong, strength: 2, dexterity: 8 };
  const derive = (stats, weapon, armor = 'light') => deriveFighterStats(character('A', stats), { weapon, armor });
  assert.ok(derive(strong, 'axe').strikePower > derive(precise, 'axe').strikePower);
  assert.ok(derive(precise, 'spear').strikePower > derive(strong, 'spear').strikePower);
  assert.ok(derive(precise, 'sword').techniquePower > derive(strong, 'sword').techniquePower);
  assert.ok(derive(strong, 'greatsword').techniquePower > derive(precise, 'greatsword').techniquePower);
  assert.ok(derive(strong, 'greatsword').speed > derive(precise, 'greatsword').speed);
  assert.ok(derive(strong, 'greatsword').strikeCost < derive(precise, 'greatsword').strikeCost);
  assert.equal(derive(strong, 'sword').strikeCost, derive(precise, 'sword').strikeCost);
  assert.equal(derive(strong, 'spear').speed, derive(precise, 'spear').speed);
  for (const weapon of Object.values(WEAPONS)) assert.ok(weapon.scaling && weapon.technique.scaling);
});

test('Speed determines equal-priority order and bounded recovery without changing attack power or action priority', () => {
  const quick = { ...balanced, speed: 8, defense: 0 };
  const slow = { ...balanced, speed: 0, defense: 8 };
  const state = duel(entry('Slow', 'sword', 'light', slow), entry('Quick', 'sword', 'light', quick));
  assert.equal(state.fighters[0].strikePower, state.fighters[1].strikePower);
  assert.equal(state.fighters[0].techniquePower, state.fighters[1].techniquePower);
  assert.equal(state.fighters[0].strikeCost, state.fighters[1].strikeCost);
  assert.equal(state.fighters[0].maxStamina, state.fighters[1].maxStamina);
  assert.deepEqual(resolveRound(state, ['strike', 'strike']).lastRound.order, [1, 0]);
  assert.deepEqual(resolveRound(state, ['guard', 'strike']).lastRound.order, [0, 1]);
  const depleted = edited(state, copy => { copy.fighters.forEach(fighter => { fighter.stamina = 0; }); });
  const recovered = resolveRound(depleted, ['recover', 'recover']);
  assert.deepEqual(recovered.fighters.map(fighter => fighter.stamina), [8, 12]);
  const capped = resolveRound(recovered, ['recover', 'recover']);
  assert.ok(capped.fighters.every(fighter => fighter.stamina === fighter.maxStamina));
});

test('Defense improves health and armor effectiveness while piercing retains personal protection', () => {
  const protectedStats = { ...balanced, defense: 8, speed: 0 };
  const vulnerableStats = { ...balanced, defense: 0, speed: 8 };
  const derive = (stats, armor) => deriveFighterStats(character('A', stats), { weapon: 'sword', armor });
  const light = derive(protectedStats, 'light');
  const medium = derive(protectedStats, 'medium');
  const heavy = derive(protectedStats, 'heavy');
  assert.ok(light.maxHp > derive(vulnerableStats, 'light').maxHp);
  assert.equal(light.personalProtection, 2);
  assert.equal(light.armorProtection, 0);
  assert.equal(medium.armorProtection, 4);
  assert.equal(heavy.armorProtection, 8);
  assert.ok(heavy.mitigation > derive(vulnerableStats, 'heavy').mitigation);
  const state = duel(entry('Mace', 'mace'), entry('Tank', 'sword', 'heavy', protectedStats));
  assert.equal(getActionOptions(state, 0)[1].damage, state.fighters[0].techniquePower - state.fighters[1].personalProtection);
  assert.ok(getActionOptions(state, 1)[0].cost > getActionOptions(duel(entry('Tank', 'sword', 'light', protectedStats)), 0)[0].cost);
});

test('Intelligence provides efficient techniques and modest deterministic all-round fortune', () => {
  // Hold offensive attributes and Speed fixed to isolate Intelligence's
  // fortune and tactical effects from Speed's separate physical recovery.
  const clever = { strength: 4, dexterity: 4, speed: 4, defense: 0, intelligence: 8 };
  const plain = { strength: 4, dexterity: 4, speed: 4, defense: 8, intelligence: 0 };
  const a = deriveFighterStats(character('A', clever), { weapon: 'sword', armor: 'light' });
  const b = deriveFighterStats(character('B', plain), { weapon: 'sword', armor: 'light' });
  assert.equal(a.fortuneBonus, 1);
  assert.equal(b.fortuneBonus, 0);
  assert.equal(a.strikePower - b.strikePower, 1);
  assert.equal(a.techniquePower - b.techniquePower, 3);
  assert.equal(a.strikeCost, 2);
  assert.equal(a.techniqueCost, 3);
  assert.ok(a.maxStamina > b.maxStamina && a.recovery > b.recovery);
  // Investing in fortune still trades away specialized Defense power.
  assert.ok(a.maxHp < b.maxHp && a.mitigation <= b.mitigation);
  assert.equal(a.speed, b.speed + 1);
  assert.deepEqual(deriveFighterStats(character('A', clever), { weapon: 'sword', armor: 'light' }), a);
  assert.equal(a.maxHp, RULES.BASE_HP + 2 * clever.defense + 1);
  assert.equal(a.speed, 2 * clever.speed + 1);
  assert.equal(a.personalProtection, 1);
  assert.equal(a.recovery, ARMORS.light.recovery + 2 + 1);
  const state = edited(duel(entry('Clever', 'sword', 'light', clever), entry('B')), copy => { copy.fighters[0].stamina = 0; });
  assert.equal(resolveRound(state, ['recover', 'guard']).fighters[0].stamina, a.recovery);
});

test('cost floors retain efficient-trait limits and Berserker costs after handling and Intelligence', () => {
  const efficient = { strength: 8, dexterity: 0, speed: 0, defense: 4, intelligence: 8 };
  for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) {
    const base = deriveFighterStats(character('A', efficient), { weapon, armor });
    for (const trait of Object.keys(TRAITS)) {
      const derived = deriveFighterStats(character('A', efficient, trait), { weapon, armor });
      assert.ok(derived.strikeCost >= 2);
      assert.ok(derived.techniqueCost >= 3);
      const moves = getActionOptions(duel(entry('A', weapon, armor, efficient, trait)), 0);
      assert.equal(moves[0].cost, derived.strikeCost);
      assert.equal(moves[1].cost, derived.techniqueCost);
      if (['berserker', 'brawler'].includes(trait)) assert.equal(derived.strikeCost, base.strikeCost + 1);
      if (['berserker', 'specialist'].includes(trait)) assert.equal(derived.techniqueCost, base.techniqueCost + 1);
      if (trait === 'efficient') {
        assert.equal(derived.strikeCost, Math.max(2, base.strikeCost - 1));
        assert.equal(derived.techniqueCost, Math.max(3, base.techniqueCost - 1));
      }
    }
  }
});

test('authoritative forfeits are immutable, retain health, and award no win for abandonment', () => {
  const active = duel();
  const snapshot = structuredClone(active);
  for (const loser of [0, 1, null]) {
    const result = forfeitDuel(active, loser);
    assert.deepEqual(active, snapshot);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.result, { winner: loser === null ? null : 1 - loser, reason: loser === null ? 'abandoned' : 'forfeit' });
    assert.deepEqual(result.fighters, active.fighters);
    assert.equal(result.log.at(-1).type, 'result');
    assert.ok(Object.isFrozen(result.result));
    assert.throws(() => forfeitDuel(result, loser), /already ended/);
    assert.ok(getActionOptions(result, 0).every(option => !option.enabled));
  }
  for (const value of [-1, 2, undefined, '0']) assert.throws(() => forfeitDuel(active, value), /index/);
});

test('default strong and swift builds each win across loadouts under two public policies and reversed seats', () => {
  const bruiser = strong;
  const loadouts = Object.keys(WEAPONS).flatMap((weapon) => Object.keys(ARMORS).map((armor) => ({ weapon, armor })));
  // The second policy favors damage per stamina, considers finishing blows, and
  // counters a revealed previous Guard. It receives no current opponent choice.
  const pressure = (state, index) => {
    const [strike, technique] = getActionOptions(state, index);
    const target = state.fighters[1 - index];
    if (!strike.enabled) return 'recover';
    if (technique.enabled && !technique.conditional && technique.priority > 0 && technique.damage >= target.hp) return 'technique';
    if (strike.damage >= target.hp) return 'strike';
    if (state.lastRound?.actions[1 - index] === 'guard' && technique.enabled && technique.guardedDamage === technique.damage) return 'technique';
    if (technique.enabled && !technique.conditional && technique.damage / technique.cost >= strike.damage / strike.cost) return 'technique';
    return 'strike';
  };
  for (const policy of [chooseCpuAction, pressure]) {
    const wins = [0, 0];
    for (const own of loadouts) for (const enemy of loadouts) for (const side of [0, 1]) {
      const strong = entry('Bruiser', own.weapon, own.armor, bruiser);
      const fast = entry('Swift', enemy.weapon, enemy.armor, swift);
      let state = createDuel(side === 0 ? [strong, fast] : [fast, strong]);
      while (state.status === 'active') state = resolveRound(state, [policy(state, 0), policy(state, 1)]);
      if (state.result.winner !== null) wins[state.result.winner === side ? 0 : 1] += 1;
    }
    // A broad regression gate prevents either preset reverting to winning nearly
    // every matchup. It intentionally does not certify a 50% balance target.
    const decided = wins[0] + wins[1];
    assert.ok(wins[0] / decided >= 0.12 && wins[1] / decided >= 0.12, `${policy.name}: Bruiser ${wins[0]}, Swift ${wins[1]}`);
  }
});

test('each attribute specialist has winning and losing matchups; fortune cannot dominate equal-loadout trials', () => {
  const keys = Object.keys(ATTRIBUTE_LABELS);
  const specialist = focus => Object.fromEntries(keys.map(key => [key, key === focus ? 8 : 3]));
  const loadouts = Object.keys(WEAPONS).flatMap(weapon => Object.keys(ARMORS).map(armor => ({ weapon, armor })));
  for (const focus of keys) {
    const wins = [0, 0];
    for (const other of keys) {
      if (other === focus) continue;
      for (const gear of loadouts) for (const side of [0, 1]) {
        const a = entry(focus, gear.weapon, gear.armor, specialist(focus));
        const b = entry(other, gear.weapon, gear.armor, specialist(other));
        let state = createDuel(side === 0 ? [a, b] : [b, a]);
        while (state.status === 'active') state = resolveRound(state, [chooseCpuAction(state, 0), chooseCpuAction(state, 1)]);
        if (state.result.winner !== null) wins[state.result.winner === side ? 0 : 1] += 1;
      }
    }
    // A loose regression gate catches broad dominance and entirely ineffective
    // stats; these deterministic policies do not certify human-play balance.
    const share = wins[0] / (wins[0] + wins[1]);
    assert.ok(share >= 0.08 && share <= 0.8, `${focus}: ${wins[0]} wins, ${wins[1]} losses`);
  }
});

test('all five-stat allocations validate; boundary builds across equipment and traits finish bounded duels', () => {
  const allocations = [];
  const enumerate = (values = []) => {
    if (values.length === 4) {
      const last = RULES.POINT_BUDGET - values.reduce((total, value) => total + value, 0);
      if (last >= 0 && last <= RULES.STAT_CAP) allocations.push(Object.fromEntries(Object.keys(ATTRIBUTE_LABELS).map((key, index) => [key, [...values, last][index]])));
      return;
    }
    for (let value = 0; value <= RULES.STAT_CAP; value += 1) enumerate([...values, value]);
  };
  enumerate();
  for (const stats of allocations) assert.equal(validateCharacter(character('A', stats)).valid, true);
  // Cover every attribute at its cap and zero, varied paired extremes, and a
  // deterministic spread of intermediate builds without hundreds of thousands of repeated duels.
  const representatives = [balanced, strong, swift, ...allocations.filter((stats, index) => index % 173 === 0 || Object.values(stats).filter(value => value === 8).length === 2)];
  let checked = 0;
  for (const stats of representatives) for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const trait of Object.keys(TRAITS)) {
    let state = duel(entry('A', weapon, armor, stats, trait), entry('B', 'sword', 'medium'));
    let rounds = 0;
    while (state.status === 'active') {
      const actions = [chooseCpuAction(state, 0), chooseCpuAction(state, 1)];
      for (let i = 0; i < 2; i += 1) assert.ok(getActionOptions(state, i).find((option) => option.id === actions[i]).enabled);
      state = resolveRound(state, actions);
      rounds += 1;
      assert.ok(rounds <= RULES.MAX_ROUNDS);
      for (const fighter of state.fighters) {
        assert.ok(fighter.hp >= 0 && fighter.hp <= fighter.maxHp);
        assert.ok(fighter.stamina >= 0 && fighter.stamina <= fighter.maxStamina);
      }
    }
    checked += 1;
  }
  assert.equal(allocations.length, 3951);
  assert.equal(checked, representatives.length * Object.keys(WEAPONS).length * Object.keys(ARMORS).length * Object.keys(TRAITS).length);
  assert.ok(checked >= 1764);
});

test('representative offensive duels last several decision rounds without routinely reaching the round cap', t => {
  const clever = { strength: 2, dexterity: 4, speed: 2, defense: 4, intelligence: 8 };
  const entries = [balanced, strong, swift, clever].flatMap(stats =>
    Object.keys(TRAITS).flatMap(trait => Object.keys(WEAPONS).flatMap(weapon =>
      Object.keys(ARMORS).map(armor => entry('Pacing', weapon, armor, stats, trait)))));
  const attackWhenAffordable = action => (state, index) => {
    const options = getActionOptions(state, index), chosen = options.find(option => option.id === action);
    // An offensive policy uses Strike instead of a stance which requires the
    // rival's Strike. Mutual Riposte stalling is tested as a bounded draw.
    const attack = chosen.conditional ? options.find(option => option.id === 'strike') : chosen;
    return attack.enabled ? attack.id : 'recover';
  };
  // Every weapon, armor, trait, and representative attribute build appears in
  // both seats. Include mirrors and two deterministic cross-build offsets.
  for (const [label, policy] of [['CPU', chooseCpuAction], ['Strike', attackWhenAffordable('strike')], ['Technique', attackWhenAffordable('technique')]]) {
    const lengths = [];
    const daggerLengths = [], legacyLengths = [];
    let knockouts = 0, capped = 0;
    for (let index = 0; index < entries.length; index += 1) for (const offset of [0, 137, 419]) {
      let state = createDuel([entries[index], entries[(index + offset) % entries.length]]), rounds = 0;
      while (state.status === 'active') {
        state = resolveRound(state, [policy(state, 0), policy(state, 1)]);
        rounds += 1;
      }
      lengths.push(rounds);
      (state.fighters.some(fighter => fighter.weapon === 'dagger') ? daggerLengths : legacyLengths).push(rounds);
      if (state.result.reason === 'knockout') knockouts += 1;
      if (rounds === RULES.MAX_ROUNDS) capped += 1;
    }
    lengths.sort((a, b) => a - b);
    const median = lengths[Math.floor(lengths.length / 2)];
    const metrics = values => {
      values.sort((a, b) => a - b);
      return { duels: values.length, capped: values.filter(value => value === RULES.MAX_ROUNDS).length,
        capRate: values.filter(value => value === RULES.MAX_ROUNDS).length / values.length,
        minimum: values[0], median: values[Math.floor(values.length / 2)], maximum: values.at(-1) };
    };
    t.diagnostic(JSON.stringify({ policy: label, full: metrics(lengths), legacy: metrics(legacyLengths), dagger: metrics(daggerLengths) }));
    assert.ok(median >= 8 && median <= 12, `${label} median ${median} rounds`);
    assert.ok(knockouts / lengths.length >= 0.97, `${label} must usually finish by knockout`);
    assert.ok(capped / lengths.length <= 0.02, `${label} must rarely hit the time limit`);
  }
});
