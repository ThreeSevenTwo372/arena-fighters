import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, resolveRound, getActionOptions, getFighterStatuses } from '../src/combat.js';
import { actionPreview, roundSummary, fighterConditionText } from '../src/battle-presentation.js';
import { buildAnimationSteps } from '../src/battle-animation.js';
import { renderTournamentSpectator } from '../src/tournament-view.js';

const fighter = (name, weapon = 'sword') => ({ character: { name, trait: 'balanced', stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 } }, weapon, armor: 'medium' });
const duel = () => createDuel([fighter('One'), fighter('Two', 'trident')]);

test('Focus and passive stamina playback use public executed events and actual capped gains', () => {
  const before = structuredClone(duel());
  before.fighters[0].stamina -= 1;
  const snapshot = structuredClone(before);
  const after = resolveRound(before, ['focus', 'strike']);
  const steps = buildAnimationSteps(before, after, ['strike', 'guard']);
  assert.deepEqual(steps.map(step => step.type), ['reveal', 'attack', 'focus', 'stamina-regeneration', 'stamina-regeneration']);
  assert.deepEqual(steps.filter(step => step.type === 'stamina-regeneration').map(step => [step.actor, step.restored]), [[0, 1], [1, 2]]);
  assert.equal(steps.find(step => step.type === 'focus').damageBonus, 3);
  assert.deepEqual(buildAnimationSteps(before, after, ['focus', 'focus']), steps);
  assert.deepEqual(before, snapshot);
  assert.match(roundSummary(after), /One prepared \+3 attack power for next round/);
  assert.match(roundSummary(after), /One regained 1 stamina; Two regained 2 stamina/);
});

test('knockout cancels a pending Focus and only the survivor regenerates', () => {
  const before = structuredClone(duel()); before.fighters[0].hp = 1;
  const after = resolveRound(before, ['focus', 'strike']);
  const steps = buildAnimationSteps(before, after);
  assert.deepEqual(steps.map(step => step.type), ['reveal', 'attack', 'defeat', 'stamina-regeneration']);
  assert.equal(steps.at(-1).actor, 1);
  assert.doesNotMatch(roundSummary(after), /One prepared|One regained/);
});

test('Focused attack preview matches actual damage and spectator status expires with the bonus', () => {
  const focused = resolveRound(duel(), ['focus', 'guard']);
  const option = getActionOptions(focused, 0).find(move => move.id === 'strike');
  assert.match(actionPreview(option).detail, /Includes \+3 Focus power/);
  assert.equal(actionPreview(option).label, `${option.damage} damage`);
  assert.match(fighterConditionText(getFighterStatuses(focused, 0)[0]), /Focused · Next attack \+3 power · This round only/);
  const view = { code: 'ABC123', phase: 'battle', role: 'spectator', players: focused.fighters.map(item => ({ character: item.character })), bracket: [], match: { duel: focused, slots: [0, 1], pending: [false, false] } };
  const html = renderTournamentSpectator(view);
  assert.match(html, /Focused · Next attack \+3 power/);
  assert.match(html, /\+2 \/ round/);
  assert.doesNotMatch(html, /data-action="fight"/);
  assert.doesNotMatch(renderTournamentSpectator(view, { playing: true }), /Focused · Next attack/);
  const after = resolveRound(focused, ['strike', 'focus']);
  assert.equal(after.lastRound.events.find(event => event.type === 'attack').damage, option.damage);
  const refreshed = renderTournamentSpectator({ ...view, match: { ...view.match, duel: after } });
  assert.doesNotMatch(refreshed.match(/<section class="spectator-status" aria-label="One status">[\s\S]*?<\/section>/)[0], /Focused/);
});

test('Focus preview makes its price, exposure and exact lifetime clear', () => {
  const option = getActionOptions(duel(), 0).find(move => move.id === 'focus');
  const preview = actionPreview(option);
  assert.equal(option.cost, 0); assert.equal(preview.label, 'Next attack +3 power');
  assert.match(preview.detail, /No stamina cost/); assert.match(preview.detail, /leaves you open/);
  assert.match(preview.detail, /Next round only/); assert.match(preview.detail, /Does not stack/); assert.match(preview.detail, /Clears the net/);
});
