import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, resolveRound, WEAPONS } from '../src/combat.js';
import { buildAnimationSteps } from '../src/battle-animation.js';

const entry = (name, weapon = 'sword', armor = 'light') => ({
  character: { name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' }, weapon, armor,
});
const makeDuel = (a = entry('A'), b = entry('B')) => createDuel([a, b]);
const actionSteps = steps => steps.filter(step => ['attack', 'guard', 'recover'].includes(step.type));

test('playback follows resolved priority and speed, preserving guard and bypass details', () => {
  const before = makeDuel(entry('Sword'), entry('Spear', 'spear'));
  const after = resolveRound(before, ['technique', 'guard']);
  const steps = buildAnimationSteps(before, after, ['recover', 'recover']);
  assert.deepEqual(actionSteps(steps).map(step => [step.actor, step.type]), [[1, 'guard'], [0, 'attack']]);
  const attack = steps.find(step => step.type === 'attack');
  assert.equal(attack.weapon, 'sword');
  assert.equal(attack.action, 'technique');
  assert.equal(attack.bypassedGuard, true);
  assert.equal(attack.guarded, true);
  assert.equal(attack.targetHp, after.fighters[1].hp);
  assert.equal(attack.damage, after.lastRound.events.find(event => event.type === 'attack').damage);
  const swift = resolveRound(before, ['strike', 'technique']);
  assert.deepEqual(actionSteps(buildAnimationSteps(before, swift)).map(step => step.actor), [1, 0]);
});

test('lethal first attack includes defeat but never animates the canceled response', () => {
  const before = structuredClone(makeDuel(entry('Quick', 'spear'), entry('Slow', 'axe')));
  before.fighters[1].hp = 1;
  const after = resolveRound(before, ['technique', 'strike']);
  const steps = buildAnimationSteps(before, after);
  assert.deepEqual(steps.map(step => step.type), ['reveal', 'attack', 'defeat']);
  assert.equal(steps[1].actor, 0);
  assert.equal(steps[2].actor, 1);
  assert.equal(steps[1].targetHp, 0);
  assert.ok(after.lastRound.events.some(event => event.type === 'skipped'));
});

test('playback is isolated to this round, immutable, and reports actual capped recovery', () => {
  const initial = makeDuel();
  const before = resolveRound(initial, ['strike', 'strike']);
  const snapshot = structuredClone(before);
  const after = resolveRound(before, ['recover', 'recover']);
  const steps = buildAnimationSteps(before, after);
  assert.deepEqual(before, snapshot);
  assert.equal(steps.filter(step => step.type === 'attack').length, 0);
  assert.deepEqual(actionSteps(steps).map(step => [step.actor, step.restored]), [[1, 3], [0, 3]]);
  assert.ok(Object.isFrozen(steps));
  assert.ok(steps.every(Object.isFrozen));
  assert.deepEqual(buildAnimationSteps(initial, after), []);
  assert.deepEqual(buildAnimationSteps(before, { fighters: after.fighters }), []);
});

test('all new weapons retain their animation identity and use resolved guarded impacts', () => {
  for (const weapon of ['flail', 'halberd', 'mace', 'greatsword']) {
    const before = makeDuel(entry('Attacker', weapon), entry('Guard', 'sword', 'heavy'));
    const after = resolveRound(before, ['technique', 'guard']);
    const steps = buildAnimationSteps(before, after, ['strike', 'recover']);
    assert.deepEqual(actionSteps(steps).map(step => step.type), ['guard', 'attack']);
    const attack = steps.find(step => step.type === 'attack');
    assert.equal(attack.weapon, weapon);
    assert.equal(attack.action, 'technique');
    assert.equal(attack.guarded, true);
    assert.equal(attack.bypassedGuard, WEAPONS[weapon].technique.ignoresGuard);
    assert.equal(attack.targetHp, after.fighters[1].hp);
  }
});

test('knockouts cancel all slower new weapon responses before animation or stamina spending', () => {
  for (const weapon of ['flail', 'halberd', 'mace', 'greatsword']) {
    const before = structuredClone(makeDuel(entry('Quick', 'spear'), entry('Slow', weapon)));
    before.fighters[1].hp = 1;
    const after = resolveRound(before, ['technique', 'technique']);
    const steps = buildAnimationSteps(before, after);
    assert.deepEqual(steps.map(step => step.type), ['reveal', 'attack', 'defeat']);
    assert.equal(steps[1].weapon, 'spear');
    assert.equal(after.fighters[1].stamina, before.fighters[1].stamina);
    assert.ok(after.lastRound.events.some(event => event.type === 'skipped' && event.actor === 1));
  }
});
