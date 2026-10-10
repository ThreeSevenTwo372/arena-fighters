import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { audioBindings } from './fixtures/audio-stub.js';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import { normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = appSource.indexOf("\napp.innerHTML = '<main class=\"app-shell\"><section class=\"panel loading-screen\"");
assert.ok(startup > 0, 'The app startup boundary must be found.');
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const character = (name, id) => ({
  ...(id ? { id } : {}), name,
  stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b87333', appearance: normalizeAppearance(),
});
const initialDuel = () => combat.createDuel([
  { character: character('Cassian', 'saved-1'), weapon: 'sword', armor: 'medium' },
  { character: character('Mira', 'saved-2'), weapon: 'spear', armor: 'light' },
]);
const viewFor = (duel, revision = 1) => ({
  code: 'ABC234', duelId: 'duel-1', revision, phase: 'battle', you: 0,
  players: duel.fighters.map(fighter => ({ character: fighter.character, alive: true, duelWins: 0, left: false })),
  ready: [true, true], pending: [false, false], yourLoadout: { weapon: 'sword', armor: 'medium', helmet: 'none' },
  duel, decision: null, rematchReady: [false, false], deadline: null,
});

// Execute the real app handlers, replacing only browser rendering and network surfaces.
function fixture() {
  const handlers = new Map();
  const app = {
    addEventListener: (kind, handler) => handlers.set(kind, handler),
    querySelectorAll: () => [], querySelector: () => null, setAttribute() {},
  };
  const context = vm.createContext({
    ...audioBindings,
    ...combat, ...presentation, normalizeAppearance, facePresetChoices, normalizePresetAppearance, structuredClone, URLSearchParams, AbortController,
    setTimeout, clearTimeout, console,
    location: { search: '' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: () => app, addEventListener() {}, activeElement: null },
    OnlineClient: class {},
    prepareCleanAvatar: async () => {}, renderCleanAvatar: () => '', renderArena: () => '',
    buildAnimationSteps: () => [], playBattleAnimation: async () => {},
    buildExecutionEvent, playExecutionAnimation: async () => {},
    renderMercyPanel, playLoserOutcome: async () => {},
  });
  vm.runInContext(definitions + `
    let renderHook = async () => {};
    render = (...args) => renderHook(...args);
    globalThis.fixture = {
      state, client: onlineClient, pollOnline, useOnlineSession, applyOnlineView,
      get view() { return onlineView; }, set view(value) { onlineView = value; },
      get session() { return onlineSession; },
      get busy() { return onlineBusy; },
      set renderHook(value) { renderHook = value; },
    };
  `, context, { filename: 'src/app.js' });
  const result = context.fixture;
  result.click = (action, value) => handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: { action, value } }) } });
  return result;
}

test('a late Online session cannot lock or replace a Practice creator after changing modes', async () => {
  const ui = fixture();
  const response = deferred();
  let roomRequests = 0;
  ui.state.mode = 'cpu';
  ui.client.session = () => response.promise;
  ui.client.room = async () => { roomRequests += 1; return viewFor(initialDuel()); };

  const onlineSwitch = ui.click('mode', 'online');
  await ui.click('mode', 'cpu');
  const practiceName = ui.state.drafts[0].name;
  response.resolve({ character: character('Saved survivor', 'saved-1'), alive: true, activeRoom: 'ABC234' });
  await onlineSwitch;

  assert.equal(ui.state.mode, 'cpu');
  assert.equal(ui.state.drafts[0].name, practiceName);
  assert.equal(ui.state.locked[0], false);
  assert.equal(ui.state.profiles.length, 0);
  assert.equal(ui.view, null);
  assert.equal(roomRequests, 0);
});

test('an in-flight poll cannot advance a turn while its clicked command waits for rendering', async () => {
  const ui = fixture();
  const pollResponse = deferred();
  const renderResponse = deferred();
  const before = initialDuel();
  const after = combat.resolveRound(before, ['focus', 'focus']);
  const commands = [];
  ui.state.screen = 'battle';
  ui.state.duel = before;
  ui.view = viewFor(before);
  ui.client.room = () => pollResponse.promise;
  ui.client.command = async (view, action, payload) => { commands.push({ view, action, payload }); return viewFor(before); };
  let renders = 0;
  ui.renderHook = () => ++renders === 1 ? renderResponse.promise : Promise.resolve();

  const poll = ui.pollOnline();
  const click = ui.click('fight', 'strike');
  assert.equal(ui.busy, true);
  pollResponse.resolve(viewFor(after, 2));
  await poll;
  assert.equal(ui.state.duel.round, 1);
  assert.equal(ui.view.revision, 1);
  assert.equal(commands.length, 0);
  renderResponse.resolve();
  await click;

  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, 'action');
  assert.equal(commands[0].payload.round, 1);
  assert.equal(commands[0].payload.action, 'strike');
});

test('a battle click retains its original duel and round if another server view arrives during rendering', async () => {
  const ui = fixture();
  const renderResponse = deferred();
  const before = initialDuel();
  const after = combat.resolveRound(before, ['focus', 'focus']);
  const commands = [];
  ui.state.screen = 'battle';
  ui.state.duel = before;
  ui.view = viewFor(before);
  ui.client.command = async (view, action, payload) => { commands.push({ duelId: view.duelId, action, payload }); return ui.view; };
  let renders = 0;
  ui.renderHook = () => ++renders === 1 ? renderResponse.promise : Promise.resolve();

  const click = ui.click('fight', 'guard');
  ui.applyOnlineView({ ...viewFor(after, 2), duelId: 'duel-2' }, { animate: false });
  assert.equal(ui.state.duel.round, 2);
  renderResponse.resolve();
  await click;

  assert.equal(commands.length, 1);
  assert.equal(commands[0].duelId, 'duel-1');
  assert.equal(commands[0].payload.round, 1);
  assert.equal(commands[0].payload.action, 'guard');
});

test('leaving into pending mercy then receiving execution unlocks a replacement without the retired identity', async () => {
  const ui = fixture();
  const before = initialDuel();
  const survivor = character('Cassian', 'saved-1');
  const awaiting = { character: survivor, alive: true, duelWins: 3, activeRoom: null, pendingMercyRoom: 'ABC234' };
  const retired = { ...awaiting, alive: false, pendingMercyRoom: null };
  ui.state.screen = 'battle';
  ui.state.duel = before;
  ui.view = viewFor(before);
  ui.client.command = async (_view, kind) => { assert.equal(kind, 'leave'); return { left: true }; };
  ui.client.session = async () => awaiting;

  await ui.click('online-leave');
  assert.equal(ui.view, null);
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.session.pendingMercyRoom, 'ABC234');
  assert.equal(ui.state.locked[0], true);
  assert.equal(ui.state.drafts[0].id, 'saved-1');

  ui.client.session = async () => retired;
  await ui.pollOnline();
  assert.equal(ui.state.locked[0], false);
  assert.equal(Object.hasOwn(ui.state.drafts[0], 'id'), false);
  assert.equal(ui.state.drafts[0].name, 'Cassian II');
  assert.equal(ui.session.pendingMercyRoom, null);
  assert.equal(ui.session.character.id, 'saved-1');
  assert.equal(ui.session.duelWins, 3);
  assert.equal(retired.character.id, 'saved-1', 'Preparing a replacement must preserve the final record.');
});
