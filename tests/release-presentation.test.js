import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, resolveRound, getActionOptions } from '../src/combat.js';
import { actionPreview } from '../src/battle-presentation.js';
import { renderTournamentSpectator } from '../src/tournament-view.js';
const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
test('spectators can see net pressure and preparation time without seeing a combat choice', () => {
  const duel = resolveRound(createDuel([
    { character: character('One'), weapon: 'trident', armor: 'medium' },
    { character: character('Two'), weapon: 'dagger', armor: 'medium' },
  ]), ['technique', 'strike']);
  const view = { code: 'ABC123', phase: 'battle', role: 'spectator', currentMatchIndex: 0, players: duel.fighters.map(fighter => ({ character: fighter.character })),
    bracket: [], match: { slots: [0, 1], duel, pending: [false, false], players: [{ botStyle: 'patient' }, {}], actionOpensAt: Date.now() + 4000, deadline: Date.now() + 24000 } };
  const html = renderTournamentSpectator(view);
  assert.match(html, /Entangled · Attacks \+3 SP/); assert.match(html, /Patient opponent/);
  assert.match(html, /Choices open in/); assert.match(html, /then 20s to choose/);
  assert.doesNotMatch(html, /data-action="fight"/);
  const playing = renderTournamentSpectator(view, { playing: true });
  assert.doesNotMatch(playing, /Entangled · Attacks/);
});
test('Entangle previews disclose its next-round pressure and counters', () => {
  const duel = createDuel([{ character: character('One'), weapon: 'trident', armor: 'medium' }, { character: character('Two'), weapon: 'dagger', armor: 'medium' }]);
  const preview = actionPreview(getActionOptions(duel, 0).find(option => option.id === 'technique'));
  assert.match(preview.label, /damage \+ net/); assert.match(preview.detail, /Next-round attacks \+3 SP/);
  assert.match(preview.detail, /Guard prevents the net/); assert.match(preview.detail, /Focus clears it/);
});
