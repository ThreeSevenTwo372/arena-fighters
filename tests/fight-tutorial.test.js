import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFightTutorial, advanceFightTutorial, prepareFightTutorial, renderFightTutorial } from '../src/fight-tutorial.js';
import { validateCharacter } from '../src/combat.js';
import { getCleanAvatarImage } from '../src/current-avatar.js';

test('coached fighters are legal disposable identities independent of another lesson', () => {
  const first = createFightTutorial(), second = createFightTutorial();
  assert.equal(first.phase, 'choose');
  assert.equal(first.step, 0);
  assert.equal(first.duel.status, 'active');
  assert.notEqual(first.duel, second.duel);
  assert.notEqual(first.duel.fighters[0].character, second.duel.fighters[0].character);
  for (const fighter of first.duel.fighters) {
    assert.equal(validateCharacter(fighter.character).valid, true);
    assert.equal(fighter.hp, fighter.maxHp);
    assert.equal(fighter.stamina, fighter.maxStamina);
    assert.ok(['p05', 'p10'].includes(fighter.character.appearance.facePreset));
  }
  assert.deepEqual(first, second);
});

test('Guard really reduces a Strike while preserving the original duel and paying stamina', () => {
  const before = createFightTutorial(), snapshot = structuredClone(before);
  const after = advanceFightTutorial(before, 'guard');
  assert.equal(after.phase, 'review');
  assert.equal(after.duel.round, 2);
  assert.deepEqual(after.duel.lastRound.actions, ['guard', 'strike']);
  assert.deepEqual(after.duel.lastRound.order, [0, 1]);
  assert.equal(after.duel.fighters[0].hp, 95);
  assert.equal(after.duel.fighters[0].stamina, 14);
  assert.equal(after.duel.fighters[1].stamina, 13);
  assert.equal(after.duel.lastRound.events.find(event => event.type === 'attack').damage, 3);
  assert.match(after.feedback, /from 11 to 3 damage/);
  assert.deepEqual(before, snapshot);
});

test('the second coached round uses sword Feint to bypass a real Guard', () => {
  const before = advanceFightTutorial(advanceFightTutorial(createFightTutorial(), 'guard'), 'next');
  assert.equal(before.step, 1);
  const after = advanceFightTutorial(before, 'technique');
  assert.deepEqual(after.duel.lastRound.actions, ['technique', 'guard']);
  assert.deepEqual(after.duel.lastRound.order, [1, 0]);
  const attack = after.duel.lastRound.events.find(event => event.type === 'attack');
  assert.equal(attack.actor, 0);
  assert.equal(attack.bypassedGuard, true);
  assert.equal(attack.damage, 13);
  assert.equal(after.duel.fighters[1].hp, 85);
  assert.equal(after.duel.fighters[0].stamina, 10);
  assert.match(after.feedback, /13 damage through Guard/);
});

test('Recover restores depleted stamina and denies dagger Riposte before lesson completion', () => {
  let before = createFightTutorial();
  for (const action of ['guard', 'next', 'technique', 'next']) before = advanceFightTutorial(before, action);
  const after = advanceFightTutorial(before, 'recover');
  assert.deepEqual(after.duel.lastRound.actions, ['recover', 'technique']);
  assert.deepEqual(after.duel.lastRound.order, [1, 0]);
  assert.deepEqual(after.duel.fighters.map(fighter => fighter.hp), before.duel.fighters.map(fighter => fighter.hp));
  assert.equal(after.duel.fighters[0].stamina, 16);
  assert.equal(after.duel.fighters[1].stamina, 6);
  assert.equal(after.duel.lastRound.events.some(event => event.type === 'attack'), false);
  assert.equal(after.duel.lastRound.events.some(event => event.type === 'riposte-miss'), true);
  assert.equal(after.duel.lastRound.events.find(event => event.type === 'recover').restored, 6);
  const complete = advanceFightTutorial(after, 'next');
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.duel.status, 'active', 'Finishing a lesson grants no match win, mercy or death result.');
  assert.equal(complete.duel.result, null);
  assert.equal(complete.duel.log.filter(event => event.type === 'reveal').length, 3);
  assert.equal(advanceFightTutorial(complete, 'recover'), complete);
});

test('unguided moves, early next and double clicks cannot skip or resolve lessons twice', () => {
  const start = createFightTutorial();
  for (const action of ['strike', 'recover', 'technique', 'next', 'kill']) assert.equal(advanceFightTutorial(start, action), start);
  const review = advanceFightTutorial(start, 'guard');
  assert.equal(advanceFightTutorial(review, 'guard'), review);
  assert.equal(advanceFightTutorial(review, 'strike'), review);
  const next = advanceFightTutorial(review, 'next');
  assert.equal(advanceFightTutorial(next, 'next'), next);
  assert.throws(() => advanceFightTutorial({ ...start, step: -1 }, 'guard'), /Invalid tutorial state/);
  assert.throws(() => renderFightTutorial({ ...start, phase: 'battle' }), /Invalid tutorial state/);
});

test('each tutorial phase shows the actual state with optional exit and no combat verdict actions', () => {
  const start = createFightTutorial();
  let output = renderFightTutorial(start);
  assert.match(output, /Lesson 1 of 3/);
  assert.match(output, /data-action="tutorial-move" data-value="guard"/);
  assert.match(output, /Instructor’s next move: <strong>Strike/);
  assert.match(output, /data-action="menu-home"/);
  assert.match(output, /No time limit/);
  assert.doesNotMatch(output, /data-action="(?:choice|online-create|mercy|crowd-vote)"/);
  let state = advanceFightTutorial(start, 'guard');
  output = renderFightTutorial(state, { playing: true });
  assert.match(output, /value="95" aria-label="Learner health"/);
  assert.match(output, /data-action="tutorial-next" disabled/);
  assert.match(output, /Watching the round/);
  for (const action of ['next', 'technique', 'next', 'recover', 'next']) state = advanceFightTutorial(state, action);
  output = renderFightTutorial(state);
  for (const action of ['menu-fight', 'menu-quick-duel', 'tutorial-restart', 'menu-home']) assert.match(output, new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(output, /data-action="tutorial-move"/);
  assert.match(output, /both choices are secret until they reveal together/);
});

test('tutorial arena uses both exact current runtime assemblies with their original registration', async () => {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    const url = new URL(input), target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
    requests.push(url.pathname);
    if (url.origin !== 'http://127.0.0.1:4173' || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
    try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
  };
  try {
    const state = createFightTutorial(), snapshot = structuredClone(state);
    await prepareFightTutorial(state);
    const output = renderFightTutorial(state);
    for (const fighter of state.duel.fighters) {
      const image = getCleanAvatarImage(fighter.character.appearance, 'battle', { weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet });
      assert.ok(image);
      assert.deepEqual(image.assembledIdentityAnchor, [93, 89]);
      assert.ok(output.includes(image.url));
      assert.ok(output.includes(image.weaponImage.url));
    }
    assert.equal((output.match(/class="gladiator pixel-gladiator clean-gladiator"/g) ?? []).length, 2);
    assert.equal((output.match(/class="pixel-sprite fighter-body"/g) ?? []).length, 2);
    assert.deepEqual(state, snapshot);
    assert.ok(requests.includes('/assets/clean-gladiator/v013/manifest.json'));
    assert.equal(requests.some(url => url.includes('/api/')), false);
  } finally { globalThis.fetch = previousFetch; }
});
