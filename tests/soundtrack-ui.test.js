import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import * as menu from '../src/main-menu.js';
import { avatarChoices, normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';
import { renderArmory } from '../src/armory.js';
import { renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance } from '../src/tournament-view.js';
import { mountAudioControls } from '../src/audio-controls.js';
import { createGameAudio as createRealGameAudio } from '../src/game-audio.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = appSource.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
assert.ok(startup > 0);
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let count = 0; count < 24; count++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const character = (name, id) => ({ id, name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', color: '#b45143', appearance: normalizePresetAppearance({ sex: 'male', facePreset: 'p05' }) });
const profiles = () => ['Cassian', 'Mira'].map((name, index) => ({ character: character(name, `fighter-${index}`), alive: true, duelWins: 0 }));
const initialDuel = () => combat.createDuel(profiles().map(profile => ({ character: profile.character, weapon: 'sword', armor: 'medium' })));
function viewFor(duel, { revision = 1, duelId = 'duel-1', phase = 'battle', pending = [false, false] } = {}) {
  return { code: 'ABC234', duelId, revision, phase, you: 0, players: profiles(), ready: [true, true], pending,
    yourLoadout: { weapon: 'sword', armor: 'medium', helmet: 'none' }, duel, decision: null,
    rematchReady: [false, false], deadline: Date.now() + 20000 };
}
function spectatorView(duel, { revision = 1, duelId = 'match-1', phase = 'battle' } = {}) {
  const players = Array.from({ length: 8 }, (_, index) => ({ ...profiles()[index % 2], character: character(`Fighter ${index + 1}`, `player-${index}`), left: false, eliminated: false, connected: true }));
  const match = { ...viewFor(duel, { revision, duelId, phase }), you: null, slots: [0, 1], players: players.slice(0, 2),
    rules: { entranceMs: 8000, actionMs: 20000, equipmentMs: 90000, intermissionMs: 6000 }, mercyOpensAt: Date.now() - 1000 };
  return { type: 'tournament', role: 'spectator', code: 'ABC234', tournamentId: 'tournament-1', duelId, revision, phase,
    you: null, players, spectator: true, capacity: 8, currentMatchIndex: 0, bracket: [], champion: null, match };
}

// Execute the actual app's accepted-state routing and handlers; media/DOM/network are boundaries.
function fixture({ firstArrival = false, startupRun = false, playback = async () => {}, realControls = false, realAudio = false, denyAutoplay = false, visibilityState = 'visible' } = {}) {
  const handlers = new Map(), scenes = [], effects = [], visibility = [], mounts = [], timers = new Map(), calls = [];
  let nextTimer = 0, unlocks = 0, musicStarts = 0, stops = 0, arrivalOptions, arrivalSeen = !firstArrival, playbackAllowed = !denyAutoplay;
  const stage = { closest: () => null, querySelector: selector => selector === '.battle-hud' ? null : { setAttribute() {}, removeAttribute() {} }, replaceWith() {} };
  const app = { innerHTML: '', inert: false, classList: { toggle() {} }, addEventListener: (name, handler) => handlers.set(`app-${name}`, handler),
    querySelector: selector => selector === '.arena-stage' ? stage : null, querySelectorAll: () => [], setAttribute() {} };
  const audioNodes = new Map(), audioSubscribers = new Set();
  const audioState = { muted: false, musicVolume: .35, effectsVolume: .5, unlocked: false, status: 'ready', trackTitle: '', kind: 'menu' };
  const audioHost = { id: 'audio-controls', innerHTML: 'Persistent audio panel',
    querySelector(selector) { if (!audioNodes.has(selector)) audioNodes.set(selector, { tagName: 'BUTTON', textContent: '', value: '', setAttribute() {}, closest: selected => selected === selector ? audioNodes.get(selector) : null }); return audioNodes.get(selector); },
    addEventListener: (name, handler) => handlers.set(`audio-${name}`, handler), removeEventListener: name => handlers.delete(`audio-${name}`) };
  const notifyAudio = () => { for (const listener of audioSubscribers) listener(audioState); };
  let audio = {
    load: async () => true, setScene: scene => scenes.push(plain(scene)), playEffect: (type, options) => effects.push({ type, options: plain(options ?? {}) }),
    setVisible: visible => visibility.push(visible), stopEffects: () => { stops++; }, unlock: async () => { unlocks++; audioState.unlocked = true; audioState.status = 'playing'; notifyAudio(); },
    startMusic: async () => { musicStarts++; audioState.unlocked = true; audioState.status = 'playing'; notifyAudio(); return true; },
    setMuted: muted => { calls.push({ muted }); audioState.muted = muted; notifyAudio(); },
    getState: () => ({ ...audioState }),
    subscribe: listener => { audioSubscribers.add(listener); listener(audioState); return () => audioSubscribers.delete(listener); }, dispose() {},
  };
  const players = [];
  if (realAudio) {
    const directory = '/public/audio/soundtrack-v001/';
    const track = id => ({ id, title: id === 'menu' ? 'Where the Stars Remember' : id, src: `${directory}${id}.mp3`, durationSeconds: 120 });
    const engine = createRealGameAudio({
      manifestUrl: `${directory}manifest.json`,
      fetcher: async () => ({ ok: true, json: async () => ({ schema: 'arena-fighters.soundtrack.v1', menu: track('menu'), battles: [track('battle-a'), track('battle-b')] }) }),
      createContext: () => null, storage: { getItem: () => null, setItem() {} }, random: () => .25,
      createAudio: () => {
        let source = '';
        const player = { currentTime: 0, playCalls: 0, pauseCalls: 0, sourceChanges: 0, playing: false,
          get src() { return source; }, set src(value) { if (value !== source) { this.currentTime = 0; this.sourceChanges++; } source = value; },
          play() { this.playCalls++; if (!playbackAllowed) return Promise.reject(Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' })); this.playing = true; return Promise.resolve(); },
          pause() { this.pauseCalls++; this.playing = false; }, addEventListener() {}, removeAttribute() {}, load() {} };
        players.push(player); return player;
      },
    });
    audio = { ...engine,
      setScene: scene => { scenes.push(plain(scene)); engine.setScene(scene); },
      unlock: () => { unlocks++; return engine.unlock(); }, startMusic: () => { musicStarts++; return engine.startMusic(); },
      setMuted: value => { calls.push({ muted: value }); engine.setMuted(value); },
    };
  }
  class Client {
    constructor() { this.sessionMode = 'temporary'; }
    async session() { calls.push('session'); return null; }
    async tournaments() { return { tournaments: [] }; }
    async leaderboard() { return { fighters: [] }; }
    async graveyard() { return { graves: [] }; }
  }
  const browserDocument = { visibilityState, activeElement: null,
    querySelector: selector => selector === '#audio-controls' ? audioHost : app,
    addEventListener: (name, handler) => handlers.set(`document-${name}`, handler) };
  audioHost.ownerDocument = browserDocument;
  const context = vm.createContext({
    ...combat, ...presentation, ...menu, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    renderArmory, renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance,
    structuredClone, URLSearchParams, AbortController, console,
    addEventListener: (name, handler) => handlers.set(`window-${name}`, handler),
    setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++nextTimer, clearInterval() {}, location: { search: '' }, navigator: {},
    window: { scrollTo() {}, addEventListener: (name, handler) => handlers.set(`window-${name}`, handler) }, document: browserDocument,
    createGameAudio: () => audio, mountAudioControls: (host, controller) => { mounts.push({ host, controller }); if (realControls) return mountAudioControls(host, controller); },
    OnlineClient: Client, TournamentClient: Client, preloadCleanArt: async () => {}, prepareCleanAvatar: async () => {},
    renderCleanAvatar: () => '', renderArena: () => '<svg></svg>', buildAnimationSteps: () => [],
    playBattleAnimation: (...args) => { calls.push({ animation: args }); return playback(...args); },
    buildExecutionEvent, playExecutionAnimation: async (...args) => calls.push({ execution: args }),
    renderMercyPanel, playLoserOutcome: async () => {},
    createArrivalController: options => {
      arrivalOptions = options;
      return { shouldShow: () => !arrivalSeen, mount() { arrivalSeen = true; app.innerHTML = 'Arrival'; return true; }, replay() { app.innerHTML = 'Arrival'; return true; }, dispose() {} };
    },
  });
  const expose = `globalThis.fixture = { state, render, applyOnlineView, applyTournamentView, startDuel, startLoadouts, newSession, revealWinner, resolveLocalVerdict,
    get arrivalComplete() { return arrivalComplete; }, set arrivalComplete(value) { arrivalComplete = value; },
    get playback() { return roundPlayback; }, get spectatorPlayback() { return spectatorPlayback; } };`;
  const ready = startupRun
    ? vm.runInContext(`(async () => { ${definitions}\n${expose}\n${appSource.slice(startup)} })()`, context)
    : vm.runInContext(definitions + expose, context);
  const ui = context.fixture;
  Object.assign(ui, { app, audioHost, audio, players, scenes, effects, visibility, mounts, calls, document: browserDocument, ready: Promise.resolve(ready) });
  ui.lastScene = () => scenes.at(-1);
  ui.unlocks = () => unlocks;
  ui.musicStarts = () => musicStarts;
  ui.allowPlayback = () => { playbackAllowed = true; };
  ui.stops = () => stops;
  ui.emit = async (name, event = {}) => { await handlers.get(name)?.(event); await settle(); };
  ui.finishArrival = async () => { arrivalOptions.onComplete(); await settle(); };
  return ui;
}

test('arrival, menu, records and creator share the menu route and retain one external audio panel', async () => {
  const ui = fixture({ firstArrival: true, startupRun: true }); await ui.ready;
  assert.deepEqual(ui.lastScene(), { kind: 'menu' });
  assert.equal(ui.mounts.length, 1); assert.equal(ui.mounts[0].host, ui.audioHost); assert.equal(ui.mounts[0].controller, ui.audio);
  await ui.finishArrival(); assert.deepEqual(ui.lastScene(), { kind: 'menu' });
  for (const screen of ['leaderboard', 'graveyard', 'match-browser', 'creator']) {
    ui.state.screen = screen; await ui.render(); assert.deepEqual(ui.lastScene(), { kind: 'menu' });
  }
  assert.equal(ui.mounts.length, 1); assert.equal(ui.audioHost.innerHTML, 'Persistent audio panel');
});

test('permitted best-effort music begins during the intro and keeps its player, position and play call into the menu', async t => {
  const ui = fixture({ firstArrival: true, startupRun: true, realAudio: true });
  t.after(() => ui.audio.dispose()); await ui.ready; await settle();
  assert.equal(ui.arrivalComplete, false); assert.equal(ui.app.innerHTML, 'Arrival');
  assert.equal(ui.audio.getState().kind, 'menu'); assert.equal(ui.audio.getState().status, 'playing');
  assert.equal(ui.musicStarts(), 1); assert.equal(ui.unlocks(), 0);
  assert.equal(ui.players.length, 1);
  const score = ui.players[0]; assert.match(score.src, /menu\.mp3$/); assert.equal(score.playCalls, 1);
  score.currentTime = 17.5;
  await ui.finishArrival();
  assert.equal(ui.state.screen, 'menu'); assert.equal(ui.players.length, 1);
  assert.equal(score.sourceChanges, 1); assert.equal(score.playCalls, 1); assert.equal(score.currentTime, 17.5);
});

test('browser-denied intro music waits for one sound-button gesture without retrying or muting on menu entry', async t => {
  const ui = fixture({ firstArrival: true, startupRun: true, realAudio: true, realControls: true, denyAutoplay: true });
  t.after(() => ui.audio.dispose()); await ui.ready; await settle();
  assert.equal(ui.audio.getState().status, 'blocked'); assert.equal(ui.players[0].playCalls, 1);
  await ui.render(); await ui.finishArrival();
  assert.equal(ui.players[0].playCalls, 1, 'Scene refresh must not retry browser-denied audible autoplay.');
  ui.allowPlayback();
  const toggle = ui.audioHost.querySelector('[data-audio-toggle]');
  await ui.emit('document-pointerdown', { isTrusted: true, target: toggle });
  await ui.emit('audio-click', { target: toggle });
  assert.equal(ui.unlocks(), 1); assert.equal(ui.audio.getState().status, 'playing');
  assert.equal(ui.audio.getState().muted, false); assert.equal(ui.players[0].playCalls, 2);
});

test('a loser death replays the intro with menu music and continues its position into replacement creation', async t => {
  const ui = fixture({ firstArrival: true, startupRun: true, realAudio: true });
  t.after(() => ui.audio.dispose()); await ui.ready; await settle(); await ui.finishArrival();
  ui.state.mode = 'cpu'; ui.state.profiles = profiles(); ui.startDuel(); await settle();
  assert.equal(ui.audio.getState().kind, 'battle');
  ui.state.duel = combat.forfeitDuel(ui.state.duel, 0);
  ui.resolveLocalVerdict('execute'); await settle();
  assert.equal(ui.arrivalComplete, false); assert.equal(ui.app.innerHTML, 'Arrival');
  assert.equal(ui.audio.getState().kind, 'menu'); assert.equal(ui.audio.getState().status, 'playing');
  const score = ui.players[0], sourceChanges = score.sourceChanges, playCalls = score.playCalls;
  score.currentTime = 9.25; await ui.finishArrival();
  assert.equal(ui.state.screen, 'creator'); assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.state.drafts[0].name, ''); assert.equal(ui.players.length, 1);
  assert.equal(score.sourceChanges, sourceChanges); assert.equal(score.playCalls, playCalls); assert.equal(score.currentTime, 9.25);
});

test('an initially hidden intro selects the menu score while deferring playback until the page is visible', async t => {
  const ui = fixture({ firstArrival: true, startupRun: true, realAudio: true, visibilityState: 'hidden' });
  t.after(() => ui.audio.dispose()); await ui.ready; await settle();
  assert.equal(ui.audio.getState().kind, 'menu'); assert.equal(ui.audio.getState().status, 'paused');
  assert.equal(ui.players.length, 0);
  ui.document.visibilityState = 'visible'; await ui.emit('document-visibilitychange');
  assert.equal(ui.players.length, 1); assert.equal(ui.audio.getState().status, 'playing');
  assert.match(ui.players[0].src, /menu\.mp3$/);
});

test('a local battle and private action handoffs retain the battle key; a new battle gets a new key', async () => {
  const ui = fixture(); ui.state.mode = 'hotseat'; ui.state.profiles = profiles(); ui.startDuel(); await settle();
  assert.equal(ui.state.screen, 'handoff'); assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'local:1' });
  ui.state.screen = 'battle'; await ui.render(); assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'local:1' });
  ui.state.beforeRound = ui.state.duel; ui.state.pending = ['strike', 'recover'];
  ui.state.phase = 'playback'; await ui.render(); assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'local:1' });
  ui.startLoadouts(); await settle(); assert.deepEqual(ui.lastScene(), { kind: 'menu' });
  ui.startDuel(); await settle(); assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'local:2' });
});

test('online readiness/reconnect revisions keep the battle key and accepted new duel identifiers change it', async () => {
  const ui = fixture(), duel = initialDuel();
  ui.applyOnlineView(viewFor(duel), { animate: false }); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'ABC234:duel-1' });
  ui.applyOnlineView(viewFor(duel, { revision: 2, pending: [true, false] }), { animate: false }); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'ABC234:duel-1' });
  ui.applyOnlineView(viewFor(duel, { revision: 1, duelId: 'stale-duel' }), { animate: false }); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'ABC234:duel-1' });
  ui.applyOnlineView(viewFor(duel, { revision: 3, duelId: 'duel-2' }), { animate: false }); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'ABC234:duel-2' });
});

test('spectator entrance and battle share their match song while queued next-match views wait for playback', async () => {
  const hold = deferred(), ui = fixture({ playback: () => hold.promise }), duel = initialDuel();
  ui.applyTournamentView(spectatorView(duel, { phase: 'entrance' }), { animate: false }); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'tournament-1:match-1' });
  ui.applyTournamentView(spectatorView(duel, { revision: 2 }), { animate: false }); await settle();
  const after = combat.resolveRound(duel, ['strike', 'strike']);
  ui.applyTournamentView(spectatorView(after, { revision: 3 })); await settle();
  assert.ok(ui.spectatorPlayback);
  ui.applyTournamentView(spectatorView(null, { revision: 4, duelId: 'match-2', phase: 'equipment' })); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'tournament-1:match-1' });
  hold.resolve(true); await settle(); assert.deepEqual(ui.lastScene(), { kind: 'menu' });
  ui.applyTournamentView(spectatorView(initialDuel(), { revision: 5, duelId: 'match-2', phase: 'entrance' }), { animate: false }); await settle();
  assert.deepEqual(ui.lastScene(), { kind: 'battle', battleKey: 'tournament-1:match-2' });
});

test('trusted interaction unlocks sound and visibility/page lifecycle only changes audio visibility', async () => {
  const ui = fixture(), snapshot = plain(ui.state);
  await ui.emit('document-pointerdown', { isTrusted: false, target: { closest: () => null } }); assert.equal(ui.unlocks(), 0);
  await ui.emit('document-pointerdown', { isTrusted: true, target: { closest: () => null } }); assert.equal(ui.unlocks(), 1);
  await ui.emit('document-keydown', { isTrusted: true, key: 'x', target: { tagName: 'BODY' } }); assert.equal(ui.unlocks(), 2);
  ui.document.visibilityState = 'hidden'; await ui.emit('document-visibilitychange'); assert.equal(ui.visibility.at(-1), false);
  ui.document.visibilityState = 'visible'; await ui.emit('document-visibilitychange'); assert.equal(ui.visibility.at(-1), true);
  await ui.emit('window-pagehide'); assert.equal(ui.visibility.at(-1), false);
  await ui.emit('window-pageshow'); assert.equal(ui.visibility.at(-1), true);
  assert.deepEqual(plain(ui.state), snapshot);
});

test('the audio toggle owns its pointer/Enter unlock while ordinary game controls retain gesture unlock', async () => {
  const ui = fixture({ realControls: true }), toggle = ui.audioHost.querySelector('[data-audio-toggle]');
  await ui.emit('document-pointerdown', { isTrusted: true, target: toggle });
  await ui.emit('document-keydown', { isTrusted: true, key: 'Enter', target: toggle });
  assert.equal(ui.unlocks(), 0, 'Global capture must not pre-unlock the toggle and turn Enable into Mute.');
  await ui.emit('audio-click', { target: toggle });
  assert.equal(ui.unlocks(), 1); assert.equal(ui.audio.getState().muted, false);
  assert.deepEqual(ui.calls, [{ muted: false }]);
  const gameButton = { tagName: 'BUTTON', closest: () => null };
  await ui.emit('document-pointerdown', { isTrusted: true, target: gameButton });
  assert.equal(ui.unlocks(), 2);
  await ui.emit('document-keydown', { isTrusted: true, key: 'Enter', target: gameButton });
  assert.equal(ui.unlocks(), 3);
});

test('resolved animation hooks forward public cues and winner reveal sounds once per verdict', async () => {
  const ui = fixture({ playback: async (_stage, _steps, options) => options.onCue({ type: 'parry', weapon: 'dagger', counter: true }) });
  const duel = initialDuel(); ui.applyOnlineView(viewFor(duel), { animate: false }); await settle();
  assert.deepEqual(ui.effects, []);
  ui.applyOnlineView(viewFor(combat.resolveRound(duel, ['strike', 'strike']), { revision: 2 })); await settle();
  assert.deepEqual(ui.effects, [{ type: 'parry', options: { weapon: 'dagger', counter: true } }]);
  ui.revealWinner('sound-verdict', Date.now() + 5000); ui.revealWinner('sound-verdict', Date.now() + 5000);
  assert.equal(ui.effects.filter(cue => cue.type === 'victory').length, 1);
});

function controlsFixture() {
  const handlers = new Map(), values = new Map(), calls = [];
  const state = { muted: false, unlocked: false, status: 'ready', musicVolume: .35, effectsVolume: .5, kind: 'menu', trackTitle: '' };
  let listener, unsubscribed = false;
  const host = { innerHTML: '', ownerDocument: { activeElement: null },
    querySelector(selector) { if (!values.has(selector)) values.set(selector, { textContent: '', value: '', attributes: new Map(), setAttribute(name, value) { this.attributes.set(name, value); } }); return values.get(selector); },
    addEventListener: (name, handler) => handlers.set(name, handler), removeEventListener: name => handlers.delete(name) };
  const audio = { getState: () => ({ ...state }),
    subscribe: callback => { listener = callback; callback(state); return () => { unsubscribed = true; }; },
    setMuted: value => { calls.push(['muted', value]); state.muted = value; listener(state); },
    unlock: async () => calls.push(['unlock']), setMusicVolume: value => calls.push(['music', value]), setEffectsVolume: value => calls.push(['effects', value]) };
  const dispose = mountAudioControls(host, audio);
  return { host, calls, values, dispose, unsubscribed: () => unsubscribed,
    update: changes => { Object.assign(state, changes); listener(state); },
    click: () => handlers.get('click')({ target: { closest: () => ({}) } }),
    input: (audioVolume, value) => handlers.get('input')({ target: { dataset: { audioVolume }, value } }), handlers };
}

test('persistent controls enable/unmute/mute audio and preserve slider focus during playback updates', () => {
  const ui = controlsFixture();
  assert.equal(ui.values.get('[data-audio-toggle]').textContent, 'Enable sound');
  ui.click(); assert.deepEqual(ui.calls, [['muted', false], ['unlock']]);
  ui.update({ unlocked: true, status: 'playing', trackTitle: 'DEICIDE - Menu' });
  assert.equal(ui.values.get('[data-audio-toggle]').textContent, 'Mute');
  ui.click(); assert.deepEqual(ui.calls.at(-1), ['muted', true]);
  ui.click(); assert.deepEqual(ui.calls.slice(-2), [['muted', false], ['unlock']]);
  const slider = ui.values.get('[data-audio-volume="music"]'); slider.value = '77'; ui.host.ownerDocument.activeElement = slider;
  ui.update({ musicVolume: .35 }); assert.equal(slider.value, '77');
  ui.input('music', '77'); ui.input('effects', '22'); ui.input('unknown', '80'); ui.input('music', 'NaN');
  assert.deepEqual(ui.calls.slice(-2), [['music', .77], ['effects', .22]]);
  ui.update({ kind: 'cinematic' }); assert.equal(ui.values.get('[data-audio-track]').textContent, '');
  ui.update({ status: 'unavailable' }); assert.match(ui.values.get('[data-audio-status]').textContent, /keep playing/);
  ui.dispose(); assert.equal(ui.unsubscribed(), true); assert.equal(ui.handlers.size, 0);
});

test('unavailable music offers Retry sound and retries playback without muting an unlocked listener', () => {
  const ui = controlsFixture();
  ui.update({ unlocked: true, status: 'unavailable', muted: false });
  const toggle = ui.values.get('[data-audio-toggle]');
  assert.equal(toggle.textContent, 'Retry sound');
  assert.equal(toggle.attributes.get('aria-label'), 'Retry game sound');
  ui.click(); assert.deepEqual(ui.calls, [['muted', false], ['unlock']]);
  ui.dispose();
});
