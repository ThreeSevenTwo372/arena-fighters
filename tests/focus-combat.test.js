import test from 'node:test';
import assert from 'node:assert/strict';
import { RULES, WEAPONS, ARMORS, TRAITS, LEGACY_ATTRIBUTE_HELP as ATTRIBUTE_HELP, createDuel as createCurrentDuel, deriveFighterStats as deriveCurrentStats, getDefaultAction, getActionOptions, getFighterStatus, getFighterStatuses, resolveRound, forfeitDuel, chooseCpuAction } from '../src/combat.js';

// These fixtures protect retained v4 duels; new choice-time rules have their own suite.
const createDuel = (entries, options = {}) => createCurrentDuel(entries, { version: 4, ...options });
const deriveFighterStats = (character, loadout, options = {}) => deriveCurrentStats(character, loadout, { version: 4, ...options });

const balanced = { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 };
const entry = (name = 'A', weapon = 'sword', armor = 'medium', stats = balanced, trait = 'balanced') => ({ character: { name, stats, trait }, weapon, armor });
const duel = (a = entry(), b = entry('B'), options) => createDuel([a, b], options);
const option = (state, index, id) => getActionOptions(state, index).find(action => action.id === id);
const edit = (state, apply) => { const next = structuredClone(state); apply(next); return next; };
const focus = (state = duel()) => resolveRound(state, ['focus', 'focus']);

test('preserved v4 duels keep zero-stamina Focus and reject cross-version commands', () => {
  const current = duel(), legacy = duel(undefined, undefined, { version: 3 });
  assert.equal(current.version, 4);
  assert.equal(getDefaultAction(current), 'focus');
  assert.equal(getDefaultAction(legacy), 'recover');
  assert.deepEqual(getActionOptions(current, 0).map(action => action.id), ['strike', 'technique', 'guard', 'focus']);
  assert.deepEqual(getActionOptions(legacy, 0).map(action => action.id), ['strike', 'technique', 'guard', 'recover']);
  assert.equal(option(current, 0, 'focus').focusBonus, 3);
  assert.equal(option(current, 0, 'focus').priority, -2);
  assert.equal(option(current, 0, 'focus').cost, 0);
  assert.ok(getActionOptions(current, 0).every(action => action.rulesVersion === 4));
  assert.ok(getActionOptions(legacy, 0).every(action => action.rulesVersion === 3));
  assert.throws(() => resolveRound(current, ['recover', 'focus']), /Unknown action/);
  assert.throws(() => resolveRound(legacy, ['focus', 'recover']), /Unknown action/);
  assert.throws(() => duel(undefined, undefined, { version: 2 }), /Unsupported/);
});

test('Dexterity regenerates 2 or 3 stamina at disclosed thresholds, with bounded trait modifiers', () => {
  for (let dexterity = 0; dexterity <= 8; dexterity++) for (const trait of Object.keys(TRAITS)) {
    const stats = { strength: 8, dexterity, speed: 4, defense: 8 - dexterity, intelligence: 0 };
    const expected = Math.max(1, 2 + Math.floor(dexterity / 8) + (trait === 'vigorous' ? 1 : trait === 'ironhide' ? -1 : 0));
    for (const armor of Object.keys(ARMORS)) {
      const initial = duel(entry('A', 'sword', armor, stats, trait));
      assert.equal(initial.fighters[0].staminaRegen, expected);
      assert.equal(initial.fighters[0].recovery, undefined);
      const empty = edit(initial, state => { state.fighters[0].stamina = 0; });
      const resolved = resolveRound(empty, ['focus', 'focus']);
      assert.equal(resolved.fighters[0].stamina, expected);
      const events = resolved.lastRound.events.filter(event => event.type === 'stamina-regeneration' && event.actor === 0);
      assert.equal(events.length, 1);
      assert.deepEqual([events[0].restored, events[0].regeneration], [expected, expected]);
    }
  }
  assert.match(ATTRIBUTE_HELP.dexterity, /plus 1 at 8 Dexterity/);
  assert.match(ATTRIBUTE_HELP.speed, /costs -1 per 4 Speed/);
  assert.doesNotMatch(ATTRIBUTE_HELP.speed, /recovery/);
  assert.doesNotMatch(ATTRIBUTE_HELP.intelligence, /recovery/);
  assert.match(TRAITS.ironhide.description, /regeneration -1 \(minimum 1\)/);
  assert.match(TRAITS.vigorous.description, /regeneration \+1/);
});

test('the stamina redesign preserves every non-resource derived attribute, armor, and trait effect', () => {
  for (const trait of Object.keys(TRAITS)) for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) {
    const { character } = entry('A', weapon, armor, balanced, trait);
    const legacy = { ...deriveFighterStats(character, { weapon, armor }, { version: 3 }) };
    const current = { ...deriveFighterStats(character, { weapon, armor }) };
    delete legacy.recovery; delete current.staminaRegen;
    delete legacy.strikeCost; delete legacy.techniqueCost; delete current.strikeCost; delete current.techniqueCost;
    assert.deepEqual(current, legacy, `${trait}/${weapon}/${armor}`);
  }
  const highSpeed = { strength: 0, dexterity: 4, speed: 8, defense: 4, intelligence: 4 };
  const highIntelligence = { strength: 4, dexterity: 4, speed: 0, defense: 4, intelligence: 8 };
  assert.equal(duel(entry('A', 'sword', 'light', highSpeed)).fighters[0].staminaRegen, 2);
  assert.equal(duel(entry('A', 'sword', 'light', highIntelligence)).fighters[0].staminaRegen, 2);
});

test('Speed reduces attack costs before trait modifiers while preserving Guard and attack floors', () => {
  for (const speed of [0, 3, 4, 7, 8]) for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const trait of Object.keys(TRAITS)) {
    const stats = { strength: 8, dexterity: 4, speed, defense: 8 - speed, intelligence: 0 };
    const state = duel(entry('A', weapon, armor, stats, trait));
    const definition = WEAPONS[weapon], outfit = ARMORS[armor], modifiers = TRAITS[trait];
    const attributeDiscount = (definition.heavyHandling ? 1 : 0) + Math.floor(speed / 4);
    const strike = Math.max(2, Math.max(2, definition.strikeCost + outfit.attackSurcharge - attributeDiscount) + modifiers.strikeCostBonus);
    const technique = Math.max(3, Math.max(3, definition.technique.cost + outfit.attackSurcharge - attributeDiscount) + modifiers.techniqueCostBonus);
    assert.equal(option(state, 0, 'strike').cost, strike, `${speed}/${weapon}/${armor}/${trait}`);
    assert.equal(option(state, 0, 'technique').cost, technique);
    assert.equal(option(state, 0, 'guard').cost, 2);
    assert.equal(option(state, 0, 'focus').cost, 0);
    assert.ok(strike >= 2 && technique >= 3);
    if (trait === 'berserker') assert.ok(strike >= 3 && technique >= 4, 'Its trait surcharge follows the attribute floors.');
  }
  const berserker = duel(entry('A', 'sword', 'light', balanced, 'berserker'));
  assert.deepEqual(['strike', 'technique'].map(id => option(berserker, 0, id).cost), [3, 4]);
});

test('round-end regeneration follows attack payment exactly once and clamps to maximum stamina', () => {
  const initial = duel(), snapshot = structuredClone(initial);
  const resolved = resolveRound(initial, ['strike', 'guard']);
  assert.equal(resolved.fighters[0].stamina, initial.fighters[0].stamina - option(initial, 0, 'strike').cost + 2);
  assert.equal(resolved.fighters[1].stamina, initial.fighters[1].stamina);
  const partial = edit(initial, state => { state.fighters[0].stamina -= 1; });
  const restored = resolveRound(partial, ['focus', 'focus']);
  assert.equal(restored.fighters[0].stamina, restored.fighters[0].maxStamina);
  assert.equal(restored.lastRound.events.find(event => event.type === 'stamina-regeneration' && event.actor === 0).restored, 1);
  assert.equal(resolveRound(initial, ['focus', 'focus']).lastRound.events.find(event => event.type === 'stamina-regeneration').restored, 0);
  assert.deepEqual(resolveRound(initial, ['strike', 'guard']), resolved);
  assert.deepEqual(initial, snapshot);
  const low = edit(initial, state => { state.fighters[0].stamina = 1; });
  assert.throws(() => resolveRound(low, ['guard', 'focus']), /cannot afford Guard; choose Focus/);
  assert.deepEqual(getActionOptions(low, 0).filter(action => action.enabled).map(action => action.id), ['focus']);
});

test('only surviving fighters regenerate after a lethal round, and a defeated Focus never executes', () => {
  const initial = edit(duel(), state => { state.fighters[1].hp = 1; state.fighters[1].stamina = 0; });
  const resolved = resolveRound(initial, ['strike', 'focus']);
  assert.equal(resolved.status, 'complete');
  assert.equal(resolved.fighters[0].stamina, initial.fighters[0].stamina - option(initial, 0, 'strike').cost + 2);
  assert.equal(resolved.fighters[1].stamina, 0);
  assert.deepEqual(resolved.lastRound.events.filter(event => event.type === 'stamina-regeneration').map(event => event.actor), [0]);
  assert.ok(resolved.lastRound.events.some(event => event.type === 'skipped' && event.actor === 1));
  assert.equal(resolved.lastRound.events.some(event => event.type === 'focus'), false);
  assert.ok(resolved.fighters.every(fighter => !fighter.focus && !fighter.entangle));
  assert.throws(() => resolveRound(resolved, ['focus', 'focus']), /already ended/);
});

test('regeneration is applied before the round-limit stamina tiebreak', () => {
  // Equal health, maxSP and pre-regeneration SP. DEX8 regenerates3 versus
  // DEX0 regenerates2, so the final verdict is A instead of an exact draw.
  const highDex = { strength: 4, dexterity: 8, speed: 4, defense: 4, intelligence: 0 };
  const lowDex = { strength: 8, dexterity: 0, speed: 4, defense: 4, intelligence: 4 };
  const initial = edit(duel(entry('A', 'sword', 'medium', highDex), entry('B', 'sword', 'medium', lowDex), { maxRounds: 1 }), state => {
    state.fighters[0].stamina = 2; state.fighters[1].stamina = 2;
  });
  const resolved = resolveRound(initial, ['focus', 'focus']);
  assert.deepEqual(resolved.fighters.map(fighter => fighter.stamina), [5, 4]);
  assert.deepEqual(resolved.result, { winner: 0, reason: 'round-limit' });
  assert.ok(resolved.lastRound.events.findIndex(event => event.type === 'stamina-regeneration') < resolved.lastRound.events.findIndex(event => event.type === 'result'));
  assert.deepEqual(getFighterStatuses(resolved, 0), []);
});

test('Focus is open to attacks, prepares only the following round and refreshes without stacking', () => {
  const initial = duel(), incoming = option(initial, 1, 'strike').damage;
  const prepared = resolveRound(initial, ['focus', 'strike']);
  assert.equal(prepared.fighters[0].hp, initial.fighters[0].hp - incoming);
  assert.deepEqual(getFighterStatuses(prepared, 0), [{ id: 'focused', label: 'Focused', damageBonus: 3, expiresAfterRound: 2 }]);
  assert.equal(getFighterStatus(prepared, 0), null, 'The original net-only accessor retains its contract.');
  assert.equal(option(prepared, 0, 'strike').damage, option(initial, 0, 'strike').damage + 3);
  const refreshed = resolveRound(prepared, ['focus', 'focus']);
  assert.deepEqual(getFighterStatuses(refreshed, 0), [{ id: 'focused', label: 'Focused', damageBonus: 3, expiresAfterRound: 3 }]);
  assert.equal(option(refreshed, 0, 'strike').focusDamageBonus, 3);
  const guarded = resolveRound(refreshed, ['guard', 'guard']);
  assert.equal(guarded.fighters[0].focus, undefined);
  assert.equal(option(guarded, 0, 'strike').focusDamageBonus, undefined);
  assert.equal(guarded.lastRound.events.some(event => event.type === 'focus-used'), false);
});

test('Focused Strike and direct Techniques match previews before armor, Guard, and both arena seats', () => {
  for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const side of [0, 1]) {
    const pair = [entry('Focused', weapon), entry('Target', 'sword', armor)];
    const prepared = focus(createDuel(side ? pair.reverse() : pair));
    for (const action of ['strike', 'technique']) {
      if (action === 'technique' && WEAPONS[weapon].technique.conditional) continue;
      for (const response of ['focus', 'guard']) {
        const preview = option(prepared, side, action);
        const commands = side ? [response, action] : [action, response];
        const resolved = resolveRound(prepared, commands);
        const hit = resolved.lastRound.events.find(event => event.type === 'attack' && event.actor === side);
        assert.equal(hit.damage, response === 'guard' ? preview.guardedDamage : preview.damage, `${weapon}/${armor}/${side}/${action}/${response}`);
        assert.equal(resolved.fighters[side].focus, undefined);
        assert.equal(resolved.lastRound.events.filter(event => event.type === 'focus-used' && event.actor === side).length, 1);
      }
    }
  }
});

test('Focus does not trigger Riposte, and a prepared Riposte boosts only its surviving counter', () => {
  for (const side of [0, 1]) {
    const pair = [entry('Riposter', 'dagger'), entry('Rival')];
    const initial = createDuel(side ? pair.reverse() : pair);
    const noCounter = resolveRound(initial, side ? ['focus', 'technique'] : ['technique', 'focus']);
    assert.equal(noCounter.lastRound.events.some(event => event.counter), false);
    const prepared = focus(initial), preview = option(prepared, side, 'technique');
    const resolved = resolveRound(prepared, side ? ['strike', 'technique'] : ['technique', 'strike']);
    assert.equal(resolved.lastRound.events.find(event => event.counter).damage, preview.damage);
    assert.equal(resolved.fighters[side].focus, undefined);
    const missed = resolveRound(prepared, side ? ['guard', 'technique'] : ['technique', 'guard']);
    assert.equal(missed.lastRound.events.some(event => event.counter), false);
    assert.equal(missed.fighters[side].focus, undefined);
    const lethal = edit(prepared, state => { state.fighters[side].hp = 1; });
    assert.equal(resolveRound(lethal, side ? ['strike', 'technique'] : ['technique', 'strike']).lastRound.events.some(event => event.counter), false);
  }
});

test('net and Focus statuses remain separately visible; Focus clears the net and neither crosses duel boundaries', () => {
  const initial = edit(duel(), state => {
    state.fighters[0].entangle = { round: 1, attackSurcharge: 3 };
    state.fighters[0].focus = { round: 1, damageBonus: 3 };
    state.fighters[0].stamina = 0;
  });
  assert.deepEqual(getFighterStatuses(initial, 0).map(status => status.id), ['entangled', 'focused']);
  assert.equal(option(initial, 0, 'strike').cost, 5);
  assert.equal(option(initial, 0, 'strike').focusDamageBonus, 3);
  assert.equal(option(initial, 0, 'focus').enabled, true);
  const resolved = resolveRound(initial, ['focus', 'focus']);
  assert.equal(resolved.fighters[0].entangle, undefined);
  assert.deepEqual(getFighterStatuses(resolved, 0).map(status => status.id), ['focused']);
  assert.ok(resolved.lastRound.events.some(event => event.type === 'entangle-clear' && event.action === 'focus'));
  const forfeited = forfeitDuel(initial, 0);
  assert.ok(forfeited.fighters.every(fighter => !fighter.focus && !fighter.entangle));
  assert.equal(forfeited.fighters[0].stamina, 0, 'Forfeit is not a resolved round and grants no regeneration.');
  assert.ok(duel().fighters.every(fighter => !fighter.focus && !fighter.entangle));
  const expired = edit(initial, state => { state.round = 2; });
  assert.deepEqual(getFighterStatuses(expired, 0), []);
});

test('v3 Recover, recovery bonuses, costs, and net counters retain their old resolution without passive refill', () => {
  const legacy = duel(entry('A', 'trident', 'heavy', balanced, 'ironhide'), entry('B', 'dagger', 'light', balanced, 'vigorous'), { version: 3 });
  assert.equal(legacy.fighters[0].recovery, 6);
  assert.equal(legacy.fighters[1].recovery, 12);
  assert.equal(legacy.fighters[0].staminaRegen, undefined);
  const attacking = resolveRound(legacy, ['strike', 'recover']);
  assert.equal(attacking.fighters[0].stamina, legacy.fighters[0].stamina - option(legacy, 0, 'strike').cost);
  assert.equal(attacking.lastRound.events.some(event => event.type === 'stamina-regeneration'), false);
  const empty = edit(legacy, state => { state.fighters[0].stamina = 0; state.fighters[1].stamina = 0; });
  assert.deepEqual(resolveRound(empty, ['recover', 'recover']).fighters.map(fighter => fighter.stamina), [6, 12]);
  const netted = resolveRound(legacy, ['technique', 'strike']);
  assert.deepEqual(getFighterStatus(netted, 1).clearsWith, ['guard', 'recover']);
  assert.equal(resolveRound(netted, ['recover', 'recover']).fighters[1].entangle, undefined);
});

test('public CPU policies use legal Focus decisions and spend the prepared bonus instead of repeatedly waiting', () => {
  const initial = duel(entry('A', 'greatsword'), entry('B'));
  const low = edit(initial, state => { state.fighters[0].stamina = 0; });
  for (const style of [undefined, 'aggressive', 'cautious', 'patient']) {
    assert.equal(chooseCpuAction(low, 0, style), 'focus');
    const prepared = edit(focus(initial), state => { state.fighters[0].stamina = state.fighters[0].strikeCost; });
    assert.equal(chooseCpuAction(prepared, 0, style), 'strike');
    const secret = edit(prepared, state => { state.pendingActions = ['focus', 'technique']; state.secret = { action: 'strike' }; });
    assert.deepEqual(getActionOptions(secret, 0), getActionOptions(prepared, 0));
    assert.equal(chooseCpuAction(secret, 0, style), chooseCpuAction(prepared, 0, style));
  }
});

test('default-v4 attribute specialists all win and lose public-policy trials without broad Dexterity dominance', t => {
  const keys = ['strength', 'dexterity', 'speed', 'defense', 'intelligence'];
  const specialist = key => Object.fromEntries(keys.map(stat => [stat, stat === key ? 8 : 3]));
  const totals = {};
  for (const key of keys) {
    const result = { wins: 0, losses: 0, draws: 0, capped: 0 };
    for (const style of ['aggressive', 'cautious', 'patient']) for (const other of keys.filter(stat => stat !== key)) for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const side of [0, 1]) {
      const pair = [entry(key, weapon, armor, specialist(key)), entry(other, weapon, armor, specialist(other))];
      let state = createDuel(side ? pair.reverse() : pair), rounds = 0;
      while (state.status === 'active') {
        const actions = state.fighters.map((_, index) => chooseCpuAction(state, index, style));
        for (const [index, action] of actions.entries()) assert.ok(option(state, index, action).enabled);
        state = resolveRound(state, actions); rounds++;
        assert.ok(rounds <= RULES.MAX_ROUNDS);
        for (const fighter of state.fighters) assert.ok(fighter.stamina >= 0 && fighter.stamina <= fighter.maxStamina && fighter.hp >= 0 && fighter.hp <= fighter.maxHp);
      }
      if (rounds === RULES.MAX_ROUNDS) result.capped++;
      if (state.result.winner === null) result.draws++;
      else if (state.result.winner === side) result.wins++;
      else result.losses++;
    }
    totals[key] = result;
    t.diagnostic(`${key}: ${JSON.stringify(result)}`);
  }
  // These bounded deterministic trials catch gross regressions; they do not
  // establish competitive balance or replace a human playtest.
  t.diagnostic(JSON.stringify(totals));
  for (const [key, result] of Object.entries(totals)) {
    const share = result.wins / (result.wins + result.losses);
    assert.ok(share >= 0.05 && share <= 0.85, `${key}: ${JSON.stringify(result)}`);
  }
});

test('default-v4 all weapon, armor and trait combinations terminate under each bot style', t => {
  const totals = {};
  for (const style of ['aggressive', 'cautious', 'patient']) {
    const result = { duels: 0, wins: 0, losses: 0, draws: 0, capped: 0 };
    for (const trait of Object.keys(TRAITS)) for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const side of [0, 1]) {
      const pair = [entry('Own', weapon, armor, balanced, trait), entry('Rival', 'sword', 'medium')];
      let state = createDuel(side ? pair.reverse() : pair), rounds = 0;
      while (state.status === 'active') {
        const actions = state.fighters.map((_, index) => chooseCpuAction(state, index, style));
        for (const [index, action] of actions.entries()) assert.ok(option(state, index, action).enabled);
        state = resolveRound(state, actions); rounds++;
        assert.ok(rounds <= RULES.MAX_ROUNDS);
        for (const fighter of state.fighters) assert.ok(fighter.stamina >= 0 && fighter.stamina <= fighter.maxStamina);
      }
      result.duels++;
      if (rounds === RULES.MAX_ROUNDS) result.capped++;
      if (state.result.winner === null) result.draws++;
      else if (state.result.winner === side) result.wins++;
      else result.losses++;
    }
    assert.ok(result.wins && result.losses);
    totals[style] = result;
  }
  t.diagnostic(JSON.stringify(totals));
});
