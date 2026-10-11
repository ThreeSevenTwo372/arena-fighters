import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirstPersonSample, createFirstPersonExecutionSample, renderFirstPersonPreview } from '../src/first-person-preview.js';

test('execution art sample is disposable, literal and leaves the original fighters untouched', () => {
  const duel = createFirstPersonSample({ weapon: 'greatsword', armor: 'heavy' });
  const before = structuredClone(duel);
  const event = createFirstPersonExecutionSample(duel);
  assert.deepEqual(duel, before);
  assert.equal(duel.status, 'active');
  assert.deepEqual(event, { winner: 0, loser: 1, weapon: 'greatsword', text: 'Cassian executes Mira.' });
  assert.ok(Object.isFrozen(event));
  assert.equal(createFirstPersonExecutionSample(null), null);
  assert.equal(createFirstPersonExecutionSample({ fighters: [] }), null);
});

test('execution cue stays in disposable art controls and locks during playback', () => {
  const duel = createFirstPersonSample();
  assert.match(renderFirstPersonPreview(duel), /data-fp-art-cue="execution">Execution/);
  assert.match(renderFirstPersonPreview(duel, { playing: true }), /data-fp-art-cue="execution" disabled>Execution/);
});
