import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, getActionOptions, resolveRound, forfeitDuel } from '../src/combat.js';
import { battlePhase, fighterReadiness, roundSummary, actionPreview, outcomeReason } from '../src/battle-presentation.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', color: '#b87333' });
const initial = (weapon = 'sword', options) => createDuel([
  { character: character('Cassian'), weapon, armor: 'medium' },
  { character: character('Mira'), weapon: 'spear', armor: 'light' },
], options);
const context = (extra = {}) => ({ duel: initial(), mode: 'online', viewer: 0, phase: 'select', pending: [false, false], ...extra });

test('public phase labels distinguish choosing, sending, locked, reconnecting and revealed', () => {
  assert.deepEqual(battlePhase(context()), { id: 'choosing', label: 'Choose a move' });
  assert.equal(battlePhase(context({ busy: true })).id, 'sending');
  assert.equal(battlePhase(context({ pending: [true, false] })).id, 'locked');
  assert.equal(battlePhase(context({ pending: [true, false], offline: true })).id, 'reconnecting');
  assert.equal(battlePhase(context({ phase: 'playback', busy: true, offline: true })).id, 'revealed');
  assert.equal(battlePhase(context({ viewer: 1, pending: [true, false] })).id, 'choosing');
});

test('readiness uses only whether each choice is committed, never its action name', () => {
  const secretA = context({ pending: ['strike', 'recover'] });
  const secretB = context({ pending: ['technique', 'guard'] });
  for (const index of [0, 1]) {
    assert.equal(fighterReadiness(index, secretA), 'Choice locked');
    assert.equal(fighterReadiness(index, secretA), fighterReadiness(index, secretB));
  }
  assert.deepEqual(battlePhase(secretA), battlePhase(secretB));
  assert.equal(fighterReadiness(1, context()), 'Waiting for a choice');
  assert.equal(fighterReadiness(0, context({ busy: true })), 'Sending choice…');
  assert.equal(fighterReadiness(1, context({ busy: true })), 'Waiting for a choice');
  assert.equal(fighterReadiness(0, context({ offline: true })), 'Reconnecting…');
  assert.equal(fighterReadiness(1, context({ mode: 'cpu' })), 'Ready');
  assert.equal(fighterReadiness(1, context({ phase: 'playback' })), 'Choices revealed');
});

test('round summary combines both actual moves and actual capped recovery', () => {
  const before = initial();
  const after = resolveRound(before, ['strike', 'recover']);
  assert.ok(Object.isFrozen(after));
  const attack = after.lastRound.events.find(event => event.type === 'attack');
  const recover = after.lastRound.events.find(event => event.type === 'recover');
  assert.equal(roundSummary(after), `Cassian dealt ${attack.damage} damage; Mira restored ${recover.restored} stamina.`);
  assert.equal(recover.restored, 0, 'Full stamina means actual recovery is zero.');
  assert.equal(roundSummary(before), 'Choose a move. Both choices reveal together.');
  const guarded = resolveRound(before, ['guard', 'strike']);
  assert.match(roundSummary(guarded), /^Cassian guarded; Mira dealt \d+ damage\.$/);
  assert.deepEqual(before.lastRound, null);
});

test('knockout summary reports the canceled move rather than implying it happened', () => {
  let duel = initial();
  while (duel.status === 'active') {
    const canStrike = getActionOptions(duel, 0).find(option => option.id === 'strike').enabled;
    duel = resolveRound(duel, [canStrike ? 'strike' : 'recover', 'recover']);
  }
  assert.ok(Object.isFrozen(duel));
  assert.equal(duel.result.winner, 0);
  assert.match(roundSummary(duel), /Cassian dealt \d+ damage; Mira was defeated before acting\./);
  assert.doesNotMatch(roundSummary(duel), /Mira restored/);
  assert.equal(battlePhase(context({ duel })).id, 'victory');
  assert.equal(battlePhase(context({ duel, viewer: 1 })).id, 'defeat');
  assert.equal(fighterReadiness(1, context({ duel })), 'Defeated');
  assert.equal(battlePhase(context({ duel, phase: 'playback' })).id, 'revealed');
});

test('attack previews report the rules-computed damage against unguarded and guarded targets', () => {
  for (const weapon of ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword']) {
    const duel = initial(weapon);
    for (const option of getActionOptions(duel, 0).filter(option => option.damage)) {
      const preview = actionPreview(option);
      assert.equal(preview.label, `${option.damage} damage`);
      assert.equal(preview.detail, `Against an unguarded rival · ${option.guardedDamage} against Guard`);
    }
  }
  assert.equal(actionPreview({ id: 'strike', damage: 1 }).detail, 'Against an unguarded rival');
});

test('nonattack previews describe minimum guarded damage and capped, late recovery', () => {
  const options = getActionOptions(initial(), 0);
  const guard = actionPreview(options.find(option => option.id === 'guard'));
  const recoverOption = options.find(option => option.id === 'recover');
  const recover = actionPreview(recoverOption);
  assert.equal(guard.label, 'Block most damage');
  assert.match(guard.detail, /65% reduction/);
  assert.match(guard.detail, /Minimum 1 damage/);
  assert.match(guard.detail, /techniques bypass Guard/);
  assert.equal(recover.label, `Up to +${recoverOption.recovery} SP`);
  assert.equal(recover.detail, 'Acts last · Capped at maximum stamina');
});

test('forfeit outcomes are relative to the viewer, and abandonment is a draw', () => {
  const duel = forfeitDuel(initial(), 0);
  assert.equal(outcomeReason(duel, 0), 'You forfeited or failed to reconnect.');
  assert.equal(outcomeReason(duel, 1), 'Your rival forfeited or failed to reconnect.');
  assert.equal(fighterReadiness(1, context({ duel })), 'Winner');
  assert.equal(roundSummary(duel), duel.lastRound.events[0].text);
  const draw = forfeitDuel(initial(), null);
  assert.equal(battlePhase(context({ duel: draw })).id, 'draw');
  assert.equal(fighterReadiness(0, context({ duel: draw })), 'Draw');
  assert.equal(outcomeReason(draw), 'Both fighters left the duel. No victory was awarded.');
});
