import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaInvite } from '../src/arena-invite.js';

test('friend links select the correct flow and include only a public code', () => {
  assert.equal(createArenaInvite('https://example.com/?token=private', 'ABC123'), 'https://example.com/?invite=ABC123');
  assert.equal(createArenaInvite('https://example.com/subpage#private', 'ABC123', { duel: true }), 'https://example.com/?duel-mode=1&invite=ABC123');
  assert.throws(() => createArenaInvite('https://example.com', 'bad<script>'));
  assert.throws(() => createArenaInvite('file:///private', 'ABC123'));
});
