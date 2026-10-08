import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { audioBindings } from './fixtures/audio-stub.js';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import { avatarChoices, normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';
import { renderArmory } from '../src/armory.js';
import { renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance } from '../src/tournament-view.js';
import { TournamentClient } from '../src/tournament-client.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = appSource.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
assert.ok(startup > 0, 'The real app startup boundary must be found.');
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const character = (name, id) => ({
  ...(id ? { id } : {}), name,
  stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b45143', appearance: normalizeAppearance({ sex: 'female', hairstyle: 'braided_ponytail', eyes: 'jade' }),
});
const profile = (name, id) => ({ character: character(name, id), alive: true, duelWins: 0, tournamentWins: 0, seed: null, eliminated: false, left: false, connected: true });
const roster = () => Array.from({ length: 8 }, (_, index) => profile(index === 6 ? 'Nessa' : `Fighter ${index + 1}`, `saved-${index + 1}`));
const bracketFor = (slots, activeIndex = 0) => ['Quarterfinal 1', 'Quarterfinal 2', 'Quarterfinal 3', 'Quarterfinal 4', 'Semifinal 1', 'Semifinal 2', 'Championship final'].map((label, index) => ({ index, label, round: index < 4 ? 'quarterfinal' : index < 6 ? 'semifinal' : 'final', slots: index === activeIndex ? [...slots] : index < 4 ? [index * 2, index * 2 + 1] : [null, null], winner: null, loser: null, status: index === activeIndex ? 'active' : 'pending', advanceReason: null }));

// This is the exact public TournamentStore.view topology: roster slot `you`
// and duel-local match.you have different meanings and must never be confused.
function view({ phase = 'equipment', revision = 2, slots = [2, 6], players = roster(), ready = [false, false], pending = [false, false], gear = null, duel = null, duelId = 'match-1', yourSlot = 6, currentMatchIndex = 0, decision = null } = {}) {
  const local = slots.indexOf(yourSlot), waiting = phase === 'waiting';
  return {
    type: 'tournament', code: 'ABC234', tournamentId: 'tournament-1', duelId: waiting ? 'tournament-1' : duelId,
    phase, revision, you: yourSlot, capacity: 8, players: waiting ? players.slice(0, 7) : players,
    bracket: waiting ? [] : bracketFor(slots, currentMatchIndex), currentMatchIndex: waiting ? null : currentMatchIndex,
    spectator: waiting || local < 0, nextMatchAt: phase === 'intermission' ? Date.now() + 6000 : null, champion: phase === 'complete' ? yourSlot : null,
    match: waiting ? null : {
      code: 'ABC234', duelId, revision, you: local < 0 ? null : local, slots: [...slots], phase: ['intermission', 'complete'].includes(phase) ? 'complete' : phase,
      players: slots.map(slot => players[slot]), ready, pending, yourLoadout: local >= 0 ? gear : null,
      duel, decision, deadline: Date.now() + 20000,
      rules: { actionMs: 20000, equipmentMs: 90000, entranceMs: 8000, intermissionMs: 6000 }, canRematch: false,
    },
  };
}
const duelFor = (raw, gear = { weapon: 'sword', armor: 'medium', helmet: 'none' }) => combat.createDuel(raw.match.players.map((player, index) => ({ character: player.character, ...index === raw.match.you ? gear : { weapon: 'spear', armor: 'light', helmet: 'none' } })));

// Real screen builders/rendering/handlers; only browser, animation, artwork and
// network are stubbed. This catches private-control leaks and slot mapping in
// the integration that pure tournament view tests cannot exercise.
function fixture({ restoredSession = null, restoredView = null, startupRun = false, playback = async () => {}, executionPlay = async () => {}, outcomePlay = async () => {}, gate = false, nativeArena = false } = {}) {
  const handlers = new Map(), roomRequests = [], calls = [], prepared = [];
  const video = { muted: false, currentTime: 0, duration: 8, played: 0, readyState: 1, eventHandlers: new Map(),
    addEventListener(kind, handler) { this.eventHandlers.set(kind, handler); }, play() { this.played++; return Promise.resolve(); }, pause() {} };
  const app = {
    innerHTML: '', inert: false, classList: { add() {}, remove() {}, toggle() {} },
    addEventListener: (kind, handler) => handlers.set(kind, handler),
    querySelectorAll: () => [], querySelector: selector => gate && selector === '.tournament-gate-video' && app.innerHTML.includes('tournament-gate-video') ? video : null, setAttribute() {},
  };
  let arenaStage = null, arenaFrame = null;
  if (nativeArena) {
    let markup = '', serial = 0;
    Object.defineProperty(app, 'innerHTML', {
      get: () => markup,
      set(value) {
        markup = value;
        if (!/class="arena-stage/.test(value)) { arenaStage = null; arenaFrame = null; return; }
        const figures = [0, 1].map(() => {
          const attributes = new Map();
          return { setAttribute: (name, text) => attributes.set(name, text), removeAttribute: name => attributes.delete(name), getAttribute: name => attributes.get(name) };
        });
        const stage = { svg: { id: ++serial }, figures, hud: value.includes('battle-hud') ? {} : null,
          closest: () => stage.frame,
          querySelector: selector => selector === '.battle-hud' ? stage.hud : selector === '.arena-svg' ? stage.svg : figures[/data-fighter-index="(\d)"/.exec(selector)?.[1]],
          replaceWith: original => { arenaStage = original; },
        };
        if (stage.hud) stage.hud.replaceWith = fresh => { stage.hud = fresh; };
        const frame = value.includes('class="spectator-frame"') ? { stage, foreground: {}, replaceWith: original => { arenaFrame = original; arenaStage = original.stage; } } : null;
        stage.frame = frame; arenaStage = stage; arenaFrame = frame;
      },
    });
    app.querySelector = selector => selector === '.arena-stage' ? arenaStage : selector === '.spectator-frame' ? arenaFrame : null;
  }
  class Client {
    async session() { return restoredSession; }
    async room(code) { roomRequests.push(code); return restoredView; }
    async create(chosenCharacter) { calls.push({ kind: 'enter', character: plain(chosenCharacter) }); return view({ phase: 'waiting' }); }
    async command(chosenView, action, payload) { calls.push({ kind: action, view: plain(chosenView), payload: plain(payload ?? {}) }); return chosenView; }
  }
  const context = vm.createContext({
    ...audioBindings,
    ...combat, ...presentation, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    renderArmory, renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance,
    structuredClone, URLSearchParams, AbortController, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, console,
    location: { search: '' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: () => app, addEventListener() {}, activeElement: null },
    OnlineClient: Client, TournamentClient: Client,
    preloadCleanArt: async () => {}, prepareCleanAvatar: async (appearance, mode, gear) => { prepared.push({ appearance: plain(appearance), mode, gear: plain(gear ?? {}) }); }, renderCleanAvatar: () => '<svg class="fixture-avatar"></svg>',
    renderArena: () => '<svg class="fixture-arena"></svg>', buildAnimationSteps: () => [], playBattleAnimation: playback,
    buildExecutionEvent, playExecutionAnimation: executionPlay,
    renderMercyPanel, playLoserOutcome: outcomePlay,
    createArrivalController: () => ({ shouldShow: () => false, mount: () => false, dispose() {}, active: false }),
  });
  const expose = `
    globalThis.fixture = {
      state, client: onlineClient, render, pollOnline, useOnlineSession,
      apply: value => applyTournamentView(value, { animate: false }),
      applyAnimated: value => applyTournamentView(value),
      get view() { return onlineView; }, get tournament() { return tournamentView; },
      get session() { return onlineSession; }, get busy() { return onlineBusy; },
    };
  `;
  const execution = startupRun
    ? vm.runInContext(`(async () => { ${definitions}\n${expose}\n${appSource.slice(startup)} })()`, context, { filename: 'src/app.js' })
    : vm.runInContext(definitions + expose, context, { filename: 'src/app.js' });
  const ui = context.fixture;
  ui.app = app; ui.calls = calls; ui.roomRequests = roomRequests; ui.prepared = prepared; ui.video = video;
  ui.ready = Promise.resolve(execution);
  Object.defineProperties(ui, { nativeStage: { get: () => arenaStage }, nativeFrame: { get: () => arenaFrame } });
  ui.click = async (action, data = {}) => {
    await handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: { action, ...(action === 'name-next' ? { index: String(ui.state.nameIndex) } : {}), ...data } }) }, preventDefault() {} });
    await Promise.resolve();
  };
  ui.inputName = value => handlers.get('input')({ target: { hasAttribute: () => false, dataset: { name: '0' }, value } });
  ui.setView = async raw => { ui.apply(raw); await ui.render(); };
  return ui;
}
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };

test('default tournament flow names and creates one fighter before entering the waiting lobby', async () => {
  const ui = fixture();
  await ui.render();
  assert.equal(ui.state.mode, 'online');
  assert.match(ui.app.innerHTML, /NAME YOUR FIGHTER\./);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"|armory-weapon-rack/);
  ui.inputName('  Nessa  ');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.match(ui.app.innerHTML, /Enter tournament/);
  assert.equal(ui.state.drafts[0].name, 'Nessa');
  const identity = plain(ui.state.drafts[0]);
  await ui.click('online-create');
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].kind, 'enter');
  assert.deepEqual(ui.calls[0].character, identity);
  assert.equal(ui.tournament.phase, 'waiting');
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"|data-action="lock-loadout"|data-action="weapon"/);
});

test('waiting lobby prepares every joined saved appearance as a complete battle avatar and leaves open slots empty', async () => {
  const players = roster();
  players.forEach((player, index) => {
    player.character.appearance = normalizeAppearance({ sex: index % 2 ? 'female' : 'male', hairstyle: avatarChoices.hairstyle[index].id, hairColor: avatarChoices.hairColor[index].id, facePreset: `p0${index + 1}` });
    player.loadout = { weapon: 'PRIVATE-WEAPON', armor: 'PRIVATE-ARMOR', helmet: 'PRIVATE-HELMET' };
  });
  for (let count = 1; count <= 8; count++) {
    const ui = fixture(), raw = view({ phase: 'waiting', players, yourSlot: 0 });
    raw.players = structuredClone(players.slice(0, count));
    const before = structuredClone(raw);
    await ui.setView(raw); await settle();
    ui.prepared.length = 0;
    await ui.render();
    assert.equal(ui.state.screen, 'tournament-lobby');
    assert.equal(ui.prepared.length, count, 'Every joined avatar must be prepared before screen markup is committed.');
    assert.deepEqual(ui.prepared.map(prepared => prepared.appearance), raw.players.map(player => player.character.appearance));
    assert.ok(ui.prepared.every(prepared => prepared.mode === 'battle'));
    assert.ok(ui.prepared.every(prepared => JSON.stringify(prepared.gear) === JSON.stringify({ weapon: 'sword', armor: 'medium', helmet: 'none' })), 'Lobby identity gear cannot leak privately committed equipment.');
    assert.equal((ui.app.innerHTML.match(/data-fighter-slot=/g) ?? []).length, 8);
    assert.equal((ui.app.innerHTML.match(/class="tournament-fighter-slot occupied/g) ?? []).length, count);
    assert.equal((ui.app.innerHTML.match(/class="tournament-slot-empty"/g) ?? []).length, 8 - count);
    assert.doesNotMatch(ui.app.innerHTML, /PRIVATE-|data-action="(?:fight|weapon|armor|helmet|lock-loadout)"/);
    assert.deepEqual(raw, before, 'Preparing and rendering preserves saved identity IDs and the server roster.');
  }
});

test('all eight players see the existing gate animation, then only its two combatants receive battle controls', async () => {
  const slots = [2, 6], players = roster();
  for (let yourSlot = 0; yourSlot < 8; yourSlot++) {
    const ui = fixture({ gate: true });
    const raw = view({ phase: 'entrance', revision: 4, slots, players, yourSlot, ready: [true, true] });
    raw.match.duel = duelFor(raw); raw.match.deadline = Date.now() + 5000;
    await ui.setView(raw); await settle();
    assert.equal(ui.state.screen, 'tournament-entrance');
    assert.match(ui.app.innerHTML, /arena-gate\.mp4/);
    assert.equal(ui.video.muted, true);
    assert.ok(ui.video.played > 0, `Roster slot ${yourSlot} must play the preserved film.`);
    ui.video.eventHandlers.get('loadedmetadata')?.();
    assert.ok(ui.video.currentTime >= 2.9 && ui.video.currentTime < 3.5, 'A refreshed viewer rejoins the shared gate timeline rather than replaying from zero.');
    assert.match(ui.app.innerHTML, slots.includes(yourSlot) ? /Battle begins in/ : /Spectating begins in/);
    assert.doesNotMatch(ui.app.innerHTML, /data-action="(?:fight|weapon|armor|helmet|lock-loadout|mercy)"/);
    await ui.click('fight', { value: 'strike' });
    assert.equal(ui.calls.length, 0, 'Gate viewing does not grant early fight authority.');
    const videoPlays = ui.video.played;
    const battle = view({ phase: 'battle', revision: 5, slots, players, yourSlot, ready: [true, true], duel: raw.match.duel });
    await ui.setView(battle); await settle();
    assert.equal(ui.video.played, videoPlays, 'Battle routing cannot restart the entrance film.');
    assert.equal(ui.state.screen, slots.includes(yourSlot) ? 'battle' : 'tournament-spectator');
    assert.equal((ui.app.innerHTML.match(/data-action="fight"/g) ?? []).length, slots.includes(yourSlot) ? 4 : 0);
    assert.equal(ui.tournament.currentMatchIndex, 0);
    assert.deepEqual(plain(ui.state.profiles.map(player => player.character.id)), slots.map(slot => players[slot].character.id));
  }
});

test('roster position maps to its local equipment slot, locked gear cannot change, and entrance precedes battle commands', async () => {
  const ui = fixture();
  const raw = view();
  await ui.setView(raw);
  assert.equal(ui.state.screen, 'loadout');
  assert.equal(ui.state.picker, 1);
  assert.equal(ui.view.you, 1);
  assert.equal(ui.state.profiles[1].character.id, raw.players[6].character.id);
  assert.match(ui.app.innerHTML, /Equip Nessa\./);
  assert.equal((ui.app.innerHTML.match(/data-action="weapon"/g) ?? []).length, Object.keys(combat.WEAPONS).length);
  assert.match(ui.app.innerHTML, /data-action="weapon"[^>]*data-value="dagger"/);
  await ui.click('weapon', { index: '0', value: 'axe' });
  assert.notEqual(ui.state.loadouts[1].weapon, 'axe', 'rival slot cannot alter own gear');
  await ui.click('weapon', { index: '1', value: 'halberd' });
  await ui.click('armor', { index: '1', value: 'heavy' });
  await ui.click('helmet', { index: '1', value: 'greathelm' });
  const gear = plain(ui.state.loadouts[1]), identity = plain(ui.state.profiles[1].character);
  ui.client.command = async (sentView, action, payload) => {
    ui.calls.push({ action, duelId: sentView.duelId, payload: plain(payload) });
    return view({ revision: 3, ready: [false, true], gear });
  };
  await ui.click('lock-loadout');
  assert.deepEqual(ui.calls[0], { action: 'loadout', duelId: 'match-1', payload: { loadout: gear } });
  assert.doesNotMatch(ui.app.innerHTML, /data-action="weapon"|data-action="armor"|data-action="helmet"|data-action="lock-loadout"/);
  await ui.click('weapon', { index: '1', value: 'mace' });
  await ui.click('armor', { index: '1', value: 'light' });
  await ui.click('helmet', { index: '1', value: 'none' });
  await ui.click('lock-loadout');
  assert.deepEqual(plain(ui.state.loadouts[1]), gear, 'fake stale equipment controls cannot change committed private gear');
  assert.equal(ui.calls.length, 1);

  const duel = duelFor(raw, gear);
  await ui.setView(view({ phase: 'entrance', revision: 4, ready: [true, true], gear, duel }));
  assert.match(ui.app.innerHTML, /arena-gate\.mp4/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"/);
  await ui.click('fight', { value: 'strike' });
  assert.equal(ui.calls.length, 1);
  await ui.setView(view({ phase: 'battle', revision: 5, ready: [true, true], gear, duel }));
  assert.equal(ui.state.screen, 'battle');
  assert.equal(ui.state.actionTurn, 1);
  assert.equal((ui.app.innerHTML.match(/data-action="fight"/g) ?? []).length, 4);
  assert.deepEqual(plain(ui.state.profiles[1].character), identity);
});

test('spectators and intermissions show the match without any equipment or fight authority', async () => {
  const ui = fixture();
  const raw = view({ slots: [0, 4] });
  const duel = duelFor(raw);
  await ui.setView({ ...raw, phase: 'battle', match: { ...raw.match, phase: 'battle', ready: [true, true], duel } });
  assert.equal(ui.tournament.spectator, true);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"|data-action="weapon"|data-action="lock-loadout"/);
  for (const [action, data] of [['fight', { value: 'strike' }], ['weapon', { index: '0', value: 'axe' }], ['lock-loadout', {}], ['mercy', { value: 'execute' }]]) await ui.click(action, data);
  assert.equal(ui.calls.length, 0, 'a spectator cannot submit an active fighter command');

  const finished = structuredClone(duel);
  finished.status = 'complete'; finished.result = { winner: 0, reason: 'knockout' };
  await ui.setView(view({ phase: 'intermission', revision: 4, slots: [0, 4], ready: [true, true], duel: finished, decision: { decision: 'spare' } }));
  assert.equal(ui.tournament.phase, 'intermission');
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"|data-action="lock-loadout"|data-action="mercy"/);
  assert.ok(ui.tournament.nextMatchAt > Date.now());
});

test('a late match response cannot move a former fighter out of the next spectator match', async () => {
  const ui = fixture();
  const raw = view(), duel = duelFor(raw), response = deferred();
  await ui.setView(view({ phase: 'battle', revision: 5, ready: [true, true], duel }));
  ui.client.command = async (sentView, action, payload) => { ui.calls.push({ duelId: sentView.duelId, action, payload: plain(payload) }); return response.promise; };
  const sending = ui.click('fight', { value: 'guard' });
  await Promise.resolve(); await Promise.resolve();
  const next = view({ phase: 'battle', revision: 10, slots: [0, 4], duelId: 'match-2' });
  next.match.ready = [true, true]; next.match.duel = duelFor(next);
  await ui.setView(next);
  response.resolve(view({ phase: 'battle', revision: 6, ready: [true, true], pending: [false, true], duel }));
  await sending;
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.calls[0].duelId, 'match-1');
  assert.equal(ui.calls[0].payload.round, 1);
  assert.equal(ui.tournament.duelId, 'match-2');
  assert.equal(ui.tournament.spectator, true);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"/);
});

test('a duelist finishes its revealed round before applying the queued tournament intermission', async () => {
  const animation = deferred(), ui = fixture({ playback: () => animation.promise });
  const raw = view(), before = duelFor(raw);
  await ui.setView(view({ phase: 'battle', revision: 5, ready: [true, true], duel: before }));
  const after = combat.resolveRound(before, ['strike', 'recover']);
  ui.applyAnimated(view({ phase: 'battle', revision: 6, ready: [true, true], duel: after }));
  await settle();
  assert.equal(ui.state.phase, 'playback');
  const finished = structuredClone(after); finished.status = 'complete'; finished.result = { winner: 1, reason: 'knockout' };
  ui.apply(view({ phase: 'intermission', revision: 7, ready: [true, true], duel: finished, decision: { decision: 'spare' } }));
  assert.equal(ui.tournament.revision, 6, 'intermission waits until revealed animation is committed');
  animation.resolve();
  await settle();
  assert.equal(ui.tournament.revision, 7);
  assert.equal(ui.tournament.phase, 'intermission');
  assert.equal(ui.state.phase, 'select');
  assert.equal(ui.state.duel.status, 'complete');
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"|data-action="mercy"/);
});

test('a spectator animation failure still releases the queued resolved server view', async () => {
  let rejectAnimation;
  const animation = new Promise((_resolve, reject) => { rejectAnimation = reject; });
  const ui = fixture({ playback: () => animation });
  const raw = view({ slots: [0, 4] }), before = duelFor(raw);
  await ui.setView(view({ phase: 'battle', revision: 5, slots: [0, 4], ready: [true, true], duel: before }));
  const after = combat.resolveRound(before, ['strike', 'recover']);
  ui.applyAnimated(view({ phase: 'battle', revision: 6, slots: [0, 4], ready: [true, true], duel: after }));
  await settle();
  assert.equal(ui.state.phase, 'playback');
  const finished = structuredClone(after); finished.status = 'complete'; finished.result = { winner: 0, reason: 'knockout' };
  ui.apply(view({ phase: 'intermission', revision: 7, slots: [0, 4], ready: [true, true], duel: finished, decision: { decision: 'spare' } }));
  rejectAnimation(new Error('renderer unavailable'));
  await settle();
  assert.equal(ui.tournament.revision, 7);
  assert.equal(ui.tournament.phase, 'intermission');
  assert.equal(ui.state.phase, 'select');
  assert.equal(ui.state.duel.status, 'complete');
  assert.match(ui.state.error, /animation could not finish/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"|data-action="mercy"/);
});

test('queued revisions remain monotonic when an earlier match view arrives after the next intermission', async () => {
  for (const slots of [[2, 6], [0, 4]]) {
    const animation = deferred(), ui = fixture({ playback: () => animation.promise });
    const raw = view({ slots }), before = duelFor(raw), after = combat.resolveRound(before, ['strike', 'recover']);
    await ui.setView(view({ phase: 'battle', revision: 5, slots, ready: [true, true], duel: before }));
    ui.applyAnimated(view({ phase: 'battle', revision: 6, slots, ready: [true, true], duel: after }));
    await settle();
    const finished = structuredClone(after); finished.status = 'complete'; finished.result = { winner: 0, reason: 'knockout' };
    ui.apply(view({ phase: 'intermission', revision: 8, slots, ready: [true, true], duel: finished, decision: { decision: 'spare' } }));
    ui.apply(view({ phase: 'battle', revision: 7, slots, ready: [true, true], pending: [true, false], duel: after }));
    animation.resolve();
    await settle();
    assert.equal(ui.tournament.revision, 8, 'a delayed response must not replace the newest queued server revision');
    assert.equal(ui.tournament.phase, 'intermission');
    assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"/);
  }
});

test('a spectator carries the newest next-match equipment view through the previous round animation', async () => {
  const animation = deferred(), ui = fixture({ playback: () => animation.promise });
  const raw = view({ slots: [0, 4] }), before = duelFor(raw), after = combat.resolveRound(before, ['strike', 'recover']);
  await ui.setView(view({ phase: 'battle', revision: 5, slots: [0, 4], ready: [true, true], duel: before }));
  ui.applyAnimated(view({ phase: 'battle', revision: 6, slots: [0, 4], ready: [true, true], duel: after }));
  await settle();
  const finished = structuredClone(after); finished.status = 'complete'; finished.result = { winner: 0, reason: 'knockout' };
  ui.apply(view({ phase: 'intermission', revision: 7, slots: [0, 4], ready: [true, true], duel: finished, decision: { decision: 'spare' } }));
  ui.apply(view({ phase: 'equipment', revision: 8, slots: [2, 6], duelId: 'match-2', currentMatchIndex: 1 }));
  animation.resolve();
  await settle();
  assert.equal(ui.tournament.duelId, 'match-2');
  assert.equal(ui.tournament.revision, 8);
  assert.equal(ui.state.screen, 'loadout');
  assert.equal(ui.state.picker, 1);
  assert.equal(ui.view.you, 1);
  assert.equal(ui.state.profiles[1].character.id, raw.players[6].character.id);
  assert.equal((ui.app.innerHTML.match(/data-action="weapon"/g) ?? []).length, Object.keys(combat.WEAPONS).length);
  assert.match(ui.app.innerHTML, /data-action="weapon"[^>]*data-value="dagger"/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="fight"/);
});

test('leaving the stands during a pending animation cannot resurrect the tournament when animation finishes', async () => {
  const animation = deferred(), ui = fixture({ playback: () => animation.promise });
  const raw = view({ slots: [0, 4] }), before = duelFor(raw), after = combat.resolveRound(before, ['strike', 'recover']);
  await ui.setView(view({ phase: 'battle', revision: 5, slots: [0, 4], ready: [true, true], duel: before }));
  ui.applyAnimated(view({ phase: 'battle', revision: 6, slots: [0, 4], ready: [true, true], duel: after }));
  await settle();
  ui.client.command = async (_view, action) => { assert.equal(action, 'leave'); return { left: true }; };
  ui.client.session = async () => ({ ...raw.players[6], activeTournament: null });
  await ui.click('tournament-leave');
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.tournament, null);
  animation.resolve();
  await settle();
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.tournament, null);
  assert.equal(ui.view, null);
  assert.equal(ui.state.duel, null);
});

test('a network interruption and recovery preserve pending playback and clear its recovered connection error', async () => {
  for (const slots of [[2, 6], [0, 4]]) {
    const animation = deferred(), ui = fixture({ playback: () => animation.promise });
    const raw = view({ slots }), before = duelFor(raw), after = combat.resolveRound(before, ['strike', 'recover']);
    await ui.setView(view({ phase: 'battle', revision: 5, slots, ready: [true, true], duel: before }));
    ui.applyAnimated(view({ phase: 'battle', revision: 6, slots, ready: [true, true], duel: after }));
    await settle();
    ui.client.room = async () => { throw new Error('Temporary connection interruption'); };
    await ui.pollOnline();
    assert.equal(ui.state.phase, 'playback', 'failed poll must not cancel the revealed round animation');
    assert.match(ui.state.error, /Temporary connection interruption/);
    const finished = structuredClone(after); finished.status = 'complete'; finished.result = { winner: 0, reason: 'knockout' };
    ui.client.room = async () => view({ phase: 'intermission', revision: 7, slots, ready: [true, true], duel: finished, decision: { decision: 'spare' } });
    await ui.pollOnline();
    assert.equal(ui.state.phase, 'playback', 'recovered poll must wait for the animation rather than replacing the stage');
    animation.resolve();
    await settle();
    assert.equal(ui.tournament.phase, 'intermission');
    assert.equal(ui.state.phase, 'select');
    assert.equal(ui.state.error, '', 'the successfully recovered connection must not leave a permanent error toast');
  }
});

test('leaving a resolved tournament keeps a living winner locked with the same identity and tournament record', async () => {
  const ui = fixture();
  const players = roster(); players[6].tournamentWins = 2; players[6].duelWins = 5;
  const raw = view({ phase: 'complete', revision: 30, players, ready: [true, true], currentMatchIndex: 6 });
  raw.match.duel = structuredClone(duelFor(raw)); raw.match.duel.status = 'complete'; raw.match.duel.result = { winner: 1, reason: 'knockout' }; raw.match.decision = { decision: 'spare' };
  await ui.setView(raw);
  const survivor = { ...players[6], activeTournament: null, pendingMercyTournament: null };
  ui.client.command = async (_view, action) => { assert.equal(action, 'leave'); return { left: true }; };
  ui.client.session = async () => survivor;
  await ui.click('online-leave');
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal(ui.state.locked[0], true);
  assert.deepEqual(plain(ui.state.drafts[0]), players[6].character);
  assert.equal(ui.session.tournamentWins, 2);
  assert.match(ui.app.innerHTML, /Enter another tournament/);
  assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER\./);
  await ui.click('online-create');
  assert.equal(ui.calls.at(-1).kind, 'enter');
  assert.deepEqual(ui.calls.at(-1).character, players[6].character);
});

test('the completed survivor button leaves and enters another tournament once with the identical frozen fighter', async () => {
  const ui = fixture(), players = roster(), departed = deferred(), operations = [];
  players[6].duelWins = 5; players[6].tournamentWins = 2;
  const raw = view({ phase: 'complete', revision: 30, players, currentMatchIndex: 6 });
  await ui.setView(raw);
  assert.match(ui.app.innerHTML, /data-action="tournament-next"/);
  const identity = plain(players[6].character);
  ui.client.command = async (sentView, action) => { operations.push({ action, code: sentView.code }); return departed.promise; };
  ui.client.session = async () => { operations.push({ action: 'session' }); return { ...players[6], activeTournament: null, pendingMercyTournament: null }; };
  ui.client.create = async chosenCharacter => {
    operations.push({ action: 'enter', character: plain(chosenCharacter) });
    return { ...view({ phase: 'waiting', revision: 1, players }), code: 'SKY234', tournamentId: 'tournament-2', duelId: 'tournament-2' };
  };
  const entering = ui.click('tournament-next');
  await settle();
  await ui.click('tournament-next');
  assert.equal(operations.length, 1, 'a repeated button press while leaving cannot submit a second departure');
  departed.resolve({ left: true });
  await entering;
  assert.deepEqual(operations, [{ action: 'leave', code: raw.code }, { action: 'session' }, { action: 'enter', character: identity }]);
  assert.equal(ui.tournament.code, 'SKY234');
  assert.equal(ui.tournament.phase, 'waiting');
  assert.equal(ui.state.locked[0], true);
  assert.deepEqual(plain(ui.state.drafts[0]), identity);
  assert.equal(ui.session.tournamentWins, 2);
  assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER\./);
});

test('retired fighters never get the survivor shortcut or an automatic entry through a stale completed button', async () => {
  for (const retiredAtView of [true, false]) {
    const ui = fixture(), players = roster(), operations = [];
    players[6].alive = !retiredAtView;
    const raw = view({ phase: 'complete', revision: 30, players, currentMatchIndex: 6 });
    await ui.setView(raw);
    if (retiredAtView) {
      assert.doesNotMatch(ui.app.innerHTML, /data-action="tournament-next"/);
      assert.match(ui.app.innerHTML, /Create a new fighter/);
    }
    ui.client.command = async (_sentView, action) => { operations.push(action); return { left: true }; };
    ui.client.session = async () => ({ ...players[6], alive: false, activeTournament: null, pendingMercyTournament: null });
    ui.client.create = async () => { operations.push('enter'); assert.fail('Retired fighters cannot automatically enter another tournament'); };
    await ui.click('tournament-next');
    assert.deepEqual(operations, ['leave']);
    assert.equal(ui.tournament, null);
    assert.equal(ui.state.screen, 'creator');
    assert.equal(ui.state.creatorStep, 'name');
    assert.equal(ui.state.locked[0], false);
    assert.equal(Object.hasOwn(ui.state.drafts[0], 'id'), false);
    assert.equal(ui.session.character.id, players[6].character.id, 'the retired final record remains preserved');
  }
});

test('the survivor shortcut cannot enter another tournament when leaving the completed lobby is rejected', async () => {
  const ui = fixture(), raw = view({ phase: 'complete', revision: 30, currentMatchIndex: 6 }), operations = [];
  await ui.setView(raw);
  ui.client.command = async () => { operations.push('leave'); const error = new Error('Leave rejected'); error.status = 409; throw error; };
  ui.client.room = async () => raw;
  ui.client.create = async () => { operations.push('enter'); assert.fail('The previous lobby must be left before automatic entry'); };
  await ui.click('tournament-next');
  assert.deepEqual(operations, ['leave']);
  assert.equal(ui.tournament.code, raw.code);
  assert.equal(ui.tournament.phase, 'complete');
  assert.match(ui.state.error, /Leave rejected/);
});

test('an acknowledged departure preserves the last saved survivor when session refresh fails and reconciles on polling', async () => {
  const ui = fixture(), players = roster(); players[6].duelWins = 5; players[6].tournamentWins = 2;
  const raw = view({ phase: 'complete', revision: 30, players, currentMatchIndex: 6 });
  await ui.setView(raw);
  const identity = plain(players[6].character);
  ui.client.command = async (_view, action) => { assert.equal(action, 'leave'); return { left: true }; };
  let sessionCalls = 0;
  ui.client.session = async () => { sessionCalls++; throw new Error('Saved fighter refresh interrupted'); };
  await ui.click('tournament-leave');
  assert.equal(ui.tournament, null, 'the acknowledged departure is not undone by a failed profile refresh');
  assert.equal(ui.view, null);
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal(ui.state.locked[0], true);
  assert.deepEqual(plain(ui.state.drafts[0]), identity, 'a connection failure cannot replace a surviving fighter with a blank draft');
  assert.equal(ui.session.tournamentWins, 2);
  assert.match(ui.state.error, /refresh interrupted/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="online-create"|data-action="online-join"/);
  let entries = 0;
  ui.client.create = async () => { entries++; assert.fail('Entry must wait for saved-fighter reconciliation'); };
  await ui.click('online-create');
  assert.equal(entries, 0);
  assert.equal(ui.state.locked[0], true);
  assert.deepEqual(plain(ui.state.drafts[0]), identity);
  ui.client.session = async () => { sessionCalls++; return { ...players[6], activeTournament: null, pendingMercyTournament: null }; };
  await ui.pollOnline();
  assert.equal(sessionCalls, 2, 'polling retries the failed session reconciliation after leaving');
  assert.equal(ui.state.error, '');
  assert.equal(ui.state.locked[0], true);
  assert.deepEqual(plain(ui.state.drafts[0]), identity);
  assert.equal(ui.session.tournamentWins, 2);
  assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER\./);
  assert.match(ui.app.innerHTML, /data-action="online-create"/);
  ui.client.create = async chosenCharacter => {
    entries++; assert.deepEqual(plain(chosenCharacter), identity);
    return { ...view({ phase: 'waiting', revision: 1, players }), code: 'SAV234' };
  };
  await ui.click('online-create');
  assert.equal(entries, 1);
  assert.equal(ui.tournament.code, 'SAV234');
});

test('startup resumes activeTournament using its saved token context and preserves a living survivor', async () => {
  const raw = view({ phase: 'waiting' });
  const saved = { character: raw.players[6].character, alive: true, duelWins: 2, tournamentWins: 1, activeTournament: raw.code, activeRoom: null };
  const ui = fixture({ startupRun: true, restoredSession: saved, restoredView: raw });
  await ui.ready;
  assert.deepEqual(ui.roomRequests, [raw.code]);
  assert.equal(ui.tournament.code, raw.code);
  assert.equal(ui.state.locked[0], true);
  assert.deepEqual(plain(ui.state.drafts[0]), saved.character);
  assert.doesNotMatch(ui.app.innerHTML, /NAME YOUR FIGHTER\./);
});

test('TournamentClient enter reconciles a lost response through activeTournament without a second entry', async () => {
  const requests = [], values = new Map([['last-laurel.guest.v1', 'saved-token']]); let entered = false;
  const client = new TournamentClient({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, fetcher: async (url, options) => {
    requests.push({ url, method: options.method, token: options.headers.Authorization, body: options.body });
    const data = url === '/api/session' ? { activeTournament: entered ? 'ABC234' : null } : view({ phase: 'waiting' });
    if (url === '/api/tournaments/enter') { entered = true; throw new TypeError('lost acknowledgement'); }
    return { ok: true, json: async () => data };
  } });
  const result = await client.create(character('Nessa', 'saved-7'));
  assert.equal(result.code, 'ABC234');
  assert.equal(requests.filter(request => request.url === '/api/tournaments/enter').length, 1);
  assert.ok(requests.some(request => request.url === '/api/tournaments/ABC234'));
  assert.ok(requests.every(request => request.token === 'Bearer saved-token'));
});

function finishedDuel(raw, winner = 1) {
  const duel = structuredClone(duelFor(raw));
  duel.status = 'complete'; duel.result = { winner, reason: 'knockout' }; duel.fighters[1 - winner].hp = 0;
  return duel;
}
function executedTournament(raw, revision, phase = 'intermission') {
  const players = structuredClone(raw.players), winner = raw.match.duel.result.winner, loser = 1 - winner;
  players[raw.match.slots[loser]].alive = false;
  return view({ phase, revision, players, slots: raw.match.slots, duel: raw.match.duel,
    yourSlot: raw.you, currentMatchIndex: raw.currentMatchIndex, duelId: raw.match.duelId,
    ready: [true, true], decision: { decision: 'execute', winner, loser } });
}

test('duelists and spectators retain the complete final-match arena during one live execution, then show the champion', async () => {
  for (const slots of [[2, 6], [0, 4]]) {
    const animation = deferred(), calls = [], ui = fixture({ executionPlay: (...args) => { calls.push(args); return animation.promise; } });
    const mercy = view({ phase: 'mercy', revision: 20, slots, ready: [true, true], currentMatchIndex: 6 });
    mercy.match.duel = finishedDuel(mercy);
    await ui.setView(mercy); await settle();
    const executed = executedTournament(mercy, 21, 'complete');
    ui.applyAnimated(executed); await settle();
    assert.equal(ui.state.screen, slots.includes(6) ? 'battle' : 'tournament-spectator'); assert.equal(calls.length, 1);
    assert.match(ui.app.innerHTML, /class="arena-stage\s*"/);
    assert.doesNotMatch(ui.app.innerHTML, /takes the crown|data-action="(?:mercy|fight|tournament-next)"/);
    assert.equal(ui.state.profiles[0].alive, false);
    const cinematic = ui.app.innerHTML;
    ui.apply({ ...executed, revision: 22 }); await ui.render(); await settle();
    assert.equal(ui.app.innerHTML, cinematic);
    animation.resolve(); await settle();
    assert.equal(ui.tournament.revision, 22);
    assert.match(ui.app.innerHTML, /takes the crown/);
    ui.applyAnimated({ ...executed, revision: 23 }); await settle();
    assert.equal(calls.length, 1, 'the same final verdict cannot replay on polling');
  }
});

test('a queued tournament execute survives the final attack and newer next-match views for both roles', async () => {
  for (const slots of [[6, 2], [0, 4]]) {
    const attack = deferred(), execution = deferred(), calls = [];
    const ui = fixture({ playback: () => attack.promise, executionPlay: (...args) => { calls.push(args); return execution.promise; } });
    const raw = view({ phase: 'battle', revision: 5, slots, ready: [true, true] });
    const before = structuredClone(duelFor(raw)); before.fighters[1].hp = 1; raw.match.duel = before;
    await ui.setView(raw); await settle();
    const after = combat.resolveRound(before, ['strike', 'recover']); assert.equal(after.status, 'complete');
    const mercy = view({ phase: 'mercy', revision: 6, slots, ready: [true, true], duel: after });
    ui.applyAnimated(mercy); await settle();
    assert.equal(ui.state.phase, 'playback'); assert.equal(calls.length, 0);
    ui.apply(executedTournament(mercy, 7));
    const next = view({ phase: 'equipment', revision: 9, slots: [2, 6], duelId: 'match-2', currentMatchIndex: 1 });
    ui.apply(next); ui.apply({ ...next, revision: 8 });
    attack.resolve(); await settle();
    assert.equal(ui.state.screen, slots.includes(6) ? 'battle' : 'tournament-spectator'); assert.equal(calls.length, 1);
    assert.equal(ui.state.duel.fighters[1].character.id, before.fighters[1].character.id);
    assert.equal(ui.state.profiles[1].alive, false);
    execution.resolve(); await settle();
    assert.equal(ui.tournament.revision, 9); assert.equal(ui.tournament.duelId, 'match-2');
    assert.equal(ui.state.screen, 'loadout');
    assert.equal(calls.length, 1);
  }
});

test('a combined championship knockout and execute resolves its attack before the execution stage', async () => {
  const attack = deferred(), execution = deferred(), order = [];
  const ui = fixture({ playback: () => { order.push('attack'); return attack.promise; }, executionPlay: () => { order.push('execution'); return execution.promise; } });
  const raw = view({ phase: 'battle', revision: 10, slots: [0, 4], ready: [true, true], currentMatchIndex: 6 });
  const before = structuredClone(duelFor(raw)); before.fighters[1].hp = 1; raw.match.duel = before;
  await ui.setView(raw); await settle();
  const after = combat.resolveRound(before, ['strike', 'recover']);
  const completed = { ...raw, match: { ...raw.match, duel: after } };
  ui.applyAnimated(executedTournament(completed, 11, 'complete')); await settle();
  assert.deepEqual(order, ['attack']); assert.equal(ui.state.phase, 'playback');
  assert.match(ui.app.innerHTML, /class="arena-stage"/);
  assert.doesNotMatch(ui.app.innerHTML, /takes the crown/);
  attack.resolve(); await settle();
  assert.deepEqual(order, ['attack', 'execution']); assert.equal(ui.state.screen, 'tournament-spectator');
  execution.resolve(); await settle();
  assert.match(ui.app.innerHTML, /takes the crown/);
});

test('a historical tournament execution snapshot skips playback and an interrupted live execution keeps its final verdict', async () => {
  const raw = view({ phase: 'mercy', revision: 20, slots: [0, 4], ready: [true, true] });
  raw.match.duel = finishedDuel(raw);
  const executed = executedTournament(raw, 21);
  let calls = 0;
  const reloaded = fixture({ executionPlay: async () => { calls++; } });
  await reloaded.setView(executed); await settle();
  reloaded.applyAnimated({ ...executed, revision: 22 }); await settle();
  assert.equal(calls, 0);
  const ui = fixture({ executionPlay: async () => { throw new Error('Broken cinematic'); } });
  await ui.setView(raw); await settle(); ui.applyAnimated(executed); await settle();
  assert.equal(ui.state.screen, 'tournament-spectator');
  assert.equal(ui.state.profiles[0].alive, false);
  assert.equal(ui.state.decision, 'execute');
  assert.match(ui.state.error, /The verdict is final/);
});

test('leaving a tournament execution aborts its cinematic and ignores its late completion', async () => {
  const animation = deferred(), calls = [], ui = fixture({ executionPlay: (...args) => { calls.push(args); return animation.promise; } });
  const raw = view({ phase: 'mercy', revision: 20, slots: [0, 4], ready: [true, true] }); raw.match.duel = finishedDuel(raw);
  await ui.setView(raw); await settle(); ui.applyAnimated(executedTournament(raw, 21)); await settle();
  ui.client.command = async (_view, action) => { assert.equal(action, 'leave'); return { left: true }; };
  ui.client.session = async () => ({ ...raw.players[6], activeTournament: null });
  await ui.click('tournament-leave'); await settle();
  assert.equal(calls[0][2].signal.aborted, true);
  animation.resolve(); await settle();
  assert.equal(ui.state.screen, 'creator'); assert.equal(ui.state.duel, null);
  assert.equal(ui.tournament, null); assert.equal(ui.view, null);
});

test('crowd spectator controls submit only one eligible public vote and preserve combat privacy', async () => {
  const ui = fixture(), raw = view({ phase: 'crowd', revision: 12, slots: [0, 4], ready: [true, true] });
  raw.match.duel = finishedDuel(raw); raw.match.crowdVote = raw.crowdVote = {
    deadline: Date.now() + 20000, eligibleCount: 6, counts: { spare: 1, execute: 2 }, yourVote: null, canVote: true,
  };
  await ui.setView(raw); await settle();
  assert.equal(ui.state.screen, 'tournament-spectator'); assert.match(ui.app.innerHTML, /THE CROWD DECIDES/);
  assert.match(ui.app.innerHTML, /data-action="crowd-vote" data-value="spare"/);
  assert.doesNotMatch(ui.app.innerHTML, /data-action="(?:mercy|fight|weapon|lock-loadout)"/);
  ui.client.vote = async (sent, decision) => {
    ui.calls.push({ kind: 'vote', duelId: sent.duelId, decision });
    const voted = structuredClone(raw); voted.revision = 13;
    voted.match.crowdVote.yourVote = 'execute'; voted.match.crowdVote.canVote = false; voted.match.crowdVote.counts.execute++;
    voted.crowdVote = voted.match.crowdVote; return voted;
  };
  await ui.click('crowd-vote', { value: 'execute' }); await settle();
  assert.deepEqual(ui.calls, [{ kind: 'vote', duelId: 'match-1', decision: 'execute' }]);
  assert.match(ui.app.innerHTML, /Your vote: Kill/);
  await ui.click('crowd-vote', { value: 'spare' }); await ui.click('crowd-vote', { value: 'bad' });
  assert.equal(ui.calls.length, 1); assert.equal(ui.tournament.match.decision, null);
});

test('fighters and ineligible crowd observers cannot vote through a stale or fabricated control', async () => {
  for (const slots of [[2, 6], [0, 4]]) {
    const ui = fixture(), raw = view({ phase: 'crowd', revision: 12, slots, ready: [true, true] });
    raw.match.duel = finishedDuel(raw); raw.match.crowdVote = raw.crowdVote = {
      deadline: Date.now() + 20000, eligibleCount: 6, counts: { spare: 0, execute: 0 }, yourVote: null, canVote: false,
    };
    await ui.setView(raw); await settle(); ui.client.vote = async () => { assert.fail('Ineligible viewers cannot send a vote'); };
    await ui.click('crowd-vote', { value: 'execute' });
    assert.doesNotMatch(ui.app.innerHTML, /data-action="crowd-vote"/);
  }
});

test('a spared tournament loser sees one outcome popup and then retains its saved identity in the stands', async () => {
  const popup = deferred(), calls = [], ui = fixture({ outcomePlay: (...args) => { calls.push(args); return popup.promise; } });
  const raw = view({ phase: 'mercy', revision: 12, slots: [2, 6], ready: [true, true] }); raw.match.duel = finishedDuel(raw, 0);
  await ui.setView(raw); await settle(); const identity = plain(raw.players[6].character);
  const spared = view({ phase: 'intermission', revision: 13, slots: [2, 6], ready: [true, true], duel: raw.match.duel,
    decision: { decision: 'spare', winner: 0, loser: 1 } });
  ui.applyAnimated(spared); await settle(); assert.equal(calls.length, 1); assert.equal(calls[0][1], 'spare');
  ui.apply({ ...spared, revision: 14 }); await ui.render(); await settle();
  popup.resolve(); await settle(); assert.equal(ui.state.screen, 'tournament-spectator');
  assert.equal(ui.tournament.revision, 14); assert.equal(ui.state.profiles[1].alive, true);
  assert.deepEqual(plain(ui.state.profiles[1].character), identity);
  ui.applyAnimated({ ...spared, revision: 15 }); await settle(); assert.equal(calls.length, 1);
});

test('TournamentClient votes use the durable guest token and current duel while context reset preserves authentication', async () => {
  const values = new Map([['last-laurel.guest.v1', 'saved-token']]), requests = [];
  const client = new TournamentClient({ storage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    fetcher: async (url, options) => { requests.push({ url, token: options.headers.Authorization, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ phase: 'crowd' }) }; } });
  await client.vote({ type: 'tournament', code: 'ABC234', duelId: 'match-7' }, 'execute');
  assert.equal(requests[0].url, '/api/tournaments/ABC234/vote'); assert.equal(requests[0].token, 'Bearer saved-token');
  assert.equal(requests[0].body.duelId, 'match-7'); assert.equal(requests[0].body.decision, 'execute');
  assert.ok(requests[0].body.commandId); client.resetMatchContext();
  assert.equal(client.token, 'saved-token'); assert.equal(values.get('last-laurel.guest.v1'), 'saved-token');
});

test('execution retains the exact native arena SVG and spectator foreground nodes while refreshing result controls', async () => {
  for (const slots of [[2, 6], [0, 4]]) {
    const animation = deferred(), calls = [], ui = fixture({ nativeArena: true, executionPlay: (...args) => { calls.push(args); return animation.promise; } });
    const raw = view({ phase: 'mercy', revision: 20, slots, ready: [true, true] }); raw.match.duel = finishedDuel(raw);
    await ui.setView(raw); await settle();
    const stage = ui.nativeStage, svg = stage.svg, foreground = ui.nativeFrame, hud = stage.hud;
    ui.applyAnimated(executedTournament(raw, 21)); await settle();
    assert.equal(ui.nativeStage, stage, 'execution must reuse the existing stage object');
    assert.equal(ui.nativeStage.svg, svg, 'the registered arena SVG must remain the same object');
    assert.equal(calls[0][0], stage, 'the existing arena is handed directly to playback');
    if (foreground) assert.equal(ui.nativeFrame, foreground, 'the seat-level foreground and camera container are retained');
    if (hud) assert.notEqual(stage.hud, hud, 'result meters refresh without replacing the arena SVG');
    assert.equal(stage.figures[0].getAttribute('data-defeated'), 'true');
    assert.doesNotMatch(ui.app.innerHTML, /data-action="mercy"/);
    animation.resolve(); await settle();
  }
});
