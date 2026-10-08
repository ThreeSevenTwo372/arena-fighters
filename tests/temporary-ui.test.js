import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import { normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const boundary = source.indexOf("\napp.innerHTML = '<main class=\"app-shell\"><section class=\"panel loading-screen\"");
assert.ok(boundary > 0);
const definitions = source.slice(0, boundary).replace(/^import .*;\r?\n/gm, '');
const character = (name = 'Cassian') => ({ id: 'saved-fighter', name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', color: '#b87333', appearance: normalizeAppearance() });
const livingSession = () => ({ playerId: 'saved-player', character: character(), alive: true, duelWins: 3, activeRoom: null, activeTournament: null });
const statusError = status => Object.assign(new Error('Session expired.'), { status });
function fixture({ mode = 'temporary' } = {}) {
  let now = 100000, renders = 0;
  const handlers = new Map();
  const app = { addEventListener: (kind, handler) => handlers.set(kind, handler), querySelectorAll: () => [], querySelector: () => null, setAttribute() {} };
  const context = vm.createContext({
    ...combat, ...presentation, normalizeAppearance, facePresetChoices, normalizePresetAppearance, structuredClone, URLSearchParams, AbortController,
    setTimeout, clearTimeout, console, Date: class extends Date { static now() { return now; } },
    location: { search: '' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: () => app, addEventListener() {}, activeElement: null },
    OnlineClient: class { constructor() { this.sessionMode = mode; this.token = 'saved-token'; } resetMatchContext() {} },
    prepareCleanAvatar: async () => {}, renderCleanAvatar: () => '', renderArena: () => '',
    buildAnimationSteps: () => [], playBattleAnimation: async () => {}, buildExecutionEvent, playExecutionAnimation: async () => {},
    renderMercyPanel, playLoserOutcome: async () => {},
    countedRender: async () => { renders += 1; },
  });
  vm.runInContext(definitions + `
    const actualRender = render;
    render = countedRender;
    globalThis.fixture = {
      state, client: onlineClient, pollOnline, useOnlineSession, actualRender, onlineLobby,
      get view() { return onlineView; }, set view(value) { onlineView = value; },
      get session() { return onlineSession; }, get offline() { return onlineOffline; },
      set busy(value) { onlineBusy = value; },
    };
  `, context, { filename: 'src/app.js' });
  const result = context.fixture;
  result.app = app;
  result.advance = milliseconds => { now += milliseconds; };
  result.renders = () => renders;
  result.click = (action, value) => handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: { action, value } }) } });
  return result;
}

test('an idle temporary survivor heartbeats every fifteen seconds without rebuilding its creator', async () => {
  const ui = fixture();
  const saved = livingSession();
  ui.useOnlineSession(saved);
  let requests = 0;
  ui.client.session = async options => { assert.equal(options.create, true); requests += 1; return saved; };
  await ui.pollOnline();
  await ui.pollOnline();
  ui.advance(14999); await ui.pollOnline();
  assert.equal(requests, 1);
  ui.advance(1); await ui.pollOnline();
  assert.equal(requests, 2);
  assert.equal(ui.state.drafts[0].id, 'saved-fighter');
  assert.equal(ui.state.locked[0], true);
  assert.equal(ui.renders(), 0);
});

test('healthy idle heartbeats preserve an unfinished fighter and allocate no guest before first entry', async () => {
  const ui = fixture();
  ui.state.drafts[0].name = 'Name being typed';
  ui.state.drafts[0].stats.strength = 5;
  let requests = 0;
  ui.client.session = async () => { requests += 1; return { playerId: 'saved-player', character: null }; };
  ui.client.token = null;
  await ui.pollOnline(); assert.equal(requests, 0);
  ui.client.token = 'saved-token';
  await ui.pollOnline();
  assert.equal(requests, 1);
  assert.equal(ui.state.drafts[0].name, 'Name being typed');
  assert.equal(ui.state.drafts[0].stats.strength, 5);
  assert.equal(ui.renders(), 0);
});

test('durable idle guests retain the existing polling behavior', async () => {
  const ui = fixture({ mode: 'persistent' });
  ui.useOnlineSession(livingSession());
  ui.client.session = async () => { assert.fail('Durable idle guests need no temporary heartbeat.'); };
  await ui.pollOnline();
  assert.equal(ui.state.locked[0], true);
});

test('an expired idle guest returns to new naming without retaining a vanished fighter or record', async () => {
  const ui = fixture();
  ui.useOnlineSession(livingSession());
  ui.state.profiles = [{ character: character(), duelWins: 3 }];
  ui.client.session = async () => { ui.client.token = 'new-token'; return { playerId: 'new-player', character: null, alive: true }; };
  await ui.pollOnline();
  assert.equal(ui.view, null);
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.state.drafts[0].name, '');
  assert.equal(Object.hasOwn(ui.state.drafts[0], 'id'), false);
  assert.equal(ui.state.locked[0], false);
  assert.equal(ui.state.profiles.length, 0);
  assert.match(ui.state.error, /temporary session ended/);
});

test('a service restart during a match recovers authentication and clears its stale arena state', async () => {
  const ui = fixture();
  const saved = livingSession();
  ui.useOnlineSession(saved);
  ui.view = { code: 'ABC234', duelId: 'old-duel' };
  ui.state.screen = 'battle'; ui.state.duel = { stale: true }; ui.state.decision = 'execute'; ui.state.pending = ['strike', null];
  ui.client.room = async () => { throw statusError(401); };
  ui.client.session = async () => { ui.client.token = 'new-token'; return { playerId: 'new-player', character: null, alive: true }; };
  await ui.pollOnline();
  assert.equal(ui.view, null);
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.duel, null);
  assert.equal(ui.state.decision, null);
  assert.deepEqual([...ui.state.pending], [null, null]);
  assert.equal(ui.state.drafts[0].name, '');
  assert.equal(ui.state.locked[0], false);
  assert.equal(ui.offline, false);
});

test('a vanished room with a living temporary guest returns that same survivor to tournament entry', async () => {
  const ui = fixture();
  const saved = livingSession();
  ui.useOnlineSession(saved);
  ui.view = { code: 'ABC234' }; ui.state.screen = 'battle';
  ui.client.room = async () => { throw statusError(404); };
  ui.client.session = async () => saved;
  await ui.pollOnline();
  assert.equal(ui.view, null);
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.drafts[0].id, 'saved-fighter');
  assert.equal(ui.state.locked[0], true);
  assert.equal(ui.session.duelWins, 3);
});

test('an ordinary network interruption keeps the existing duel and token for reconnecting', async () => {
  const ui = fixture();
  const view = { code: 'ABC234' };
  ui.view = view;
  ui.client.room = async () => { throw new Error('Connection interrupted.'); };
  ui.client.session = async () => { assert.fail('An interrupted request must not replace its guest.'); };
  await ui.pollOnline();
  assert.equal(ui.view, view);
  assert.equal(ui.client.token, 'saved-token');
  assert.equal(ui.offline, true);
});

test('a late temporary heartbeat cannot replace the Practice draft after a mode change', async () => {
  const ui = fixture();
  let done;
  ui.client.session = () => new Promise(resolve => { done = resolve; });
  const polling = ui.pollOnline();
  await ui.click('mode', 'cpu');
  ui.state.drafts[0].name = 'Practice fighter';
  ui.client.token = 'new-token';
  done({ playerId: 'new-player', character: null });
  await polling;
  assert.equal(ui.state.mode, 'cpu');
  assert.equal(ui.state.drafts[0].name, 'Practice fighter');
  assert.equal(ui.state.locked[0], false);
});

test('temporary heartbeat respects the existing busy and in-flight polling guards', async () => {
  const ui = fixture();
  let done, requests = 0;
  ui.client.session = () => { requests += 1; return new Promise(resolve => { done = resolve; }); };
  ui.busy = true; await ui.pollOnline(); assert.equal(requests, 0);
  ui.busy = false;
  const polling = ui.pollOnline();
  ui.advance(15000); await ui.pollOnline(); assert.equal(requests, 1);
  done({ playerId: 'saved-player', character: null }); await polling;
});

test('the diagnostic duel lobby explains separate temporary tab identities while durable guidance stays unchanged', () => {
  for (const mode of ['temporary', 'persistent']) {
    const ui = fixture({ mode });
    ui.view = { code: 'ABC234', phase: 'waiting', you: 0, players: [{ character: character(), duelWins: 0 }] };
    const markup = ui.onlineLobby();
    if (mode === 'temporary') {
      assert.match(markup, /Each fresh game tab has its own fighter/);
      assert.doesNotMatch(markup, /Another tab in the same browser shares/);
    } else assert.match(markup, /Another tab in the same browser shares your guest identity/);
  }
});

test('the real page renderer shows unavailable-storage guidance only when useful and keeps gameplay errors first', async () => {
  const ui = fixture();
  await ui.actualRender();
  assert.doesNotMatch(ui.app.innerHTML, /class="toast"/);
  ui.client.storageWarning = 'Refreshing the page will start a new fighter.';
  await ui.actualRender();
  assert.match(ui.app.innerHTML, /class="toast" role="alert">Refreshing the page will start a new fighter/);
  assert.equal(ui.state.error, '');
  ui.state.error = 'Your rival has already committed this round.';
  await ui.actualRender();
  assert.match(ui.app.innerHTML, /class="toast" role="alert">Your rival has already committed this round/);
  assert.doesNotMatch(ui.app.innerHTML, /Refreshing the page will start/);
  ui.state.error = ''; ui.state.mode = 'cpu';
  await ui.actualRender();
  assert.doesNotMatch(ui.app.innerHTML, /class="toast"/);
});
