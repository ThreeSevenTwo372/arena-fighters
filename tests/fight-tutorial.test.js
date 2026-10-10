import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFightTutorial, advanceFightTutorial, prepareFightTutorial, renderFightTutorial } from '../src/fight-tutorial.js';
import { validateCharacter, getActionOptions, getFighterStatuses, resolveRound } from '../src/combat.js';
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
  const learnerOptions = getActionOptions(first.duel, 0);
  assert.equal(learnerOptions.find(option => option.id === 'strike').cost, 3);
  assert.equal(learnerOptions.find(option => option.id === 'technique').cost, 4);
  assert.equal(getActionOptions(first.duel, 1).find(option => option.id === 'technique').cost, 5);
});

test('Guard really reduces a Strike while preserving the original duel and paying stamina', () => {
  const before = createFightTutorial(), snapshot = structuredClone(before);
  const after = advanceFightTutorial(before, 'guard');
  assert.equal(after.phase, 'review');
  assert.equal(after.duel.round, 2);
  assert.deepEqual(after.duel.lastRound.actions, ['guard', 'strike']);
  assert.deepEqual(after.duel.lastRound.order, [0, 1]);
  assert.equal(after.duel.fighters[0].hp, 96);
  assert.equal(after.duel.fighters[0].stamina, 16);
  assert.equal(after.duel.fighters[1].stamina, 15);
  assert.equal(after.duel.lastRound.events.find(event => event.type === 'stamina-regeneration' && event.actor === 0).restored, 2);
  assert.equal(after.duel.lastRound.events.find(event => event.type === 'attack').damage, 4);
  assert.match(after.feedback, /from 13 to 4 damage/);
  assert.match(after.feedback, /spent 2 stamina.*restored 2 stamina automatically/);
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
  assert.equal(attack.damage, 16);
  assert.equal(after.duel.fighters[1].hp, 84);
  assert.equal(after.duel.fighters[0].stamina, 14);
  assert.equal(after.duel.fighters[1].stamina, 15);
  assert.match(after.feedback, /16 damage through Guard/);
  assert.match(after.feedback, /Round-end recovery restored 2 stamina automatically/);
});

test('Focus prepares the next attack and denies Riposte while Dexterity restores stamina automatically', () => {
  let before = createFightTutorial();
  for (const action of ['guard', 'next', 'technique', 'next']) before = advanceFightTutorial(before, action);
  const after = advanceFightTutorial(before, 'focus');
  assert.deepEqual(after.duel.lastRound.actions, ['focus', 'technique']);
  assert.deepEqual(after.duel.lastRound.order, [1, 0]);
  assert.deepEqual(after.duel.fighters.map(fighter => fighter.hp), before.duel.fighters.map(fighter => fighter.hp));
  assert.equal(after.duel.fighters[0].stamina, 16);
  assert.equal(after.duel.fighters[1].stamina, 12);
  assert.equal(after.duel.lastRound.events.some(event => event.type === 'attack'), false);
  assert.equal(after.duel.lastRound.events.some(event => event.type === 'riposte-miss'), true);
  assert.equal(after.duel.lastRound.events.find(event => event.type === 'stamina-regeneration' && event.actor === 0).restored, 2);
  assert.match(after.feedback, /Round-end recovery restored 2 stamina automatically/);
  assert.equal(after.duel.lastRound.events.some(event => event.type === 'recover'), false);
  const focusOption = getActionOptions(before.duel, 0).find(option => option.id === 'focus');
  assert.equal(focusOption.cost, 0);
  assert.equal(focusOption.focusBonus, 3);
  assert.deepEqual(getFighterStatuses(after.duel, 0), [{ id: 'focused', label: 'Focused', damageBonus: 3, expiresAfterRound: 4 }]);
  assert.match(after.feedback, /Focus costs no stamina/);
  assert.match(after.feedback, /\+3 attack damage before protection/);
  assert.match(after.feedback, /never stacks.*unused bonus expires at the end of the next round/);
  const complete = advanceFightTutorial(after, 'next');
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.duel.status, 'active', 'Finishing a lesson grants no match win, mercy or death result.');
  assert.equal(complete.duel.result, null);
  assert.equal(complete.duel.log.filter(event => event.type === 'reveal').length, 3);
  assert.equal(advanceFightTutorial(complete, 'focus'), complete);
});

test('the third lesson leaves a real single-use Focus bonus matching its next-round attack preview', () => {
  let lesson = createFightTutorial();
  for (const action of ['guard', 'next', 'technique', 'next']) lesson = advanceFightTutorial(lesson, action);
  const baseline = getActionOptions(lesson.duel, 0).find(option => option.id === 'technique').damage;
  const focused = advanceFightTutorial(lesson, 'focus');
  const preview = getActionOptions(focused.duel, 0).find(option => option.id === 'technique');
  assert.equal(preview.damage, baseline + 3);
  const attack = resolveRound(focused.duel, ['technique', 'guard']);
  assert.equal(attack.lastRound.events.find(event => event.type === 'attack' && event.actor === 0).damage, preview.guardedDamage);
  assert.equal(getFighterStatuses(attack, 0).some(status => status.id === 'focused'), false);
  const unused = resolveRound(focused.duel, ['guard', 'guard']);
  assert.equal(getFighterStatuses(unused, 0).some(status => status.id === 'focused'), false, 'Guard lets the queued attack bonus expire after exactly one round.');
  assert.equal(focused.duel.log.filter(event => event.type === 'reveal').length, 3, 'The UI lesson still plays exactly three coached rounds.');
});

test('unguided moves, early next and double clicks cannot skip or resolve lessons twice', () => {
  const start = createFightTutorial();
  for (const action of ['strike', 'recover', 'focus', 'technique', 'next', 'kill']) assert.equal(advanceFightTutorial(start, action), start);
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
  assert.match(output, /Round-end recovery: up to 2 stamina/);
  assert.doesNotMatch(output, /data-action="(?:choice|online-create|mercy|crowd-vote)"/);
  let state = advanceFightTutorial(start, 'guard');
  output = renderFightTutorial(state, { playing: true });
  assert.match(output, /value="96" aria-label="Learner health"/);
  assert.match(output, /data-action="tutorial-next" disabled/);
  assert.match(output, /Watching the round/);
  for (const action of ['next', 'technique', 'next']) state = advanceFightTutorial(state, action);
  output = renderFightTutorial(state);
  assert.match(output, /data-action="tutorial-move" data-value="focus"/);
  assert.match(output, /Focus costs no stamina and leaves you open to attacks/);
  for (const action of ['focus', 'next']) state = advanceFightTutorial(state, action);
  output = renderFightTutorial(state);
  for (const action of ['menu-fight', 'menu-quick-duel', 'tutorial-restart', 'menu-home']) assert.match(output, new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(output, /data-action="tutorial-move"/);
  assert.match(output, /both choices are secret until they reveal together/);
  assert.match(output, /<strong>Focused<\/strong> · Next-round attack \+3/);
  assert.match(output, /Stamina recovers automatically after each round.*Dexterity 8.*faster choices act first/);
  assert.doesNotMatch(output, /Recover|undefined|NaN/);
});

test('first-person tutorial preserves the exact opponent assembly and original saved learner appearance', async () => {
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
      assert.equal(output.includes(image.url), fighter.character.name === 'Instructor');
      if (fighter.character.name === 'Instructor') assert.ok(output.includes(image.weaponImage.url));
    }
    assert.equal((output.match(/class="gladiator pixel-gladiator clean-gladiator"/g) ?? []).length, 1);
    assert.equal((output.match(/class="pixel-sprite fighter-body"/g) ?? []).length, 1);
    assert.match(output, /data-viewer-index="0"/);
    assert.match(output, /fp-whole-hold/);
    assert.deepEqual(state, snapshot);
    assert.ok(requests.includes('/assets/clean-gladiator/v013/manifest.json'));
    assert.equal(requests.some(url => url.includes('/api/')), false);
  } finally { globalThis.fetch = previousFetch; }
});
