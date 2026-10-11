import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { audioBindings } from './fixtures/audio-stub.js';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import * as menu from '../src/main-menu.js';
import * as tutorial from '../src/fight-tutorial.js';
import { createArenaInvite } from '../src/arena-invite.js';
import { avatarChoices, normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';
import { renderArmory } from '../src/armory.js';
import { renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance } from '../src/tournament-view.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = appSource.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
assert.ok(startup > 0);
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let count = 0; count < 32; count++) await Promise.resolve(); };
const character = (appearance = normalizePresetAppearance({ sex: 'female', facePreset: 'p10' })) => ({
  id: 'owned-fighter', name: 'Nessa', stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b45143', appearance,
});
const savedSession = appearance => ({ playerId: 'guest-owner', character: character(appearance),
  alive: true, duelWins: 9, tournamentWins: 2, activeTournament: null, activeRoom: null });
const waitingTournament = own => ({ type: 'tournament', role: 'member', code: 'ABC234', tournamentId: 'tournament-ABC234',
  duelId: 'tournament-ABC234', phase: 'waiting', revision: 1, you: 0, capacity: 8, players: [
    { character: own, alive: true, duelWins: 9, tournamentWins: 2, eliminated: false, left: false, connected: true },
  ], bracket: [], currentMatchIndex: null, spectator: true, nextBotAt: null, nextMatchAt: null, champion: null, crowdVote: null, match: null });
const singlePlayerTournament = own => {
  const view = waitingTournament(own);
  view.singlePlayer = true; view.phase = 'equipment'; view.currentMatchIndex = 0; view.spectator = false;
  for (let index = 1; index < 8; index++) view.players.push({ character: { ...character(), id: `bot-${index}`, name: `Bot ${index}` },
    bot: true, botStyle: 'patient', alive: true, duelWins: 0, tournamentWins: 0, eliminated: false, left: false, connected: true });
  view.bracket = Array.from({ length: 7 }, (_, index) => ({ index, label: index < 4 ? `Quarterfinal ${index + 1}` : index < 6 ? `Semifinal ${index - 3}` : 'Final',
    slots: index < 4 ? [index * 2, index * 2 + 1] : [null, null], status: index === 0 ? 'equipment' : 'pending', winner: null }));
  view.match = { code: view.code, duelId: 'match-1', revision: 1, phase: 'equipment', you: 0, slots: [0, 1],
    players: view.players.slice(0, 2), ready: [false, true], pending: [false, false], yourLoadout: null,
    duel: null, decision: null, deadline: Date.now() + 60000 };
  return view;
};

// Same boundary substitutions as menu-ui: actual startup/render/event handlers,
// with disposable browser, art/media and service fixtures.
function fixture({ restoredSession = null, restoredView = null, search = '', animation } = {}) {
  const handlers = new Map(), calls = [], prepared = [], tutorialPrepared = [], animations = [], classes = new Set();
  let sessionValue = restoredSession, timerId = 0;
  const stage = { querySelector: () => null, querySelectorAll: () => [] };
  const app = { innerHTML: '', inert: false,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
    addEventListener: (kind, handler) => handlers.set(kind, handler), querySelectorAll: () => [],
    querySelector: selector => selector === '.arena-stage' && app.innerHTML.includes('tutorial-arena') ? stage : null, setAttribute() {},
  };
  class Client {
    constructor({ duelMode = false, singlePlayer = false } = {}) { this.duelMode = duelMode; this.singlePlayer = singlePlayer; this.token = restoredSession ? 'saved-token' : ''; this.sessionMode = 'temporary'; }
    async session(options = {}) { calls.push({ kind: 'session', create: options.create !== false }); return sessionValue; }
    async room(code) { calls.push({ kind: 'room', code }); return restoredView; }
    resetMatchContext() { calls.push({ kind: 'reset-context', duelMode: this.duelMode }); }
    async create(chosen) {
      calls.push({ kind: 'create', duelMode: this.duelMode, singlePlayer: this.singlePlayer, character: plain(chosen) });
      const own = { ...plain(chosen), id: chosen.id ?? 'created-fighter' };
      sessionValue = { ...savedSession(), character: own, activeRoom: this.duelMode ? 'ABC234' : null, activeTournament: this.duelMode ? null : 'ABC234' };
      if (!this.duelMode) return this.singlePlayer ? singlePlayerTournament(own) : waitingTournament(own);
      return { code: 'ABC234', duelId: 'duel-ABC234', revision: 1, phase: 'waiting', you: 0, players: [
        { character: own, alive: true, duelWins: 9 }, null,
      ], ready: [false, false], pending: [false, false], yourLoadout: null, duel: null, deadline: null };
    }
    async join(code, chosen) { calls.push({ kind: 'join', code, character: plain(chosen), duelMode: this.duelMode }); return restoredView; }
    async command(view, action) {
      calls.push({ kind: 'command', code: view?.code, action });
      if (action !== 'leave') return view;
      sessionValue = { ...sessionValue, activeTournament: null, activeRoom: null };
      return { left: true };
    }
  }
  const context = vm.createContext({
    ...audioBindings, ...combat, ...presentation, ...menu, ...tutorial, createArenaInvite,
    avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    renderArmory, renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance,
    structuredClone, URLSearchParams, AbortController, console,
    setTimeout: () => ++timerId, clearTimeout() {}, setInterval: () => ++timerId, clearInterval() {},
    location: { search, origin: 'http://127.0.0.1:4175' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: selector => selector === '#app' ? app : null, addEventListener() {}, activeElement: null },
    OnlineClient: Client, TournamentClient: Client,
    preloadCleanArt: async () => {}, prepareCleanAvatar: async (appearance, mode, gear) => prepared.push({ appearance: plain(appearance), mode, gear: plain(gear ?? {}) }),
    prepareFightTutorial: async state => tutorialPrepared.push(plain(state)),
    renderCleanAvatar: () => '<svg class="fixture-avatar"></svg>', renderArena: () => '<svg class="fixture-arena"></svg>',
    buildAnimationSteps: (before, after) => [{ before: plain(before), after: plain(after) }],
    playBattleAnimation: async (container, steps, options) => { animations.push({ container, steps, signal: options.signal }); if (animation) await animation(options); },
    buildExecutionEvent, playExecutionAnimation: async () => {}, renderMercyPanel, playLoserOutcome: async () => {},
    createArrivalController: () => ({ shouldShow: () => false, mount() {}, replay() {}, dispose() {}, active: false }),
  });
  const expose = `globalThis.fixture = { state, client: onlineClient, render, pollOnline, applyTournamentView,
    get tutorial() { return tutorialState; }, get tutorialPlaying() { return tutorialPlaying; },
    get session() { return onlineSession; }, get view() { return onlineView; },
    get roomCode() { return roomCodeDraft; }, get tournamentEnabled() { return tournamentEnabled; } };`;
  const ready = vm.runInContext(`(async () => { ${definitions}\n${expose}\n${appSource.slice(startup)} })()`, context, { filename: 'src/app.js' });
  const ui = context.fixture;
  Object.assign(ui, { app, calls, prepared, tutorialPrepared, animations, ready: Promise.resolve(ready) });
  ui.click = async (action, data = {}) => {
    await handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: {
      action, ...(action === 'name-next' ? { index: String(ui.state.nameIndex) } : {}), ...data,
    } }) }, preventDefault() {} });
    await settle();
  };
  ui.inputName = value => { handlers.get('input')({ target: { hasAttribute: () => false, dataset: { name: '0' }, value } }); };
  return ui;
}

test('the actual app completes and repeats the optional lesson without obtaining a guest or changing drafts', async () => {
  const ui = fixture(); await ui.ready;
  const before = plain(ui.state.drafts), callsBefore = plain(ui.calls);
  await ui.click('menu-learn');
  assert.equal(ui.state.screen, 'tutorial');
  assert.match(ui.app.innerHTML, /Lesson 1 of 3/);
  assert.equal(ui.tutorialPrepared.length, 1);
  for (const action of ['guard', 'technique', 'focus']) {
    await ui.click('tutorial-move', { value: action });
    assert.equal(ui.tutorial.phase, 'review');
    await ui.click('tutorial-next');
  }
  assert.equal(ui.tutorial.phase, 'complete');
  assert.equal(ui.animations.length, 3);
  assert.deepEqual(ui.animations.map(entry => entry.steps[0].after.lastRound.actions), [['guard', 'strike'], ['technique', 'guard'], ['focus', 'technique']]);
  assert.deepEqual(plain(ui.state.drafts), before);
  await ui.pollOnline();
  assert.deepEqual(plain(ui.calls), callsBefore, 'A guestless lesson never sends a session, join or combat command.');
  await ui.click('tutorial-restart');
  assert.equal(ui.tutorial.step, 0); assert.equal(ui.tutorial.phase, 'choose');
  await ui.click('menu-home');
  assert.equal(ui.state.screen, 'menu'); assert.equal(ui.tutorial, null);
  assert.deepEqual(plain(ui.state.drafts), before);
});

test('saved legacy and preset fighters remain exact across learning and Single Player entry', async () => {
  for (const appearance of [normalizeAppearance({ sex: 'female', hairstyle: 'braided_ponytail', eyes: 'jade' }), normalizePresetAppearance({ sex: 'male', facePreset: 'p10' })]) {
    const owned = savedSession(appearance), before = structuredClone(owned), ui = fixture({ restoredSession: owned }); await ui.ready;
    const draftsBefore = plain(ui.state.drafts);
    await ui.click('menu-learn'); await ui.click('tutorial-move', { value: 'guard' }); await ui.click('menu-home');
    assert.deepEqual(plain(ui.state.drafts), draftsBefore);
    assert.deepEqual(plain(ui.session), before);
    assert.deepEqual(owned, before);
    await ui.click('menu-single-player');
    assert.equal(ui.state.screen, 'creator'); assert.equal(ui.client.duelMode, false); assert.equal(ui.client.singlePlayer, true); assert.equal(ui.tournamentEnabled, true);
    assert.equal(ui.state.creatorStep, 'customize'); assert.equal(ui.state.locked[0], true);
    assert.deepEqual(plain(ui.state.drafts[0]), before.character);
    assert.equal(ui.session.duelWins, 9); assert.equal(ui.session.tournamentWins, 2);
    assert.match(ui.app.innerHTML, /aria-label="Start a single player tournament"/);
    assert.match(ui.app.innerHTML, /data-action="online-create"[^>]*>Start tournament/);
    assert.doesNotMatch(ui.app.innerHTML, /data-room-code|data-action="online-join"|Create room/);
    assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER/);
    await ui.click('online-create');
    assert.equal(ui.state.screen, 'loadout');
    const created = ui.calls.find(call => call.kind === 'create');
    assert.equal(created.duelMode, false); assert.equal(created.singlePlayer, true); assert.deepEqual(created.character, before.character);
    assert.match(ui.app.innerHTML, /Facing <strong>Bot 1<\/strong>/);
    assert.doesNotMatch(ui.app.innerHTML, /Copy code|Copy invite|ROOM <strong>|ABC234/);
    assert.deepEqual(owned, before);
  }
});

test('new Single Player uses the normal naming and p05 creator before starting a bot tournament', async () => {
  const ui = fixture(); await ui.ready; await ui.click('menu-single-player');
  assert.equal(ui.state.creatorStep, 'name'); assert.equal(ui.state.drafts[0].appearance.facePreset, 'p05');
  assert.equal(ui.calls.some(call => call.kind === 'session' && call.create), false);
  assert.equal(ui.calls.some(call => call.kind === 'create'), false);
  ui.inputName('  Aster  '); await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize'); assert.equal(ui.state.drafts[0].name, 'Aster');
  await ui.click('online-create');
  assert.equal(ui.calls.find(call => call.kind === 'create').character.name, 'Aster');
  assert.equal(ui.calls.find(call => call.kind === 'create').singlePlayer, true);
  assert.equal(ui.calls.find(call => call.kind === 'create').duelMode, false);
  assert.equal(ui.state.screen, 'loadout');
});

test('restored Single Player resumes equipment and retains bot tournament entry after completing the bracket', async () => {
  const owned = { ...savedSession(), activeTournament: 'ABC234' }, before = structuredClone(owned);
  const restored = singlePlayerTournament(owned.character);
  const ui = fixture({ restoredSession: owned, restoredView: restored, search: '?duel-mode=1' }); await ui.ready;
  assert.equal(ui.state.screen, 'loadout'); assert.equal(ui.client.singlePlayer, true); assert.equal(ui.client.duelMode, false);
  assert.match(ui.app.innerHTML, /Single Player/);
  assert.equal(ui.calls.some(call => call.kind === 'create'), false);
  const complete = { ...restored, revision: 10, phase: 'complete', champion: 0, match: null };
  ui.applyTournamentView(complete, { animate: false }); await settle();
  assert.match(ui.app.innerHTML, /data-action="tournament-next"/);
  await ui.click('tournament-next');
  assert.equal(ui.state.screen, 'loadout');
  const created = ui.calls.find(call => call.kind === 'create');
  assert.equal(created.singlePlayer, true); assert.deepEqual(created.character, before.character);
  assert.deepEqual(owned, before);
});

test('Single Player returns directly to the human semifinal and renders only the outcome when bots finish after elimination', async () => {
  const owned = { ...savedSession(), activeTournament: 'ABC234' };
  const intermission = singlePlayerTournament(owned.character);
  intermission.phase = 'intermission'; intermission.match.phase = 'intermission'; intermission.nextMatchAt = Date.now() + 6000;
  const ui = fixture({ restoredSession: owned, restoredView: intermission }); await ui.ready;
  const semifinal = singlePlayerTournament(owned.character);
  semifinal.revision = 8; semifinal.currentMatchIndex = 4;
  semifinal.bracket[4].slots = [0, 4]; semifinal.bracket[4].status = 'equipment';
  semifinal.match.duelId = 'semifinal-1'; semifinal.match.slots = [0, 4]; semifinal.match.players = [semifinal.players[0], semifinal.players[4]];
  ui.applyTournamentView(semifinal); await settle();
  assert.equal(ui.state.screen, 'loadout'); assert.match(ui.app.innerHTML, /Semifinal 1/);
  assert.match(ui.app.innerHTML, /Facing <strong>Bot 4<\/strong>/);
  assert.equal(ui.animations.length, 0); assert.equal(ui.client.singlePlayer, true);
  let botDuel = combat.createDuel(semifinal.players.slice(4, 6).map(profile => ({ character: profile.character, weapon: 'sword', armor: 'medium' })));
  while (botDuel.status === 'active') botDuel = combat.resolveRound(botDuel, ['strike', 'strike']);
  const complete = { ...semifinal, revision: 20, phase: 'complete', currentMatchIndex: 6, champion: 4,
    match: { ...semifinal.match, duelId: 'bot-final', phase: 'complete', you: null, slots: [4, 5], players: semifinal.players.slice(4, 6), duel: botDuel } };
  complete.players[0].eliminated = true;
  ui.applyTournamentView(complete); await settle();
  assert.equal(ui.state.screen, 'tournament-spectator'); assert.match(ui.app.innerHTML, /Bot 4 takes the crown/);
  assert.doesNotMatch(ui.app.innerHTML, /class="fixture-arena"|data-action="action"|data-action="lock-loadout"/);
  assert.equal(ui.animations.length, 0); assert.equal(ui.client.singlePlayer, true);
});

test('leaving Single Player for the menu and choosing Fight restores the ordinary tournament creator', async () => {
  const ui = fixture(); await ui.ready; await ui.click('menu-single-player');
  ui.inputName('Aster'); await ui.click('name-next');
  assert.equal(ui.client.singlePlayer, true);
  await ui.click('online-join');
  assert.equal(ui.calls.some(call => call.kind === 'join'), false);
  await ui.click('menu-home'); await ui.click('menu-fight');
  assert.equal(ui.client.singlePlayer, false); assert.equal(ui.client.duelMode, false);
  assert.equal(ui.state.drafts[0].name, 'Aster');
  assert.match(ui.app.innerHTML, /Join friends with a lobby code/);
  await ui.click('online-create');
  assert.equal(ui.calls.find(call => call.kind === 'create').singlePlayer, false);
  assert.equal(ui.state.screen, 'tournament-lobby');
});

test('Main menu can exit in-progress tutorial playback and a late animation cannot replace it', async () => {
  let release;
  const animation = new Promise(resolve => { release = resolve; });
  const ui = fixture({ animation: () => animation }); await ui.ready; await ui.click('menu-learn');
  const pending = ui.click('tutorial-move', { value: 'guard' }); await settle();
  assert.equal(ui.tutorialPlaying, true);
  await ui.click('menu-home');
  assert.equal(ui.animations[0].signal.aborted, true);
  release(); await pending;
  assert.equal(ui.state.screen, 'menu'); assert.equal(ui.tutorial, null); assert.equal(ui.tutorialPlaying, false);
  assert.match(ui.app.innerHTML, /data-action="menu-learn"/);
});

test('a restored active tournament takes precedence over a Quick Duel invitation', async () => {
  const owned = { ...savedSession(), activeTournament: 'ABC234' }, before = structuredClone(owned);
  const ui = fixture({ restoredSession: owned, restoredView: waitingTournament(owned.character), search: '?duel-mode=1&invite=XYZ789' });
  await ui.ready;
  assert.equal(ui.state.screen, 'tournament-lobby'); assert.equal(ui.view.code, 'ABC234');
  assert.deepEqual(ui.calls.filter(call => call.kind === 'room'), [{ kind: 'room', code: 'ABC234' }]);
  assert.equal(ui.calls.some(call => ['create', 'join'].includes(call.kind)), false);
  await ui.click('menu-learn');
  assert.equal(ui.state.screen, 'tournament-lobby', 'Training cannot displace an active owned tournament.');
  assert.deepEqual(owned, before);
});

test('only valid public invite codes prefill the normal creator and never auto-join', async () => {
  for (const quick of [false, true]) {
    const link = createArenaInvite('http://127.0.0.1:4175', 'XYZ789', { duel: quick });
    const ui = fixture({ search: new URL(link).search }); await ui.ready;
    assert.equal(ui.state.screen, 'creator'); assert.equal(ui.roomCode, 'XYZ789');
    assert.equal(ui.client.duelMode, quick); assert.equal(ui.tournamentEnabled, !quick);
    assert.equal(ui.calls.some(call => ['create', 'join'].includes(call.kind) || call.kind === 'session' && call.create), false);
    ui.inputName('Aster'); await ui.click('name-next');
    assert.match(ui.app.innerHTML, /data-room-code[^>]*value="XYZ789"/);
  }
  for (const search of ['?invite=%22%3E%3Cscript%3E', '?invite=xyz789', '?invite=XYZ789LONG', '?invite=']) {
    const ui = fixture({ search }); await ui.ready;
    assert.equal(ui.roomCode, ''); assert.equal(ui.state.screen, 'menu');
    assert.doesNotMatch(ui.app.innerHTML, /<script>/);
    assert.equal(ui.calls.some(call => ['create', 'join'].includes(call.kind)), false);
  }
});
