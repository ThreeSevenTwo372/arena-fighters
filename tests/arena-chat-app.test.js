import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { audioBindings } from './fixtures/audio-stub.js';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import * as menu from '../src/main-menu.js';
import { avatarChoices, normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';
import { renderArmory } from '../src/armory.js';
import { renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance } from '../src/tournament-view.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = appSource.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
assert.ok(startup > 0, 'Find the real app startup boundary.');
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const settle = async () => { for (let count = 0; count < 36; count++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const character = (name, id) => ({ id, name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', color: '#b45143', appearance: normalizePresetAppearance({ sex: 'male', facePreset: 'p05' }) });
const players = () => Array.from({ length: 8 }, (_, index) => ({ character: character(`Fighter ${index + 1}`, `fighter-${index}`), alive: true, duelWins: 0, tournamentWins: 0, left: false, eliminated: false, connected: true }));
function tournament({ phase = 'battle', revision = 1, you = null, matchYou = null, code = 'ABC234', duel = undefined } = {}) {
  const roster = players(), waiting = phase === 'waiting';
  const activeDuel = duel === undefined && !['waiting', 'equipment'].includes(phase)
    ? combat.createDuel(roster.slice(0, 2).map(profile => ({ character: profile.character, weapon: 'sword', armor: 'medium', helmet: 'none' }))) : duel ?? null;
  return { type: 'tournament', role: you === null ? 'spectator' : 'member', code, tournamentId: `tournament-${code}`, duelId: waiting ? `tournament-${code}` : `match-${code}`, revision, phase, you,
    players: roster, capacity: 8, spectator: matchYou === null, currentMatchIndex: waiting ? null : 0, bracket: [], champion: null,
    match: waiting ? null : { code, duelId: `match-${code}`, revision, phase, you: matchYou, slots: [0, 1], players: roster.slice(0, 2),
      ready: [true, true], pending: [false, false], rematchReady: [false, false], yourLoadout: matchYou === null ? null : { weapon: 'sword', armor: 'medium', helmet: 'none' },
      duel: activeDuel, decision: null, deadline: Date.now() + 60000, mercyOpensAt: Date.now() - 1000,
      rules: { actionMs: 20000, equipmentMs: 90000, entranceMs: 8000, intermissionMs: 6000 } } };
}

// Run actual app routing, render and poll handlers. Only the persistent chat
// controller, browser/art/media/network boundaries are replaced by spies.
function fixture({ search = '', firstArrival = false, startupRun = true, playback = async () => {}, loserOutcome = async () => {}, hostId = 'arena-chat', chatMethod = true } = {}) {
  const handlers = new Map(), mounts = [], rooms = [], calls = [], timers = new Map(), chatReads = [], chatSends = [], refreshes = [];
  let nextTimer = 0, clock = Date.now(), arrivalOptions, arrivalSeen = !firstArrival;
  const stage = { closest: () => null, querySelector: selector => selector === '.battle-hud' ? null : { setAttribute() {}, removeAttribute() {} }, replaceWith() {} };
  const app = { id: 'app', innerHTML: '', inert: false, classList: { toggle() {} }, setAttribute() {},
    addEventListener: (name, handler) => handlers.set(`app-${name}`, handler), querySelector: selector => selector === '.arena-stage' ? stage : null, querySelectorAll: () => [] };
  const chatHost = { id: hostId, innerHTML: 'Persistent chat panel', draft: '', hidden: true };
  const session = { character: character('Cassian', 'fighter-0'), alive: true, duelWins: 0, tournamentWins: 0, activeTournament: null, activeRoom: null };
  class Client {
    constructor() { this.sessionMode = 'temporary'; this.token = null; this.view = null; }
    async session(options) { calls.push({ kind: 'session', options: plain(options) }); return this.token ? session : null; }
    async tournaments() { return { tournaments: [] }; }
    async leaderboard() { return { fighters: [] }; }
    async graveyard() { return { graves: [] }; }
    async room(code) { calls.push({ kind: 'room', code }); return this.view; }
    async observe(code) { calls.push({ kind: 'observe', code }); return this.view; }
    async chat(code) { chatReads.push(code); return { code, tournamentId: `tournament-${code}`, messages: [], canSend: true, you: null, maxLength: 240, minIntervalMs: 2000 }; }
    async sendChat(code, payload) { chatSends.push({ code, payload: plain(payload) }); return { code, tournamentId: `tournament-${code}`, messages: [{ id: 'new-message', text: payload.text }] }; }
    async command(view, action, payload) { calls.push({ kind: 'command', code: view.code, action, payload: plain(payload) }); return view; }
    resetMatchContext() {}
  }
  if (!chatMethod) delete Client.prototype.chat;
  let chatOptions = null, activeRoom = null;
  const chat = {
    setRoom(room) { activeRoom = room; rooms.push(plain(room)); chatHost.hidden = !room; },
    async refresh() { refreshes.push(plain(activeRoom)); if (activeRoom) return chatOptions.read(activeRoom.code); },
    hide() { activeRoom = null; rooms.push(null); chatHost.hidden = true; },
    dispose() { activeRoom = null; chatHost.hidden = true; },
  };
  const context = vm.createContext({
    ...audioBindings, ...combat, ...presentation, ...menu, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    renderArmory, renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance,
    structuredClone, URLSearchParams, AbortController, console,
    Date: class extends Date { static now() { return clock; } },
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    location: { search }, navigator: {}, window: { scrollTo() {} }, document: { visibilityState: 'visible', activeElement: null,
      querySelector: selector => selector === '#arena-chat' ? chatHost : selector === '#audio-controls' ? null : app,
      addEventListener: (name, handler) => handlers.set(`document-${name}`, handler) },
    mountArenaChat(host, options) { mounts.push(host); chatOptions = options; return chat; },
    OnlineClient: Client, TournamentClient: Client, preloadCleanArt: async () => {}, prepareCleanAvatar: async () => {}, renderCleanAvatar: () => '', renderArena: () => '<svg></svg>',
    buildAnimationSteps: () => [], playBattleAnimation: (...args) => { calls.push({ kind: 'animation' }); return playback(...args); },
    buildExecutionEvent, playExecutionAnimation: async () => {}, renderMercyPanel, playLoserOutcome: loserOutcome,
    createArrivalController: options => { arrivalOptions = options; return {
      shouldShow: () => !arrivalSeen, mount() { arrivalSeen = true; app.innerHTML = 'Arrival'; return true; }, replay() { app.innerHTML = 'Arrival'; return true; }, dispose() {},
    }; },
  });
  const expose = `globalThis.fixture = { state, render, pollOnline, applyOnlineView, applyTournamentView, performOnline, detachObserver, newSession, startLoserOutcome,
    get client() { return onlineClient; }, get tournament() { return tournamentView; }, get playback() { return roundPlayback; }, get spectatorPlayback() { return spectatorPlayback; },
    get onlineBusy() { return onlineBusy; }, get arrivalComplete() { return arrivalComplete; },
    set observer(value) { observerMode = value; }, set arrivalComplete(value) { arrivalComplete = value; } };`;
  const ready = startupRun ? vm.runInContext(`(async () => { ${definitions}\n${expose}\n${appSource.slice(startup)} })()`, context) : vm.runInContext(definitions + expose, context);
  const ui = context.fixture;
  Object.assign(ui, { app, chatHost, chat, mounts, rooms, calls, chatReads, chatSends, refreshes, ready: Promise.resolve(ready) });
  ui.activeRoom = () => plain(activeRoom);
  ui.advance = milliseconds => { clock += milliseconds; };
  ui.finishArrival = async () => { arrivalOptions.onComplete(); await settle(); };
  ui.send = (...args) => chatOptions.send(...args);
  ui.emit = async (name, event = {}) => { await handlers.get(name)?.(event); await settle(); };
  return ui;
}

test('waiting and spectator routes retain one external chat host across accepted app rerenders', async () => {
  const ui = fixture(); await ui.ready;
  assert.equal(ui.mounts.length, 1); assert.equal(ui.mounts[0], ui.chatHost);
  assert.equal(ui.activeRoom(), null);
  ui.applyTournamentView(tournament({ phase: 'waiting', you: 6 }), { animate: false }); await settle();
  assert.equal(ui.state.screen, 'tournament-lobby');
  assert.deepEqual(ui.activeRoom(), { code: 'ABC234', tournamentId: 'tournament-ABC234', visible: true, expanded: true });
  ui.chatHost.draft = 'Keep this unfinished message.';
  const chatMarkup = ui.chatHost.innerHTML;
  await ui.render();
  ui.applyTournamentView(tournament({ revision: 2, you: 6 }), { animate: false }); await settle();
  assert.equal(ui.state.screen, 'tournament-spectator'); assert.equal(ui.activeRoom().code, 'ABC234');
  assert.equal(ui.mounts.length, 1); assert.equal(ui.chatHost.innerHTML, chatMarkup);
  assert.equal(ui.chatHost.draft, 'Keep this unfinished message.');
  assert.doesNotMatch(ui.app.innerHTML, /Persistent chat panel/);
});

test('active duelists retain the same chat room through loadout, entrance and battle with a collapsed default', async () => {
  const ui = fixture(); await ui.ready;
  for (const [index, phase] of ['equipment', 'entrance', 'battle'].entries()) {
    ui.applyTournamentView(tournament({ phase, revision: index + 1, you: 0, matchYou: 0 }), { animate: false }); await settle();
    assert.equal(ui.activeRoom().code, 'ABC234'); assert.equal(ui.activeRoom().tournamentId, 'tournament-ABC234');
    assert.equal(ui.activeRoom().visible, true); assert.equal(ui.activeRoom().expanded, false);
  }
  assert.equal(ui.state.screen, 'battle'); assert.equal(ui.mounts.length, 1);
});

test('chat refreshes independently of unchanged tournament revisions and observes its separate interval', async () => {
  const ui = fixture(); await ui.ready;
  const view = tournament({ phase: 'waiting', you: 6 }); ui.client.view = view;
  ui.applyTournamentView(view, { animate: false }); await settle();
  const markup = ui.app.innerHTML;
  await ui.pollOnline(); await settle();
  assert.deepEqual(ui.chatReads, ['ABC234']); assert.equal(ui.app.innerHTML, markup);
  await ui.pollOnline(); await settle(); assert.equal(ui.chatReads.length, 1);
  ui.advance(2000); await ui.pollOnline(); await settle();
  assert.deepEqual(ui.chatReads, ['ABC234', 'ABC234']); assert.equal(ui.app.innerHTML, markup);
  assert.equal(ui.calls.filter(call => call.kind === 'command').length, 0);
});

test('spectator chat refresh and its external send callback remain usable throughout a real round playback', async () => {
  const hold = deferred(), ui = fixture({ playback: () => hold.promise }); await ui.ready;
  const before = tournament(); ui.client.view = before;
  ui.applyTournamentView(before, { animate: false }); await settle();
  const after = tournament({ revision: 2, duel: combat.resolveRound(before.match.duel, ['strike', 'strike']) });
  ui.applyTournamentView(after); await settle(); assert.ok(ui.spectatorPlayback); assert.equal(ui.state.phase, 'playback');
  ui.client.view = after;
  await ui.pollOnline(); await settle(); assert.equal(ui.chatReads.at(-1), 'ABC234');
  const result = await ui.send('ABC234', { commandId: 'message-during-playback', text: 'That was close.' });
  assert.equal(result.messages[0].text, 'That was close.');
  assert.deepEqual(ui.chatSends, [{ code: 'ABC234', payload: { commandId: 'message-during-playback', text: 'That was close.' } }]);
  assert.ok(ui.spectatorPlayback); assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.calls.filter(call => call.kind === 'command').length, 0);
  ui.advance(2000); await ui.pollOnline(); await settle(); assert.equal(ui.chatReads.length, 2);
  hold.resolve(true); await settle(); assert.equal(ui.spectatorPlayback, null);
});

test('an outstanding game command does not block lobby chat polling or add any combat intentions', async () => {
  const hold = deferred(), ui = fixture(); await ui.ready;
  const view = tournament({ phase: 'waiting', you: 6 }); ui.client.view = view;
  ui.applyTournamentView(view, { animate: false }); await settle();
  const gameRequest = ui.performOnline(() => hold.promise); await settle(); assert.equal(ui.onlineBusy, true);
  await ui.pollOnline(); await settle(); assert.equal(ui.chatReads.at(-1), 'ABC234');
  await ui.send('ABC234', { commandId: 'waiting-with-friends', text: 'Waiting for the last fighter.' });
  assert.equal(ui.chatSends.length, 1); assert.equal(ui.onlineBusy, true);
  assert.equal(ui.calls.filter(call => call.kind === 'command').length, 0);
  hold.resolve(view); await gameRequest; await settle(); assert.equal(ui.onlineBusy, false);
});

test('leaving the stands and starting a new local session hide chat immediately before another app render', async () => {
  const ui = fixture(); await ui.ready; ui.observer = true;
  ui.applyTournamentView(tournament(), { animate: false }); await settle(); assert.equal(ui.activeRoom().visible, true);
  ui.detachObserver(); assert.equal(ui.activeRoom(), null); assert.equal(ui.chatHost.hidden, true);
  ui.applyTournamentView(tournament({ revision: 2, phase: 'waiting', you: 6 }), { animate: false }); await settle();
  assert.equal(ui.activeRoom().visible, true);
  ui.state.mode = 'cpu'; ui.newSession(); assert.equal(ui.activeRoom(), null); await settle();
  assert.equal(ui.chatHost.hidden, true);
});

test('arrival and the defeated player death replay hide chat until the player returns to a new tournament', async () => {
  const hold = deferred(), ui = fixture({ firstArrival: true, loserOutcome: () => hold.promise }); await ui.ready;
  assert.equal(ui.arrivalComplete, false); assert.equal(ui.activeRoom(), null); assert.equal(ui.app.innerHTML, 'Arrival');
  await ui.finishArrival();
  const view = tournament({ you: 1, matchYou: 1 });
  ui.client.view = view;
  ui.applyTournamentView(view, { animate: false }); await settle(); assert.equal(ui.activeRoom().visible, true);
  const defeated = combat.forfeitDuel(view.match.duel, 1); ui.state.duel = defeated;
  ui.startLoserOutcome({ decision: 'execute', profileId: 'fighter-1', duel: defeated, online: true, view });
  assert.equal(ui.activeRoom(), null); await settle(); assert.equal(ui.state.phase, 'outcome');
  ui.advance(2000); await ui.pollOnline(); await settle(); assert.equal(ui.activeRoom(), null);
  hold.resolve(true); await settle();
  assert.equal(ui.arrivalComplete, false); assert.equal(ui.app.innerHTML, 'Arrival'); assert.equal(ui.activeRoom(), null);
  await ui.finishArrival(); assert.equal(ui.state.screen, 'creator'); assert.equal(ui.activeRoom(), null);
});

test('legacy duels, local practice and review diagnostics do not expose a tournament chat room', async () => {
  const legacy = fixture({ search: '?duel-mode=1' }); await legacy.ready;
  const view = tournament({ you: 0, matchYou: 0 });
  legacy.applyOnlineView({ ...view.match }, { animate: false }); await settle();
  assert.equal(legacy.state.screen, 'battle'); assert.equal(legacy.activeRoom(), null);
  const local = fixture(); await local.ready; local.state.mode = 'cpu'; local.state.screen = 'creator'; await local.render();
  assert.equal(local.activeRoom(), null);
  const preset = fixture({ search: '?face-presets-review=1' }); await preset.ready; assert.equal(preset.activeRoom(), null);
  const spectator = fixture({ search: '?spectator-frame-review=1', startupRun: false });
  assert.equal(spectator.mounts.length, 0); assert.equal(spectator.activeRoom(), null);
});

test('a missing external host or historical client without chat support preserves ordinary game startup', async () => {
  for (const options of [{ hostId: 'app' }, { chatMethod: false }]) {
    const ui = fixture(options); await ui.ready;
    assert.equal(ui.mounts.length, 0); assert.equal(ui.state.screen, 'menu');
    await ui.pollOnline(); assert.equal(ui.chatReads.length, 0);
  }
});
