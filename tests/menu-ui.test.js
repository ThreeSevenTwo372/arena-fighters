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
assert.ok(startup > 0, 'The real app startup boundary must be found.');
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let count = 0; count < 24; count++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const character = (name = 'Nessa', id = 'saved-nessa', appearance = normalizePresetAppearance({ sex: 'female', facePreset: 'p10' })) => ({
  id, name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b45143', appearance,
});
const profile = (name, id) => ({ character: character(name, id), alive: true, duelWins: 0, tournamentWins: 0, eliminated: false, left: false, connected: true });
const savedSession = (appearance) => ({ playerId: 'guest-owner', character: character('Nessa', 'saved-nessa', appearance),
  alive: true, duelWins: 9, tournamentWins: 2, activeTournament: null, activeRoom: null });

function tournament({ phase = 'battle', revision = 2, code = 'ABC234', observer = true, ownCharacter = character(), crowd = null } = {}) {
  const players = Array.from({ length: 8 }, (_, index) => profile(`Fighter ${index + 1}`, `fighter-${index + 1}`));
  players[6] = { ...players[6], character: ownCharacter };
  const bracket = ['Quarterfinal 1', 'Quarterfinal 2', 'Quarterfinal 3', 'Quarterfinal 4', 'Semifinal 1', 'Semifinal 2', 'Championship final'].map((label, index) => ({
    index, label, round: index < 4 ? 'quarterfinal' : index < 6 ? 'semifinal' : 'final',
    slots: index < 4 ? [index * 2, index * 2 + 1] : [null, null], winner: null, loser: null,
    status: index === 0 ? 'active' : 'pending', advanceReason: null,
  }));
  const slots = [0, 1], waiting = phase === 'waiting', choosing = phase === 'equipment';
  let duel = waiting || choosing ? null : combat.createDuel(slots.map((slot, index) => ({
    character: players[slot].character, weapon: index === 0 ? 'sword' : 'spear', armor: 'medium', helmet: 'none',
  })));
  if (['mercy', 'crowd', 'intermission', 'complete'].includes(phase)) {
    duel = structuredClone(duel); duel.status = 'complete'; duel.result = { winner: 0, reason: 'knockout' }; duel.fighters[1].hp = 0;
  }
  return {
    type: 'tournament', role: observer ? 'spectator' : 'member', code, tournamentId: `tournament-${code}`,
    duelId: waiting ? `tournament-${code}` : `match-${code}`, phase, revision, you: observer ? null : 6,
    capacity: 8, players, bracket: waiting ? [] : bracket, currentMatchIndex: waiting ? null : 0,
    spectator: true, nextBotAt: null, nextMatchAt: phase === 'intermission' ? Date.now() + 6000 : null,
    champion: phase === 'complete' ? 0 : null, crowdVote: crowd,
    match: waiting ? null : {
      code, duelId: `match-${code}`, revision, slots, phase, you: null, players: slots.map(slot => players[slot]),
      ready: choosing ? [false, true] : [true, true], pending: [true, false], yourLoadout: null,
      duel, decision: null, crowdVote: crowd, deadline: Date.now() + 20000, mercyOpensAt: Date.now() - 1000,
      rules: { actionMs: 20000, equipmentMs: 120000, entranceMs: 8000, intermissionMs: 6000 }, canRematch: false,
    },
  };
}
const listing = [{ code: 'ABC234', phase: 'battle', playerCount: 8, currentMatchLabel: 'Quarterfinal 1', fighters: ['Fighter 1', 'Fighter 2'] }];

// Execute actual startup, renderers and delegated event handlers. The fixture
// substitutes browser/art/media/network boundaries; it does not select an
// initial screen or call menu handlers in place of startup.
function fixture({ restoredSession = null, restoredView = null, observedView = tournament(), firstArrival = false,
  tournaments = listing, fighters = [], graves = [], sessionMode = 'temporary' } = {}) {
  const handlers = new Map(), calls = [], prepared = [], arrivals = [], timers = new Map();
  let timerId = 0, sessionValue = restoredSession, arrivalSeen = !firstArrival, arrivalOptions;
  const classes = new Set();
  const app = { innerHTML: '', inert: false, classList: {
    add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value),
    toggle(value, enabled = !classes.has(value)) { if (enabled) classes.add(value); else classes.delete(value); return enabled; },
  },
    addEventListener: (kind, handler) => handlers.set(kind, handler), querySelectorAll: () => [], querySelector: () => null, setAttribute() {} };
  class Client {
    constructor() { this.token = restoredSession ? 'saved-token' : ''; this.sessionMode = sessionMode; }
    async session(options = {}) { calls.push({ kind: 'session', create: options.create !== false }); return sessionValue; }
    async room(code) { calls.push({ kind: 'room', code }); return restoredView; }
    async tournaments() { calls.push({ kind: 'tournaments' }); return { tournaments, temporary: sessionMode === 'temporary' }; }
    async observe(code) { calls.push({ kind: 'observe', code }); return observedView; }
    async leaderboard() { calls.push({ kind: 'leaderboard' }); return { fighters, temporary: sessionMode === 'temporary' }; }
    async graveyard() { calls.push({ kind: 'graveyard' }); return { graves, temporary: sessionMode === 'temporary' }; }
    async create(chosen) {
      calls.push({ kind: 'create', character: plain(chosen) });
      await this.session();
      sessionValue = { ...savedSession(), character: { ...plain(chosen), id: chosen.id ?? 'new-fighter' }, duelWins: 0, tournamentWins: 0, activeTournament: 'ABC234' };
      this.token = 'saved-token';
      return tournament({ phase: 'waiting', observer: false, ownCharacter: sessionValue.character });
    }
    async join(code, chosen) { calls.push({ kind: 'join', code, character: plain(chosen) }); return restoredView; }
    async command(chosenView, action, payload = {}) { calls.push({ kind: 'command', action, payload: plain(payload), code: chosenView?.code }); return action === 'leave' ? { left: true } : chosenView; }
    async vote(chosenView, decision) { calls.push({ kind: 'vote', decision, code: chosenView?.code }); return chosenView; }
  }
  const context = vm.createContext({
    ...audioBindings,
    ...combat, ...presentation, ...menu, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    renderArmory, renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance,
    structuredClone, URLSearchParams, AbortController, console,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
    location: { search: '' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: () => app, addEventListener() {}, activeElement: null },
    OnlineClient: Client, TournamentClient: Client,
    preloadCleanArt: async () => {}, prepareCleanAvatar: async (appearance, mode, gear) => prepared.push({ appearance: plain(appearance), mode, gear: plain(gear ?? {}) }),
    renderCleanAvatar: () => '<svg class="fixture-avatar"></svg>', renderArena: () => '<svg class="fixture-arena"></svg>',
    buildAnimationSteps: () => [], playBattleAnimation: async () => {}, buildExecutionEvent, playExecutionAnimation: async () => {},
    renderMercyPanel, playLoserOutcome: async () => {},
    createArrivalController: options => {
      arrivalOptions = options;
      return {
        shouldShow: () => !arrivalSeen,
        mount() { arrivalSeen = true; arrivals.push('mount'); app.innerHTML = '<div class="fixture-arrival">Preserved arrival film</div>'; return true; },
        replay() { arrivals.push('replay'); app.innerHTML = '<div class="fixture-arrival">Preserved arrival film</div>'; return true; },
        dispose() { arrivals.push('dispose'); }, active: false,
      };
    },
  });
  const expose = `
    globalThis.fixture = {
      state, client: onlineClient, render, pollOnline,
      get view() { return onlineView; }, get tournament() { return tournamentView; },
      get session() { return onlineSession; }, get observer() { return observerMode; },
      get menuData() { return menuData; }, get watchCode() { return watchCodeDraft; },
    };
  `;
  const ready = vm.runInContext(`(async () => { ${definitions}\n${expose}\n${appSource.slice(startup)} })()`, context, { filename: 'src/app.js' });
  const ui = context.fixture;
  Object.assign(ui, { app, calls, prepared, arrivals, ready: Promise.resolve(ready) });
  ui.click = async (action, data = {}) => {
    await handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: { action, ...(action === 'name-next' ? { index: String(ui.state.nameIndex) } : {}), ...data } }) }, preventDefault() {} });
    await settle();
  };
  ui.input = (attribute, value, dataset = {}) => {
    const target = { hasAttribute: name => name === attribute, dataset, value };
    handlers.get('input')({ target });
    return target.value;
  };
  ui.finishArrival = async () => { arrivalOptions.onComplete(); await settle(); };
  return ui;
}

test('real startup opens the main menu after an already viewed arrival without creating a guest', async () => {
  const ui = fixture(); await ui.ready;
  assert.equal(ui.state.screen, 'menu');
  for (const action of ['menu-fight', 'menu-spectate', 'menu-leaderboard', 'menu-graveyard']) assert.match(ui.app.innerHTML, new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER|fixture-arrival|data-action="online-create"/);
  assert.deepEqual(ui.calls, [{ kind: 'session', create: false }]);
  assert.deepEqual(ui.arrivals, []);
  assert.equal(ui.app.classList.contains('menu-scene'), true, 'The menu uses the preserved arrival final-frame background.');
  assert.equal(ui.prepared.length, 0, 'The menu does not assemble or replace a fighter.');
});

test('first visit plays the preserved arrival film before revealing the main menu', async () => {
  const ui = fixture({ firstArrival: true }); await ui.ready;
  assert.deepEqual(ui.arrivals, ['mount']); assert.match(ui.app.innerHTML, /fixture-arrival/);
  assert.equal(ui.calls.some(call => call.kind === 'session' && call.create), false);
  await ui.finishArrival();
  assert.equal(ui.state.screen, 'menu'); assert.match(ui.app.innerHTML, /data-action="menu-fight"/);
  assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER/);
  assert.equal(ui.app.classList.contains('menu-scene'), true);
  await ui.click('menu-fight');
  assert.deepEqual(ui.arrivals, ['mount'], 'FIGHT must not replay the introduction after it reaches the menu.');
  assert.equal(ui.state.screen, 'creator'); assert.match(ui.app.innerHTML, /NAME YOUR FIGHTER/);
});

test('FIGHT names a p05 fighter before the existing lobby entry without replaying the arrival', async () => {
  const ui = fixture(); await ui.ready; await ui.click('menu-fight');
  assert.deepEqual(ui.arrivals, []);
  assert.equal(ui.calls.some(call => call.kind === 'session' && call.create), false);
  assert.equal(ui.state.screen, 'creator'); assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.app.classList.contains('menu-scene'), false);
  assert.match(ui.app.innerHTML, /NAME YOUR FIGHTER/); assert.equal(ui.state.drafts[0].appearance.facePreset, 'p05');
  ui.input('', '  Nessa  ', { name: '0' }); await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize'); assert.equal(ui.state.drafts[0].name, 'Nessa');
  const chosen = plain(ui.state.drafts[0]);
  await ui.click('online-create');
  assert.deepEqual(ui.calls.find(call => call.kind === 'create').character, chosen);
  assert.equal(ui.state.screen, 'tournament-lobby'); assert.equal(ui.tournament.you, 6);
  assert.equal(ui.calls.filter(call => call.kind === 'create').length, 1);
});

test('FIGHT retains a surviving saved identity and its wins for both legacy and preset appearances', async () => {
  for (const appearance of [normalizeAppearance({ sex: 'female', hairstyle: 'braided_ponytail', eyes: 'jade' }), normalizePresetAppearance({ sex: 'male', facePreset: 'p10' })]) {
    const session = savedSession(appearance), before = structuredClone(session), ui = fixture({ restoredSession: session, firstArrival: false });
    await ui.ready; assert.equal(ui.state.screen, 'menu'); assert.match(ui.app.innerHTML, /Nessa/);
    await ui.click('menu-fight');
    assert.equal(ui.state.screen, 'creator'); assert.equal(ui.state.creatorStep, 'customize'); assert.equal(ui.state.locked[0], true);
    assert.deepEqual(plain(ui.state.drafts[0]), before.character);
    assert.equal(ui.session.duelWins, 9); assert.equal(ui.session.tournamentWins, 2);
    assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER/); assert.match(ui.app.innerHTML, /Enter another tournament/);
    await ui.click('face-cycle', { index: '0', delta: '1' }); await ui.click('rename', { index: '0' });
    assert.deepEqual(plain(ui.state.drafts[0]), before.character); assert.deepEqual(session, before);
    assert.equal(ui.calls.some(call => call.kind === 'create' || call.kind === 'join'), false);
  }
});

test('real startup resumes an active tournament directly without inserting a menu or arrival film', async () => {
  const session = { ...savedSession(), activeTournament: 'ABC234' }, raw = tournament({ phase: 'waiting', observer: false, ownCharacter: session.character });
  const ui = fixture({ restoredSession: session, restoredView: raw }); await ui.ready; await settle();
  assert.equal(ui.state.screen, 'tournament-lobby'); assert.equal(ui.observer, false);
  assert.equal(ui.tournament.code, 'ABC234'); assert.deepEqual(plain(ui.state.drafts[0]), session.character);
  assert.deepEqual(ui.calls, [{ kind: 'session', create: false }, { kind: 'room', code: 'ABC234' }]);
  assert.deepEqual(ui.arrivals, []); assert.doesNotMatch(ui.app.innerHTML, /data-action="menu-fight"/);
});

test('SPECTATE lists and observes matches without creating a fighter, joining, or sending a leave command', async () => {
  const ui = fixture(); await ui.ready; await ui.click('menu-spectate');
  assert.equal(ui.state.screen, 'match-browser'); assert.match(ui.app.innerHTML, /ABC234/);
  await ui.click('watch-tournament', { value: 'ABC234' });
  assert.equal(ui.observer, true); assert.equal(ui.state.screen, 'tournament-spectator');
  assert.equal(ui.tournament.you, null); assert.equal(ui.view.match.you, null);
  assert.match(ui.app.innerHTML, /data-action="observer-leave"/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="(?:tournament-leave|tournament-next|online-create|online-join|fight|weapon|armor|helmet|lock-loadout|mercy|crowd-vote)"/);
  await ui.click('observer-leave'); assert.equal(ui.observer, false); assert.equal(ui.state.screen, 'match-browser');
  await ui.click('menu-home'); assert.equal(ui.state.screen, 'menu'); assert.equal(ui.view, null);
  assert.equal(ui.calls.filter(call => call.kind === 'observe').length, 1);
  assert.equal(ui.calls.some(call => ['create', 'join', 'room', 'command', 'vote'].includes(call.kind) || call.kind === 'session' && call.create), false);
  assert.deepEqual(ui.arrivals, []);
});

test('spectator equipment and crowd views expose no private choice or fighter command controls', async () => {
  for (const phase of ['equipment', 'crowd']) {
    const raw = tournament({ phase, crowd: phase === 'crowd' ? { eligibleCount: 6, counts: { spare: 1, execute: 2 }, yourVote: null, canVote: false, deadline: Date.now() + 20000 } : null });
    const ui = fixture({ observedView: raw }); await ui.ready; await ui.click('menu-spectate'); await ui.click('watch-tournament', { value: 'ABC234' });
    assert.equal(ui.state.screen, 'tournament-spectator');
    assert.doesNotMatch(ui.app.innerHTML, /data-action="(?:fight|weapon|armor|helmet|lock-loadout|mercy|crowd-vote)"/);
    assert.equal(ui.view.match.yourLoadout, null);
    if (phase === 'equipment') { assert.equal(ui.state.duel, null); assert.doesNotMatch(ui.app.innerHTML, /Quick Thrust|Chain Sweep|Cleaving Arc/); }
    for (const [action, data] of [['fight', { value: 'strike' }], ['weapon', { index: '0', value: 'axe' }], ['lock-loadout', {}], ['mercy', { value: 'execute' }], ['crowd-vote', { value: 'execute' }]]) await ui.click(action, data);
    assert.equal(ui.calls.some(call => ['command', 'vote', 'create', 'join'].includes(call.kind)), false);
  }
});

test('Graveyard only fetches an existing owner session and never creates a guest for a fresh visitor', async () => {
  const fresh = fixture(); await fresh.ready; await fresh.click('menu-graveyard');
  assert.equal(fresh.state.screen, 'graveyard'); assert.match(fresh.app.innerHTML, /No fallen fighters/);
  assert.equal(fresh.calls.some(call => call.kind === 'graveyard'), false);
  assert.ok(fresh.calls.filter(call => call.kind === 'session').every(call => !call.create));
  const graves = [{ character: character('Old Nessa', 'retired-nessa'), diedAt: '2026-10-08T12:00:00Z', duelWins: 7, tournamentWins: 1, killedBy: 'Aster' }];
  const returning = fixture({ restoredSession: savedSession(), graves }); await returning.ready; await returning.click('menu-graveyard');
  assert.match(returning.app.innerHTML, /Old Nessa/); assert.match(returning.app.innerHTML, /Fell to Aster/);
  assert.match(returning.app.innerHTML, /session expires/);
  assert.equal(returning.calls.filter(call => call.kind === 'graveyard').length, 1);
  assert.ok(returning.calls.filter(call => call.kind === 'session').every(call => !call.create));
  assert.deepEqual(graves[0].character, character('Old Nessa', 'retired-nessa'));
});

test('Leaderboard reads public living-fighter records without entering a tournament', async () => {
  const fighters = [{ rank: 1, character: character('Champion Aster', 'aster'), duelWins: 17, tournamentWins: 3 }];
  const ui = fixture({ fighters }); await ui.ready; await ui.click('menu-leaderboard');
  assert.equal(ui.state.screen, 'leaderboard'); assert.match(ui.app.innerHTML, /Champion Aster/);
  assert.match(ui.app.innerHTML, /ranked by total duel wins/); assert.match(ui.app.innerHTML, /server restarts/);
  assert.equal(ui.calls.filter(call => call.kind === 'leaderboard').length, 1);
  assert.equal(ui.calls.some(call => ['create', 'join', 'room', 'command'].includes(call.kind) || call.kind === 'session' && call.create), false);
});

test('a late menu refresh cannot replace the page selected after navigation', async () => {
  const response = deferred(), ui = fixture(); await ui.ready;
  ui.client.leaderboard = async () => response.promise;
  const refreshing = ui.click('menu-leaderboard'); await settle();
  assert.equal(ui.state.screen, 'leaderboard'); await ui.click('menu-home');
  response.resolve({ fighters: [{ character: character('Late champion') }] }); await refreshing;
  assert.equal(ui.state.screen, 'menu'); assert.equal(ui.menuData.fighters.length, 0);
  assert.doesNotMatch(ui.app.innerHTML, /Late champion/);
});

test('a late initial observer response cannot leave the menu after the visitor navigates back', async () => {
  const response = deferred(), ui = fixture(); await ui.ready; await ui.click('menu-spectate');
  ui.client.observe = async () => response.promise;
  const watching = ui.click('watch-tournament', { value: 'ABC234' }); await settle();
  await ui.click('menu-home'); response.resolve(tournament()); await watching;
  assert.equal(ui.state.screen, 'menu'); assert.equal(ui.observer, false); assert.equal(ui.view, null);
});

test('an observer poll completing after departure cannot restore the discarded match', async () => {
  const response = deferred(), ui = fixture(); await ui.ready; await ui.click('menu-spectate'); await ui.click('watch-tournament', { value: 'ABC234' });
  ui.client.observe = async () => response.promise;
  const polling = ui.pollOnline(); await settle(); await ui.click('observer-leave');
  response.resolve(tournament({ revision: 99 })); await polling; await settle();
  assert.equal(ui.state.screen, 'match-browser'); assert.equal(ui.observer, false); assert.equal(ui.view, null);
  assert.equal(ui.calls.some(call => call.kind === 'command'), false);
});

test('a stale observer 404 cannot close a different match chosen while the old poll was pending', async () => {
  const oldResponse = deferred(), ui = fixture(); await ui.ready; await ui.click('menu-spectate'); await ui.click('watch-tournament', { value: 'ABC234' });
  ui.client.observe = async () => oldResponse.promise;
  const polling = ui.pollOnline(); await settle(); await ui.click('observer-leave');
  ui.client.observe = async () => tournament({ code: 'XYZ789' }); await ui.click('watch-tournament', { value: 'XYZ789' });
  const ended = new Error('The old tournament ended.'); ended.status = 404; oldResponse.reject(ended); await polling; await settle();
  assert.equal(ui.observer, true); assert.equal(ui.state.screen, 'tournament-spectator'); assert.equal(ui.tournament.code, 'XYZ789');
});

test('spectator lobby-code input stays normalized and visible across automatic list refreshes', async () => {
  const ui = fixture(); await ui.ready; await ui.click('menu-spectate');
  assert.equal(ui.input('data-watch-code', ' abC-234 '), 'ABC234');
  await ui.click('menu-refresh');
  assert.match(ui.app.innerHTML, /id="watch-code"[^>]*value="ABC234"/); assert.equal(ui.watchCode, 'ABC234');
  await ui.click('watch-code');
  assert.equal(ui.calls.find(call => call.kind === 'observe').code, 'ABC234'); assert.equal(ui.observer, true);
});
