import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, getActionOptions, getFighterStatus, resolveRound, forfeitDuel, chooseCpuAction, RULES, WEAPONS, ARMORS, BOT_STYLES } from '../src/combat.js';

const entry = (name, weapon = 'trident', armor = 'medium', stats = { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }) => ({
  character: { name, stats, trait: 'balanced', color: '#b87333' }, weapon, armor, helmet: 'none' });
const duel = (weapon = 'sword', armor = 'medium') => createDuel([entry('Netter'), entry('Rival', weapon, armor)]);
const option = (state, index, id) => getActionOptions(state, index).find(item => item.id === id);
const edit = (state, apply) => { const value = structuredClone(state); apply(value); return value; };

test('Entangle has disclosed low damage, cost, counters and exact damage previews across armor classes and seats', () => {
  for (const armor of Object.keys(ARMORS)) for (const side of [0, 1]) {
    const pair = [entry('Netter'), entry('Rival', 'sword', armor)], state = createDuel(side ? pair.reverse() : pair);
    const preview = option(state, side, 'technique'), strike = option(state, side, 'strike');
    assert.equal(preview.name, 'Entangle'); assert.equal(preview.cost, 6); assert.equal(preview.priority, 0);
    assert.equal(preview.statusEffect, 'entangle'); assert.equal(preview.attackSurcharge, 3); assert.ok(preview.damage < strike.damage);
    const actions = side ? ['strike', 'technique'] : ['technique', 'strike'], after = resolveRound(state, actions);
    const attack = after.lastRound.events.find(event => event.type === 'attack' && event.actor === side);
    assert.equal(attack.damage, preview.damage);
    assert.deepEqual(getFighterStatus(after, 1 - side), { id: 'entangled', label: 'Entangled', attackSurcharge: 3, clearsWith: ['guard', 'recover'], expiresAfterRound: 2 });
    assert.equal(option(after, 1 - side, 'strike').cost, after.fighters[1 - side].strikeCost + 3);
    assert.equal(option(after, 1 - side, 'technique').cost, after.fighters[1 - side].techniqueCost + 3);
    assert.equal(option(after, 1 - side, 'guard').cost, 2);
    assert.equal(option(after, 1 - side, 'recover').cost, 0);
  }
});

test('Guard reduces preview damage, prevents new nets and clears an existing net; Recover clears a newly landed net', () => {
  for (const reply of ['guard', 'recover']) {
    const state = duel(), after = resolveRound(state, ['technique', reply]);
    const attack = after.lastRound.events.find(event => event.type === 'attack');
    assert.equal(attack.damage, option(state, 0, 'technique')[reply === 'guard' ? 'guardedDamage' : 'damage']);
    assert.equal(getFighterStatus(after, 1), null); assert.equal(after.fighters[1].entangle, undefined);
    assert.ok(after.lastRound.events.some(event => event.type === (reply === 'guard' ? 'entangle-blocked' : 'entangle-clear')));
    const netted = resolveRound(state, ['technique', 'strike']);
    const cleared = resolveRound(netted, ['recover', reply]);
    assert.equal(getFighterStatus(cleared, 1), null);
    assert.ok(cleared.lastRound.events.some(event => event.type === 'entangle-clear' && event.actor === 1));
  }
});

test('next-round attack pays exactly the visible surcharge once; it expires without changing base derived stats', () => {
  const state = resolveRound(duel(), ['technique', 'strike']), base = state.fighters[1].strikeCost;
  const taxed = option(state, 1, 'strike'), before = state.fighters[1].stamina;
  const after = resolveRound(state, ['recover', 'strike']);
  assert.equal(after.fighters[1].stamina, before - taxed.cost);
  assert.equal(after.fighters[1].strikeCost, base); assert.equal(after.fighters[1].entangle, undefined);
  assert.equal(option(after, 1, 'strike').cost, base);
  assert.equal(state.fighters[1].entangle.round, 2, 'Resolution does not mutate its public input.');
});

test('a fighter who can pay the old cost but not the net surcharge cannot commit an attack', () => {
  const state = edit(resolveRound(duel(), ['technique', 'strike']), value => { value.fighters[1].stamina = value.fighters[1].strikeCost; });
  assert.equal(option(state, 1, 'strike').enabled, false);
  assert.throws(() => resolveRound(state, ['recover', 'strike']), /cannot afford/);
  assert.ok(option(state, 1, 'guard').enabled); assert.ok(option(state, 1, 'recover').enabled);
});

test('renewed nets replace their deadline and never add multiple surcharges', () => {
  const first = resolveRound(duel('trident'), ['technique', 'strike']);
  const funded = edit(first, value => { for (const fighter of value.fighters) fighter.stamina = fighter.maxStamina; });
  const after = resolveRound(funded, ['technique', 'technique']);
  assert.equal(after.fighters[1].entangle.attackSurcharge, 3); assert.equal(after.fighters[1].entangle.round, 3);
  assert.equal(option(after, 1, 'strike').cost, after.fighters[1].strikeCost + 3);
});

test('Riposte cannot parry Entangle, and nets cannot survive death, the round cap or a fresh duel', () => {
  const state = duel('dagger'), after = resolveRound(state, ['technique', 'technique']);
  assert.equal(after.lastRound.events.some(event => event.parried || event.counter), false);
  assert.equal(after.fighters[1].hp, state.fighters[1].hp - option(state, 0, 'technique').damage);
  const lethal = edit(duel(), value => { value.fighters[1].hp = 1; });
  assert.equal(resolveRound(lethal, ['technique', 'strike']).fighters[1].entangle, undefined);
  const capped = createDuel([entry('A'), entry('B', 'sword')], { maxRounds: 1 });
  assert.ok(resolveRound(capped, ['technique', 'strike']).fighters.every(fighter => !fighter.entangle));
  assert.ok(duel().fighters.every(fighter => !fighter.entangle));
  const forfeited = forfeitDuel(after, 1); assert.equal(getFighterStatus(forfeited, 1), null); assert.equal(forfeited.fighters[1].entangle, undefined);
});

test('trident techniques and public bot policies ignore all unrevealed intent fields', () => {
  const state = duel('trident');
  for (const hidden of ['strike', 'technique', 'guard', 'recover']) {
    const secret = edit(state, value => { value.pendingActions = [hidden, hidden]; value.secret = { action: hidden }; });
    assert.deepEqual(getActionOptions(secret, 0), getActionOptions(state, 0));
    for (const style of [undefined, ...Object.keys(BOT_STYLES)]) assert.equal(chooseCpuAction(secret, 0, style), chooseCpuAction(state, 0, style));
  }
});

test('trident public-policy matchups have victories and defeats in both seats and always terminate', t => {
  const totals = { duels: 0, wins: [0, 0], losses: [0, 0], draws: 0, capped: 0 };
  const builds = [{ strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, { strength: 2, dexterity: 8, speed: 6, defense: 2, intelligence: 2 }, { strength: 8, dexterity: 2, speed: 2, defense: 6, intelligence: 2 }];
  for (const stats of builds) for (const armor of Object.keys(ARMORS)) for (const weapon of Object.keys(WEAPONS)) for (const side of [0, 1]) for (const style of Object.keys(BOT_STYLES)) {
    const pair = [entry('Netter', 'trident', armor, stats), entry('Rival', weapon, armor, stats)];
    let state = createDuel(side ? pair.reverse() : pair), rounds = 0;
    while (state.status === 'active') {
      state = resolveRound(state, [chooseCpuAction(state, 0, style), chooseCpuAction(state, 1, style)]); rounds++;
      assert.ok(rounds <= RULES.MAX_ROUNDS);
      for (const fighter of state.fighters) assert.ok(fighter.hp >= 0 && fighter.hp <= fighter.maxHp && fighter.stamina >= 0 && fighter.stamina <= fighter.maxStamina);
    }
    totals.duels++; if (rounds === RULES.MAX_ROUNDS) totals.capped++;
    if (state.result.winner === side) totals.wins[side]++; else if (state.result.winner === null) totals.draws++; else totals.losses[side]++;
  }
  assert.ok(totals.wins.every(Boolean)); assert.ok(totals.losses.every(Boolean)); t.diagnostic(JSON.stringify(totals));
});
