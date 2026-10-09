import test from 'node:test';
import assert from 'node:assert/strict';
import { createTournamentBot, chooseTournamentBotLoadout } from '../online/tournament-bots.mjs';
import { BOT_STYLES, validateCharacter, createDuel, chooseCpuAction, getActionOptions } from '../src/combat.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
test('new tournament bots record a stable public style with the existing legal point budget and loadout rules', () => {
  for (let sample = 0; sample < 100; sample++) {
    const bot = createTournamentBot([]), before = structuredClone(bot);
    assert.ok(Object.hasOwn(BOT_STYLES, bot.profile.botStyle)); assert.ok(BOT_STYLES[bot.profile.botStyle].label);
    assert.equal(validateCharacter(bot.profile.character).valid, true);
    const loadout = chooseTournamentBotLoadout(bot.profile.character);
    assert.doesNotThrow(() => createDuel([{ character: bot.profile.character, ...loadout }, { character: character('Human'), weapon: 'sword', armor: 'medium' }]));
    assert.deepEqual(bot, before, 'Equipment choice does not mutate style or fighter identity.');
    assert.equal(JSON.parse(JSON.stringify(bot)).profile.botStyle, bot.profile.botStyle, 'Style is ordinary serializable profile state.');
  }
});

test('styles make distinct legal decisions from the same public state without adjusting resources', () => {
  const base = createDuel(['A', 'B'].map(name => ({ character: character(name), weapon: 'sword', armor: 'medium' })));
  const cautiousRound = structuredClone(base); cautiousRound.round = 3;
  assert.equal(chooseCpuAction(cautiousRound, 0, 'cautious'), 'guard');
  assert.equal(chooseCpuAction(cautiousRound, 0, 'aggressive'), 'strike');
  const patientRound = structuredClone(base); patientRound.fighters[0].stamina = 7;
  assert.equal(chooseCpuAction(patientRound, 0, 'patient'), 'recover');
  assert.equal(chooseCpuAction(patientRound, 0, 'aggressive'), 'strike');
  for (const state of [base, cautiousRound, patientRound]) for (const style of Object.keys(BOT_STYLES)) {
    const before = structuredClone(state), action = chooseCpuAction(state, 0, style);
    assert.ok(getActionOptions(state, 0).some(option => option.id === action && option.enabled));
    assert.deepEqual(state, before);
  }
  assert.equal(chooseCpuAction(base, 0, 'unrecognized'), chooseCpuAction(base, 0), 'Old profiles keep their sealed default policy.');
});
