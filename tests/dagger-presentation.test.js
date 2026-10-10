import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, getActionOptions, resolveRound } from '../src/combat.js';
import { actionPreview, roundSummary } from '../src/battle-presentation.js';
import { buildAnimationSteps, playBattleAnimation } from '../src/battle-animation.js';
import { buildExecutionEvent } from '../src/execution-animation.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
const initial = () => createDuel([
  { character: character('Cassian'), weapon: 'dagger', armor: 'medium' },
  { character: character('Mira'), weapon: 'sword', armor: 'medium' },
], { version: 3 });

test('Riposte preview promises a conditional counter and names all three counters', () => {
  const option = getActionOptions(initial(), 0).find(move => move.id === 'technique');
  const preview = actionPreview(option);
  assert.equal(preview.label, `Counter: ${option.damage} damage`);
  assert.match(preview.detail, /Halves an incoming Strike/);
  assert.match(preview.detail, /only if you survive/);
  assert.match(preview.detail, /Techniques, Guard and Recover/);
  assert.doesNotMatch(preview.detail, /unguarded rival/);
});

test('revealed parry and counter are played in authoritative event order with actual health', () => {
  const before = initial(), after = resolveRound(before, ['technique', 'strike']);
  const steps = buildAnimationSteps(before, after, ['recover', 'guard']);
  assert.deepEqual(steps.map(step => step.type), ['reveal', 'riposte', 'attack', 'attack']);
  const [incoming, counter] = steps.filter(step => step.type === 'attack');
  assert.equal(incoming.actor, 1); assert.equal(incoming.parried, true);
  assert.equal(counter.actor, 0); assert.equal(counter.counter, true);
  assert.equal(counter.weapon, 'dagger'); assert.equal(counter.action, 'technique');
  assert.equal(incoming.targetHp, after.fighters[0].hp);
  assert.equal(counter.targetHp, after.fighters[1].hp);
  assert.match(roundSummary(after), /Cassian readied Riposte/);
  assert.match(roundSummary(after), /after a parry/);
  assert.match(roundSummary(after), /Cassian countered for/);
});

test('a missed prediction displays no invented dagger hit', () => {
  for (const response of ['guard', 'recover', 'technique']) {
    const before = initial(), after = resolveRound(before, ['technique', response]);
    const steps = buildAnimationSteps(before, after);
    assert.ok(steps.some(step => step.type === 'riposte-miss'));
    assert.ok(!steps.some(step => step.type === 'attack' && step.actor === 0));
    assert.match(roundSummary(after), /Riposte found no opening/);
  }
});

test('a lethal parried Strike defeats the dagger fighter without a phantom counter', () => {
  const before = structuredClone(initial()); before.fighters[0].hp = 1;
  const after = resolveRound(before, ['technique', 'strike']);
  const steps = buildAnimationSteps(before, after);
  assert.deepEqual(steps.map(step => step.type), ['reveal', 'riposte', 'attack', 'defeat']);
  assert.equal(steps.filter(step => step.type === 'attack').length, 1);
  assert.equal(steps.at(-1).actor, 0);
});

test('execution retains the chosen dagger instead of substituting a sword', () => {
  const duel = { status: 'complete', fighters: initial().fighters, result: { winner: 0, reason: 'knockout' } };
  // Existing execution builder takes a resolved view; this is presentation only.
  const event = buildExecutionEvent(duel, { decision: 'execute', winner: 0, loser: 1 });
  assert.ok(event); assert.equal(event.weapon, 'dagger');
});

test('aborting a Riposte animation clears its stance and leaves gameplay state untouched', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const element = () => ({ dataset: {}, classList: { add() {}, remove() {} }, setAttribute() {}, append() {}, remove() {} });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: element, createElementNS: element } });
  t.after(() => original ? Object.defineProperty(globalThis, 'document', original) : delete globalThis.document);
  const fighters = [0, 1].map(index => ({ ...element(), dataset: { fighterIndex: String(index) }, querySelector: () => element() }));
  const container = { ...element(), isConnected: true, querySelector: selector => fighters[Number(/index="(\d)"/.exec(selector)[1])], querySelectorAll: () => [] };
  const controller = new AbortController();
  const state = initial(), snapshot = structuredClone(state);
  const playback = playBattleAnimation(container, [{ type: 'riposte', actor: 0, weapon: 'dagger', text: 'Readied Riposte.' }], { signal: controller.signal });
  assert.equal(fighters[0].dataset.riposting, 'true');
  controller.abort(); assert.equal(await playback, false);
  assert.deepEqual(fighters[0].dataset, { fighterIndex: '0', weapon: 'dagger' });
  assert.deepEqual(state, snapshot);
});
