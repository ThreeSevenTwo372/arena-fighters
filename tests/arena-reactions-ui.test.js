import test from 'node:test';
import assert from 'node:assert/strict';
import { mountArenaReactions } from '../src/arena-reactions.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
function fixture(options = {}) {
  const buttons = ['cheer', 'applause', 'tomato'].map(kind => ({ dataset: { crowdReaction: kind }, disabled: false }));
  const status = { textContent: '' }, handlers = new Map(), effects = [];
  const host = { hidden: true, innerHTML: '', querySelectorAll: () => buttons, querySelector: () => status,
    addEventListener: (key, fn) => handlers.set(key, fn), removeEventListener: key => handlers.delete(key) };
  const result = (code = 'ABC123', id = 'first', kind = 'cheer') => ({ code, tournamentId: code,
    canSend: true, available: true, minIntervalMs: 3000, nextSendAt: 0, ttlMs: 6000,
    reactions: [{ id, kind, createdAt: 900 }] });
  const ui = mountArenaReactions(host, { read: async code => result(code), send: async code => result(code),
    now: () => 1000, uuid: () => 'stable-command', setTimer: () => 1, clearTimer() {}, onReaction: event => effects.push(event), ...options });
  return { ui, host, buttons, effects, result, click: kind => handlers.get('click')({ target: { closest: () => buttons.find(button => button.dataset.crowdReaction === kind) } }) };
}
test('spectator effects emit once while duelists receive effects with controls hidden', async () => {
  const { ui, host, effects } = fixture();
  ui.setRoom({ code: 'ABC123', tournamentId: 'ABC123', controls: false }); await flush();
  assert.equal(host.hidden, true); assert.equal(effects.length, 1);
  await ui.refresh(); assert.equal(effects.length, 1);
  ui.setRoom({ code: 'ABC123', tournamentId: 'ABC123', controls: true });
  assert.equal(host.hidden, false);
  ui.setRoom(null); assert.equal(host.hidden, true); ui.dispose();
});
test('late reads cannot restore a departed room or emit reactions from a prior tournament', async () => {
  const first = deferred(), second = deferred();
  const { ui, effects, result } = fixture({ read: code => code === 'ABC123' ? first.promise : second.promise });
  ui.setRoom({ code: 'ABC123', tournamentId: 'ABC123' }); await flush();
  ui.setRoom({ code: 'XYZ789', tournamentId: 'XYZ789' }); await flush();
  first.resolve(result()); await flush(); assert.equal(effects.length, 0);
  ui.setRoom(null); second.resolve(result('XYZ789')); await flush(); assert.equal(effects.length, 0); ui.dispose();
});
test('an uncertain send retries the same reaction and command rather than creating another throw', async () => {
  const calls = [];
  const setup = fixture({ send: async (code, payload) => {
    calls.push({ ...payload }); if (calls.length === 1) throw new Error('Network interrupted');
    return setup.result(code, 'second', payload.kind);
  } });
  setup.ui.setRoom({ code: 'ABC123', tournamentId: 'ABC123' }); await flush();
  await setup.click('tomato'); await setup.click('cheer');
  assert.deepEqual(calls, [{ commandId: 'stable-command', kind: 'tomato' }, { commandId: 'stable-command', kind: 'tomato' }]);
  assert(setup.buttons.every(button => button.disabled), 'Cooldown prevents another send');
  assert.equal(setup.effects.filter(effect => effect.id === 'second').length, 1); setup.ui.dispose();
});
