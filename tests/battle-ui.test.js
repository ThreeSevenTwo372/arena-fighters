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
import { renderArmory } from '../src/armory.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = source.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
assert.ok(startup > 0, 'The app startup boundary must be found.');
const definitions = source.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const character = (name, id) => ({
  id, name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b45143', appearance: normalizeAppearance(),
});
const profiles = () => ['Cassian', 'Mira'].map((name, index) => ({ character: character(name, `fighter-${index}`), alive: true, duelWins: 0 }));
const initialDuel = () => combat.createDuel(profiles().map(profile => ({ character: profile.character, weapon: 'sword', armor: 'medium' })));
const viewFor = (duel, revision = 1, extra = {}) => ({
  code: 'ABC234', duelId: 'duel-1', revision, phase: 'battle', you: 0,
  players: duel.fighters.map(fighter => ({ character: fighter.character, alive: true, duelWins: 0, left: false })),
  ready: [true, true], pending: [false, false], yourLoadout: { weapon: 'sword', armor: 'medium', helmet: 'none' },
  duel, decision: null, rematchReady: [false, false], deadline: 120000, ...extra,
});

test('participant cameras follow the owned seat and resolved playback uses the first-person adapter', async () => {
  const ui = fixture({ firstPerson: true });
  await ui.startPractice();
  assert.match(ui.getHtml(), /data-viewer-index="0"/);
  const animation = deferred(); ui.setAnimationHook(() => animation.promise);
  await ui.click('fight', 'strike'); await ui.settle();
  assert.equal(ui.firstPersonCalls.length, 1);
  assert.equal(ui.animationCalls.length, 0);
  animation.resolve(); await ui.settle();
  ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(initialDuel(), 1, { you: 1 })); await ui.render();
  assert.match(ui.getHtml(), /data-viewer-index="1"/);
  assert.equal(ui.cameraRenders.at(-1), 1);
});

test('Pass & play initiative measures each private turn and excludes time spent passing the device', async () => {
  const ui = fixture({ firstPerson: true });
  await ui.startPractice('hotseat');
  await ui.click('continue-handoff'); await ui.settle();
  assert.match(ui.getHtml(), /data-viewer-index="0"/);
  await ui.advanceTo(ui.now() + 4000); await ui.click('fight', 'strike'); await ui.settle();
  await ui.advanceTo(ui.now() + 30000);
  await ui.click('continue-handoff'); await ui.settle();
  assert.match(ui.getHtml(), /data-viewer-index="1"/);
  const animation = deferred(); ui.setAnimationHook(() => animation.promise);
  await ui.advanceTo(ui.now() + 1000); await ui.click('fight', 'strike'); await ui.settle();
  assert.deepEqual(plain(ui.state.choiceElapsedMs), [4000, 1000]);
  animation.resolve(); await ui.settle();
  assert.deepEqual(plain(ui.state.duel.lastRound.order), [1, 0]);
  assert.deepEqual(plain(ui.state.duel.lastRound.choiceElapsedMs), [4000, 1000]);
  assert.deepEqual(plain(ui.state.choiceElapsedMs), [null, null]);
});

test('Practice records a fixed three-second bot choice without exposing its move early', async () => {
  const ui = fixture(); await ui.startPractice();
  const animation = deferred(); ui.setAnimationHook(() => animation.promise);
  await ui.advanceTo(ui.now() + 1200); await ui.click('fight', 'strike'); await ui.settle();
  assert.deepEqual(plain(ui.state.choiceElapsedMs), [1200, 3000]);
  animation.resolve(); await ui.settle();
  assert.deepEqual(plain(ui.state.duel.lastRound.choiceElapsedMs), [1200, 3000]);
});

// Execute real render, click, key, animation-completion and timer code. Replace
// only art/network/DOM boundaries, with a clock that advances deterministically.
function fixture({ receiptValues = new Map(), firstPerson = false } = {}) {
  let now = 100000;
  let nextTimer = 0;
  const timers = new Map();
  const scheduled = [];
  const handlers = new Map();
  let result;
  let prepareHook = async () => {};
  let animationHook = async () => {};
  let executionHook = async () => {};
  let outcomeHook = async () => {};
  const animationCalls = [];
  const executionCalls = [];
  const outcomeCalls = [];
  const cameraRenders = [];
  const firstPersonCalls = [];
  const firstPersonExecutions = [];
  const arena = { querySelector: selector => selector === '.first-person-arena' ? {} : null };
  const app = {
    innerHTML: '', addEventListener: (kind, handler) => handlers.set(kind, handler),
    querySelectorAll: selector => selector === '[data-action="fight"]' && result
      ? combat.getActionOptions(result.state.duel, result.state.actionTurn).map(option => ({
        disabled: !option.enabled, click: () => result.click('fight', option.id),
      })) : [],
    querySelector: selector => firstPerson && selector === '.arena-stage' ? arena : null, setAttribute() {},
  };
  const schedule = (fn, delay, interval = false) => {
    const id = ++nextTimer;
    timers.set(id, { fn, time: now + Number(delay || 0), interval: interval ? Number(delay || 0) : null });
    scheduled.push({ fn, delay, id });
    return id;
  };
  class ControlledDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    ...audioBindings,
    ...combat, ...presentation, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance, renderArmory,
    structuredClone, URLSearchParams, AbortController, Date: ControlledDate, console,
    setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: id => timers.delete(id),
    location: { search: '' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: () => app, addEventListener: (kind, handler) => handlers.set(`document-${kind}`, handler), activeElement: null },
    OnlineClient: class {},
    prepareCleanAvatar: (...args) => prepareHook(...args), renderCleanAvatar: () => '', renderArena: () => '<div class="fixture-arena"></div>',
    renderFirstPersonArena: (duel, options) => { cameraRenders.push(options.viewerIndex); return `<svg class="first-person-arena" data-viewer-index="${options.viewerIndex}"></svg>`; },
    playFirstPersonBattleAnimation: (...args) => { firstPersonCalls.push(args); return animationHook(...args); },
    playFirstPersonExecutionAnimation: (...args) => { firstPersonExecutions.push(args); return executionHook(...args); },
    buildAnimationSteps: () => [], playBattleAnimation: (...args) => {
      animationCalls.push(args);
      return animationHook(...args);
    },
    buildExecutionEvent, playExecutionAnimation: (...args) => { executionCalls.push(args); return executionHook(...args); },
    renderMercyPanel, playLoserOutcome: (...args) => { outcomeCalls.push(args); return outcomeHook(...args); },
    sessionStorage: { getItem: key => receiptValues.get(key), setItem: (key, value) => receiptValues.set(key, value) },
  });
  vm.runInContext(definitions + `
    globalThis.fixture = {
      state, client: onlineClient, startDuel, prepareTurn, render, battle,
      applyOnlineView, pollOnline, finishRound,
      get view() { return onlineView; }, set view(value) { onlineView = value; },
      get phaseHtml() { return actionPanel(); },
      get playback() { return roundPlayback; },
      get execution() { return executionPlayback; },
      get outcome() { return outcomePlayback; },
      set arrival(value) { arrival = value; },
      get arrivalComplete() { return arrivalComplete; },
      finishArrival: () => { arrivalComplete = true; return render(); },
      get session() { return onlineSession; },
      useOnlineSession, resumeDeathSession,
      get busy() { return renderBusy; },
    };
  `, context, { filename: 'src/app.js' });
  result = context.fixture;
  result.click = (action, value) => handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: { action, value } }) } });
  result.key = key => handlers.get('document-keydown')({ key, target: { tagName: 'BODY' }, repeat: false });
  result.setPrepareHook = hook => { prepareHook = hook; };
  result.setAnimationHook = hook => { animationHook = hook; };
  result.setExecutionHook = hook => { executionHook = hook; };
  result.setOutcomeHook = hook => { outcomeHook = hook; };
  result.animationCalls = animationCalls;
  result.cameraRenders = cameraRenders;
  result.firstPersonCalls = firstPersonCalls;
  result.firstPersonExecutions = firstPersonExecutions;
  result.executionCalls = executionCalls;
  result.outcomeCalls = outcomeCalls;
  result.receiptValues = receiptValues;
  result.scheduled = scheduled;
  result.getHtml = () => app.innerHTML;
  result.now = () => now;
  result.setNow = value => { now = value; };
  result.settle = async () => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };
  result.advanceTo = async target => {
    let count = 0;
    while (true) {
      const due = [...timers.entries()].filter(([, item]) => item.time <= target).sort((a, b) => a[1].time - b[1].time)[0];
      if (!due) break;
      assert.ok(++count < 10000, 'Timers must make forward progress.');
      const [id, item] = due;
      now = Math.max(now, item.time);
      timers.delete(id);
      if (item.interval !== null) timers.set(id, { ...item, time: now + item.interval });
      await item.fn();
      await result.settle();
    }
    now = target;
    await result.settle();
  };
  result.startPractice = async (mode = 'cpu') => {
    result.state.mode = mode;
    result.state.profiles = profiles();
    result.startDuel();
    await result.settle();
  };
  return result;
}

test('a local action plays the full animation and opens the next round automatically', async () => {
  const ui = fixture();
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  await ui.startPractice();
  await ui.click('fight', 'strike');
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.duel.round, 1);
  assert.equal(ui.animationCalls.length, 1);
  assert.doesNotMatch(ui.phaseHtml, /data-action="(?:skip-animation|next-round)"|Skip animation|Next round/);

  await ui.click('skip-animation');
  ui.key('1');
  ui.key('Escape');
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.duel.round, 1);
  assert.equal(ui.animationCalls[0][2].signal.aborted, false);
  animation.resolve();
  await ui.settle();

  assert.equal(ui.state.duel.round, 2);
  assert.equal(ui.state.phase, 'select');
  assert.equal(ui.state.screen, 'battle');
  assert.deepEqual(plain(ui.state.pending), [null, null]);
  assert.doesNotMatch(ui.phaseHtml, /data-action="(?:skip-animation|next-round)"/);
  await ui.click('next-round');
  assert.equal(ui.state.duel.round, 2, 'The removed Next round action cannot advance or reset the new turn.');
});

test('timeout and counterplay guidance matches new Focus and preserved Recover rules', async () => {
  for (const version of [3, 4]) {
    const ui = fixture(), original = initialDuel();
    const duel = combat.createDuel(original.fighters.map(fighter => ({ character: fighter.character, weapon: fighter.weapon, armor: fighter.armor })), { version });
    ui.state.mode = 'online';
    ui.applyOnlineView(viewFor(duel, 1), { animate: false }); await ui.settle();
    const label = version === 3 ? 'Recover' : 'Focus';
    assert.match(ui.getHtml(), new RegExp(`timeout: ${label}`));
    assert.match(ui.getHtml(), new RegExp(`Guard or ${label} makes it waste stamina`));
    assert.match(ui.getHtml(), new RegExp(`data-value="${label.toLowerCase()}"`));
    assert.match(ui.getHtml(), /<strong>4<\/strong> Speed/);
    if (version === 4) assert.doesNotMatch(ui.getHtml(), /Recover/);
  }
});

test('committed rival choices change only public readiness before the reveal', async () => {
  const ui = fixture();
  const duel = initialDuel();
  ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(duel, 1), { animate: false });
  await ui.settle();
  const initial = ui.getHtml();
  ui.applyOnlineView(viewFor(duel, 2, { pending: [false, true] }), { animate: false });
  await ui.settle();
  const locked = ui.getHtml();
  assert.match(locked, /Choice locked/);
  assert.notEqual(initial, locked);
  assert.equal(ui.state.phase, 'select');
  assert.deepEqual(plain(ui.state.pending), [null, null]);
  assert.doesNotMatch(locked, /Mira (?:used|chose|dealt|guarded|restored)|Round 1 revealed/);

  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  const after = combat.resolveRound(duel, ['strike', 'guard']);
  ui.applyOnlineView(viewFor(after, 3), { animate: true });
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.deepEqual(plain(ui.state.pending), ['strike', 'guard']);
  assert.match(ui.getHtml(), /Round 1 · Choices revealed/);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.round, 2);
  assert.equal(ui.state.phase, 'select');
});

test('online headings distinguish choosing, sending, committed, and reconnecting without changing the duel', async () => {
  const ui = fixture();
  const duel = initialDuel();
  const reply = deferred();
  ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(duel, 1), { animate: false });
  await ui.settle();
  assert.match(ui.phaseHtml, /<h2>Choose a move<\/h2>/);
  ui.client.command = () => reply.promise;
  const click = ui.click('fight', 'guard');
  await ui.settle();
  assert.match(ui.phaseHtml, /<h2>Sending your choice…<\/h2>/);
  assert.equal(ui.state.duel.round, 1);
  reply.resolve(viewFor(duel, 2, { pending: [true, false] }));
  await click;
  await ui.settle();
  assert.match(ui.phaseHtml, /<h2>Choice locked<\/h2>/);
  ui.client.room = async () => { throw new Error('offline'); };
  await ui.pollOnline();
  assert.match(ui.phaseHtml, /<h2>Reconnecting…<\/h2>/);
  assert.equal(ui.state.duel.round, 1);
  assert.deepEqual(plain(ui.state.pending), [null, null]);
});

test('the 20-second deadline defaults to Focus exactly once, never a millisecond early', async () => {
  const ui = fixture();
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  await ui.startPractice();
  const start = ui.now();
  assert.equal(ui.state.turnDeadline, start + 20000);
  await ui.advanceTo(start + 19999);
  assert.equal(ui.state.phase, 'select');
  assert.equal(ui.animationCalls.length, 0);
  assert.equal(ui.state.pending[0], null);
  await ui.advanceTo(start + 20000);
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.pending[0], 'focus');
  assert.equal(ui.animationCalls.length, 1);
  await ui.advanceTo(start + 70000);
  assert.equal(ui.animationCalls.length, 1);
  assert.equal(ui.state.duel.round, 1, 'A long animation cannot start another choice window.');
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.round, 2);
  assert.equal(ui.state.turnDeadline, ui.now() + 20000);
});

test('a late attack click defaults to Focus even if the browser has delayed its timeout callback', async () => {
  const ui = fixture();
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  await ui.startPractice();
  ui.setNow(ui.now() + 20000);
  await ui.click('fight', 'strike');
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.pending[0], 'focus');
  assert.equal(ui.animationCalls.length, 1);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.lastRound.actions[0], 'focus');
});

test('an old timeout cannot consume the next round while that round waits for art rendering', async () => {
  const ui = fixture();
  const animation = deferred();
  const art = deferred();
  ui.setAnimationHook(() => animation.promise);
  await ui.startPractice();
  const expiredCallback = ui.scheduled.find(item => item.delay === 20000).fn;
  await ui.click('fight', 'strike');
  await ui.settle();
  ui.setPrepareHook(() => art.promise);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.round, 2);
  assert.equal(ui.busy, true);
  await ui.advanceTo(ui.now() + 30000);
  expiredCallback();
  await ui.settle();
  assert.equal(ui.state.phase, 'select');
  assert.equal(ui.animationCalls.length, 1);
  assert.deepEqual(plain(ui.state.pending), [null, null]);
  art.resolve();
  await ui.settle();
  assert.equal(ui.busy, false);
  const opened = ui.now();
  assert.equal(ui.state.turnDeadline, opened + 20000);
  await ui.advanceTo(opened + 19999);
  assert.equal(ui.animationCalls.length, 1);
  await ui.advanceTo(opened + 20000);
  assert.equal(ui.animationCalls.length, 2);
});

test('Pass & play gives each player a private timed turn and advances to the next handoff automatically', async () => {
  const ui = fixture();
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  await ui.startPractice('hotseat');
  assert.equal(ui.state.screen, 'handoff');
  await ui.advanceTo(ui.now() + 30000);
  assert.deepEqual(plain(ui.state.pending), [null, null]);
  await ui.click('continue-handoff');
  await ui.settle();
  assert.equal(ui.state.turnDeadline, ui.now() + 20000);
  await ui.click('fight', 'guard');
  await ui.settle();
  assert.equal(ui.state.screen, 'handoff');
  assert.deepEqual(plain(ui.state.pending), ['guard', null]);
  assert.doesNotMatch(ui.getHtml(), /Cassian (?:used|chose) Guard|data-value="guard"/);
  await ui.advanceTo(ui.now() + 30000);
  assert.deepEqual(plain(ui.state.pending), ['guard', null]);
  await ui.click('continue-handoff');
  await ui.settle();
  const secondStart = ui.now();
  await ui.advanceTo(secondStart + 19999);
  assert.equal(ui.state.pending[1], null);
  await ui.advanceTo(secondStart + 20000);
  assert.equal(ui.state.phase, 'playback');
  assert.deepEqual(plain(ui.state.pending), ['guard', 'focus']);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.screen, 'handoff');
  assert.equal(ui.state.duel.round, 2);
  assert.equal(ui.state.handoff.next, 0);
  assert.deepEqual(plain(ui.state.pending), [null, null]);
});

test('leaving a local battle cancels its pending timeout and cannot resolve an abandoned round', async () => {
  const ui = fixture();
  await ui.startPractice();
  const expiredCallback = ui.scheduled.find(item => item.delay === 20000).fn;
  await ui.click('new-session');
  await ui.settle();
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.duel, null);
  await ui.advanceTo(ui.now() + 30000);
  expiredCallback();
  await ui.settle();
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.duel, null);
  assert.equal(ui.animationCalls.length, 0);
});

test('a queued online readiness update cannot replace the full prior-round animation', async () => {
  const ui = fixture();
  const before = initialDuel();
  const after = combat.resolveRound(before, ['strike', 'guard']);
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(before), { animate: false });
  await ui.settle();
  ui.applyOnlineView(viewFor(after, 2));
  await ui.settle();
  ui.applyOnlineView(viewFor(after, 3, { pending: [false, true] }));
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.duel.round, 1);
  assert.equal(ui.animationCalls[0][2].signal.aborted, false);
  assert.match(ui.phaseHtml, /Round 1 · Choices revealed/);
  assert.doesNotMatch(ui.phaseHtml, /Sending your choice|Choose a move|Choice locked|skip-animation|next-round/);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.round, 2);
  assert.equal(ui.state.phase, 'select');
  assert.equal(ui.view.revision, 3);
  assert.match(ui.battle(), /Choice locked/);
});

test('copying a room code cannot skip an online animation', async () => {
  const ui = fixture();
  const before = initialDuel();
  const after = combat.resolveRound(before, ['strike', 'guard']);
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(before), { animate: false });
  await ui.settle();
  ui.applyOnlineView(viewFor(after, 2));
  await ui.settle();
  await ui.click('copy-room');
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.duel.round, 1);
  assert.equal(ui.animationCalls[0][2].signal.aborted, false);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.round, 2);
});

test('automatic progression stops after a knockout and awards the local win once', async () => {
  const ui = fixture();
  const animation = deferred();
  ui.setAnimationHook(() => animation.promise);
  await ui.startPractice();
  ui.state.duel = structuredClone(ui.state.duel);
  ui.state.duel.fighters[1].hp = 1;
  await ui.click('fight', 'strike');
  await ui.settle();
  assert.equal(ui.state.phase, 'playback');
  assert.equal(ui.state.profiles[0].duelWins, 0);
  animation.resolve();
  await ui.settle();
  assert.equal(ui.state.duel.status, 'complete');
  assert.equal(ui.state.duel.result.winner, 0);
  assert.equal(ui.state.profiles[0].duelWins, 1);
  assert.equal(ui.state.turnDeadline, null);
  await ui.advanceTo(ui.now() + 60000);
  await ui.click('skip-animation');
  await ui.click('next-round');
  await ui.click('fight', 'strike');
  assert.equal(ui.state.profiles[0].duelWins, 1);
  assert.equal(ui.animationCalls.length, 1);
  assert.equal(ui.state.duel.status, 'complete');
});

const completedDuel = (before = initialDuel(), winner = 0) => {
  const duel = structuredClone(before);
  duel.status = 'complete'; duel.result = { winner, reason: winner === null ? 'draw' : 'knockout' };
  if (winner !== null) duel.fighters[1 - winner].hp = 0;
  return duel;
};
const executionView = (duel, revision = 3) => viewFor(duel, revision, {
  phase: 'complete', decision: { decision: 'execute', winner: duel.result.winner, loser: 1 - duel.result.winner },
  players: duel.fighters.map((fighter, index) => ({ character: fighter.character, alive: index === duel.result.winner, duelWins: index === duel.result.winner ? 1 : 0, left: false })),
});

test('local execution retires the loser before playback and offers replacement only after it finishes', async () => {
  const ui = fixture(), animation = deferred();
  ui.setExecutionHook(() => animation.promise);
  await ui.startPractice();
  ui.state.duel = completedDuel(ui.state.duel); ui.state.turnDeadline = null;
  await ui.click('mercy', 'execute'); await ui.settle();
  assert.equal(ui.state.profiles[1].alive, false);
  assert.equal(ui.state.phase, 'execution');
  assert.equal(ui.executionCalls.length, 1);
  assert.equal(ui.executionCalls[0][1].winner, 0);
  assert.doesNotMatch(ui.getHtml(), /data-action="(?:fight|mercy|rematch)"/);
  await ui.click('mercy', 'spare'); await ui.click('rematch');
  assert.equal(ui.executionCalls.length, 1);
  assert.equal(ui.state.decision, 'execute');
  animation.resolve(); await ui.settle();
  assert.equal(ui.state.screen, 'battle');
  assert.equal(ui.state.profiles[1].alive, false);
  assert.match(ui.getHtml(), /Create a replacement/);
});

test('spare and a knockout without a verdict never play execution, and malformed local verdicts are ignored', async () => {
  for (const value of ['spare', 'invalid']) {
    const ui = fixture(); await ui.startPractice();
    ui.state.duel = completedDuel(ui.state.duel);
    await ui.render(); await ui.settle();
    assert.equal(ui.executionCalls.length, 0);
    await ui.click('mercy', value); await ui.settle();
    assert.equal(ui.executionCalls.length, 0);
    assert.equal(ui.state.profiles[1].alive, true);
    assert.equal(ui.state.decision, value === 'spare' ? 'spare' : null);
  }
});

test('local execution renderer failure or a missing stage cannot restore a retired fighter', async () => {
  for (const fails of [false, true]) {
    const ui = fixture(); await ui.startPractice();
    ui.state.duel = completedDuel(ui.state.duel);
    ui.setExecutionHook(async stage => { assert.equal(stage, null); if (fails) throw new Error('Unavailable stage'); return false; });
    await ui.click('mercy', 'execute'); await ui.settle();
    assert.equal(ui.state.screen, 'battle');
    assert.equal(ui.state.profiles[1].alive, false);
    assert.equal(ui.state.decision, 'execute');
    assert.match(ui.getHtml(), /Create a replacement/);
    if (fails) assert.match(ui.state.error, /The verdict is final/);
  }
});

test('starting a new local session aborts execution and late completion cannot revive its arena', async () => {
  const ui = fixture(), animation = deferred();
  ui.setExecutionHook(() => animation.promise); await ui.startPractice();
  ui.state.duel = completedDuel(ui.state.duel);
  await ui.click('mercy', 'execute'); await ui.settle();
  const signal = ui.executionCalls[0][2].signal;
  await ui.click('new-session'); await ui.settle();
  assert.equal(signal.aborted, true);
  assert.equal(ui.state.screen, 'creator');
  animation.resolve(); await ui.settle();
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.duel, null);
  assert.equal(ui.execution, null);
});

test('online execution waits for the acknowledged verdict, survives later polling, and plays once', async () => {
  const ui = fixture(), acknowledgement = deferred(), animation = deferred(), duel = completedDuel();
  ui.setExecutionHook(() => animation.promise);
  ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(duel, 2, { phase: 'mercy' }), { animate: false }); await ui.settle();
  ui.client.command = async (_view, action, payload) => {
    assert.equal(action, 'mercy'); assert.equal(payload.decision, 'execute'); return acknowledgement.promise;
  };
  const command = ui.click('mercy', 'execute'); await ui.settle();
  assert.equal(ui.executionCalls.length, 0);
  assert.equal(ui.state.profiles[1].alive, true);
  acknowledgement.resolve(executionView(duel)); await command; await ui.settle();
  assert.equal(ui.executionCalls.length, 1);
  assert.equal(ui.state.profiles[1].alive, false);
  assert.equal(ui.state.screen, 'battle');
  const cinematicMarkup = ui.getHtml();
  ui.applyOnlineView(executionView(duel, 4)); await ui.render(); await ui.settle();
  assert.equal(ui.getHtml(), cinematicMarkup, 'command finalization and polling cannot replace the animation nodes');
  animation.resolve(); await ui.settle();
  assert.equal(ui.view.revision, 4);
  assert.equal(ui.state.screen, 'battle');
  ui.applyOnlineView(executionView(duel, 5)); await ui.settle();
  assert.equal(ui.executionCalls.length, 1);
});

test('a refreshed or deliberately unanimated executed snapshot does not replay its historical verdict', async () => {
  const duel = completedDuel();
  for (const previous of [null, viewFor(duel, 2, { phase: 'mercy' })]) {
    const ui = fixture(); ui.state.mode = 'online';
    if (previous) { ui.applyOnlineView(previous, { animate: false }); await ui.settle(); }
    ui.applyOnlineView(executionView(duel, 3), { animate: false }); await ui.settle();
    ui.applyOnlineView(executionView(duel, 4)); await ui.settle();
    assert.equal(ui.executionCalls.length, 0);
    assert.equal(ui.state.profiles[1].alive, false);
  }
});

test('a lost execute response still plays once after a fresh room snapshot acknowledges that verdict', async () => {
  const ui = fixture(), animation = deferred(), duel = completedDuel();
  ui.setExecutionHook(() => animation.promise); ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(duel, 2, { phase: 'mercy' }), { animate: false }); await ui.settle();
  ui.client.command = async () => { throw new TypeError('Lost execute acknowledgement'); };
  ui.client.room = async () => executionView(duel, 3);
  await ui.click('mercy', 'execute'); await ui.settle();
  assert.equal(ui.state.screen, 'battle'); assert.equal(ui.executionCalls.length, 1);
  assert.equal(ui.state.profiles[1].alive, false); assert.equal(ui.state.error, '');
  animation.resolve(); await ui.settle();
  ui.applyOnlineView(executionView(duel, 4)); await ui.settle();
  assert.equal(ui.executionCalls.length, 1);
});

test('a final round and its queued execute verdict play in order before the latest rematch view', async () => {
  for (const combined of [true, false]) {
    const ui = fixture(), attack = deferred(), execution = deferred(), before = structuredClone(initialDuel());
    before.fighters[1].hp = 1;
    const after = combat.resolveRound(before, ['strike', 'focus']);
    assert.equal(after.status, 'complete');
    ui.setAnimationHook(() => attack.promise); ui.setExecutionHook(() => execution.promise);
    ui.state.mode = 'online'; ui.applyOnlineView(viewFor(before), { animate: false }); await ui.settle();
    ui.applyOnlineView(combined ? executionView(after, 2) : viewFor(after, 2, { phase: 'mercy' })); await ui.settle();
    assert.equal(ui.state.phase, 'playback'); assert.equal(ui.executionCalls.length, 0);
    if (!combined) ui.applyOnlineView(executionView(after, 3), { animate: false });
    const next = viewFor(after, 4, { duelId: 'duel-2', phase: 'equipment', duel: null, ready: [false, false] });
    ui.applyOnlineView(next); await ui.settle();
    attack.resolve(); await ui.settle();
    assert.equal(ui.executionCalls.length, 1);
    assert.equal(ui.state.screen, 'battle');
    assert.equal(ui.state.duel.result.winner, after.result.winner);
    assert.equal(ui.state.profiles[1].alive, false);
    execution.resolve(); await ui.settle();
    assert.equal(ui.view.duelId, 'duel-2'); assert.equal(ui.state.screen, 'loadout');
    assert.equal(ui.executionCalls.length, 1);
  }
});

test('leaving an online execution aborts presentation and late completion cannot return to the room', async () => {
  const ui = fixture(), animation = deferred(), duel = completedDuel();
  ui.setExecutionHook(() => animation.promise); ui.state.mode = 'online';
  ui.applyOnlineView(viewFor(duel, 2, { phase: 'mercy' }), { animate: false }); await ui.settle();
  ui.applyOnlineView(executionView(duel)); await ui.settle();
  ui.client.command = async (_view, action) => { assert.equal(action, 'leave'); return { left: true }; };
  ui.client.session = async () => ({ ...executionView(duel).players[0], activeRoom: null });
  await ui.click('online-leave'); await ui.settle();
  assert.equal(ui.executionCalls[0][2].signal.aborted, true);
  animation.resolve(); await ui.settle();
  assert.equal(ui.view, null); assert.equal(ui.state.screen, 'creator'); assert.equal(ui.state.duel, null);
  assert.equal(ui.state.phase, 'select');
});

test('a local win reveals WINNER before a full20-second three-choice mercy window and then defaults to Spare', async () => {
  const ui = fixture(); await ui.startPractice();
  ui.state.duel = structuredClone(ui.state.duel); ui.state.duel.fighters[1].hp = 1;
  await ui.click('fight', 'strike'); await ui.settle();
  const wonAt = ui.now();
  assert.match(ui.getHtml(), /Cassian<\/strong><span>WINNER!/);
  assert.doesNotMatch(ui.getHtml(), /MERCY\?|data-action="mercy"/);
  await ui.click('mercy', 'execute'); assert.equal(ui.state.decision, null);
  await ui.advanceTo(wonAt + 4999); assert.doesNotMatch(ui.getHtml(), /MERCY\?/);
  await ui.advanceTo(wonAt + 5000);
  assert.match(ui.getHtml(), /MERCY\?/); assert.match(ui.getHtml(), />20<\/span>/);
  assert.equal((ui.getHtml().match(/data-action="mercy"/g) || []).length, 3);
  assert.match(ui.getHtml(), />Kill<\/button>/); assert.match(ui.getHtml(), /Let crowd decide/);
  await ui.advanceTo(wonAt + 24999); assert.equal(ui.state.decision, null);
  await ui.advanceTo(wonAt + 25000); assert.equal(ui.state.decision, 'spare');
  assert.equal(ui.state.profiles[1].alive, true); assert.equal(ui.executionCalls.length, 0);
});

test('local Crowd uses six paced bot votes, waits all20 seconds, and applies its deterministic majority once', async () => {
  const ui = fixture(); await ui.startPractice();
  ui.state.duel = structuredClone(ui.state.duel); ui.state.duel.fighters[1].hp = 1;
  await ui.click('fight', 'strike'); await ui.settle(); await ui.advanceTo(ui.now() + 5000);
  await ui.click('mercy', 'crowd'); await ui.settle();
  const crowd = ui.state.localCrowd, start = ui.now();
  assert.equal(crowd.eligibleCount, 6); assert.deepEqual(plain(crowd.counts), { spare: 0, execute: 0 });
  assert.match(ui.getHtml(), /THE CROWD DECIDES/); assert.doesNotMatch(ui.getHtml(), /data-action="mercy"/);
  await ui.advanceTo(start + 2999); assert.equal(crowd.counts.spare + crowd.counts.execute, 0);
  await ui.advanceTo(start + 3000); assert.equal(crowd.counts.spare + crowd.counts.execute, 1);
  await ui.advanceTo(start + 19999);
  assert.equal(crowd.counts.spare + crowd.counts.execute, 6); assert.equal(ui.state.decision, null);
  await ui.advanceTo(start + 20000);
  assert.equal(ui.state.decision, crowd.counts.execute > crowd.counts.spare ? 'execute' : 'spare');
  assert.ok(ui.executionCalls.length <= 1);
});

test('a CPU victory grants mercy after WINNER and shows the human loser one popup without changing identity', async () => {
  const popup = deferred(), ui = fixture(); ui.setOutcomeHook(() => popup.promise); await ui.startPractice();
  const saved = plain(ui.state.profiles[0].character);
  ui.state.duel = structuredClone(ui.state.duel); ui.state.duel.fighters[0].hp = 1; ui.state.cpuAction = 'strike';
  await ui.click('fight', 'focus'); await ui.settle();
  assert.equal(ui.state.duel.result.winner, 1); assert.equal(ui.state.decision, null);
  await ui.advanceTo(ui.now() + 5000);
  assert.equal(ui.state.decision, 'spare'); assert.equal(ui.outcomeCalls.length, 1); assert.equal(ui.outcomeCalls[0][1], 'spare');
  assert.equal(ui.state.profiles[0].alive, true); assert.deepEqual(plain(ui.state.profiles[0].character), saved);
  popup.resolve(); await ui.settle(); assert.equal(ui.state.screen, 'battle');
});

test('Pass and play death stays in its native arena, replays arrival, and names only a new loser while the survivor remains locked', async () => {
  const execution = deferred(), popup = deferred(), ui = fixture(); let replays = 0;
  ui.setExecutionHook(() => execution.promise); ui.setOutcomeHook(() => popup.promise);
  ui.arrival = { replay: () => { replays++; return true; } };
  await ui.startPractice('hotseat'); ui.state.screen = 'battle'; ui.state.duel = completedDuel(ui.state.duel);
  const survivor = plain(ui.state.profiles[0].character);
  await ui.click('mercy', 'execute'); await ui.settle();
  assert.equal(ui.state.screen, 'battle'); assert.equal(ui.state.phase, 'execution'); assert.match(ui.getHtml(), /classic-battle/);
  execution.resolve(); await ui.settle(); assert.equal(ui.state.phase, 'outcome'); assert.equal(ui.outcomeCalls[0][1], 'execute');
  popup.resolve(); await ui.settle();
  assert.equal(replays, 1); assert.equal(ui.arrivalComplete, false);
  assert.equal(ui.state.nameIndex, 1); assert.equal(ui.state.drafts[1].name, '');
  assert.equal(ui.state.locked[0], true); assert.equal(ui.state.locked[1], false);
  assert.deepEqual(plain(ui.state.drafts[0]), survivor); assert.equal(ui.state.profiles[1].alive, false);
  await ui.finishArrival(); assert.match(ui.getHtml(), /NAME YOUR FIGHTER/);
});

test('an executed online loser waits for the black outcome and acknowledged fresh-match departure before arrival and an empty creator', async () => {
  const execution = deferred(), popup = deferred(), ui = fixture(), duel = completedDuel();
  let replays = 0, left = false, reset = 0; const operations = [];
  const dead = { character: duel.fighters[1].character, alive: false, duelWins: 4, activeRoom: 'ABC234', activeTournament: null };
  ui.state.mode = 'online'; ui.arrival = { replay: () => { replays++; return true; } };
  ui.setExecutionHook(() => execution.promise); ui.setOutcomeHook(() => popup.promise);
  ui.applyOnlineView(viewFor(duel, 2, { phase: 'mercy', you: 1 }), { animate: false }); await ui.settle();
  ui.client.token = 'keep-guest'; ui.client.resetMatchContext = () => { reset++; };
  ui.client.session = async () => { operations.push('session'); return { ...dead, activeRoom: left ? null : 'ABC234' }; };
  ui.client.room = async () => { operations.push('room'); return { ...executionView(duel, 8), you: 1, duelId: 'latest-match' }; };
  ui.client.command = async (sent, action) => { operations.push(action); assert.equal(sent.duelId, 'latest-match'); assert.equal(action, 'leave'); left = true; return { left: true }; };
  ui.applyOnlineView({ ...executionView(duel, 3), you: 1 }); await ui.settle();
  assert.equal(ui.state.screen, 'battle'); assert.equal(ui.state.profiles[1].alive, false);
  execution.resolve(); await ui.settle();
  assert.equal(ui.outcomeCalls.length, 1); assert.equal(ui.outcomeCalls[0][1], 'execute');
  assert.equal(ui.outcomeCalls[0][2].hold, true); assert.equal(operations.length, 0);
  assert.equal(ui.receiptValues.get('arena-fighters.death-v1:fighter-1'), 'pending');
  popup.resolve(); await ui.settle();
  assert.deepEqual(operations, ['session', 'room', 'leave', 'session']);
  assert.equal(ui.client.token, 'keep-guest'); assert.equal(reset, 1); assert.equal(replays, 1);
  assert.equal(ui.view, null); assert.equal(ui.state.drafts[0].name, ''); assert.equal(ui.state.locked[0], false);
  assert.equal(ui.session.character.id, 'fighter-1'); assert.equal(ui.session.duelWins, 4); assert.equal(ui.session.alive, false);
  assert.equal(ui.receiptValues.get('arena-fighters.death-v1:fighter-1'), 'complete');
});

test('pending death reloads resume its outcome without replaying execution and completed receipts keep the empty creator', async () => {
  const values = new Map([['arena-fighters.death-v1:fighter-1', 'pending']]), popup = deferred();
  const ui = fixture({ receiptValues: values }), dead = { character: initialDuel().fighters[1].character, alive: false, duelWins: 4, activeRoom: null };
  ui.state.mode = 'online'; ui.setOutcomeHook(() => popup.promise); ui.useOnlineSession(dead);
  ui.client.session = async () => dead; ui.resumeDeathSession(); await ui.settle();
  assert.equal(ui.executionCalls.length, 0); assert.equal(ui.outcomeCalls.length, 1); assert.equal(values.get('arena-fighters.death-v1:fighter-1'), 'pending');
  popup.resolve(); await ui.settle(); assert.equal(values.get('arena-fighters.death-v1:fighter-1'), 'complete');
  const reloaded = fixture({ receiptValues: values }); reloaded.state.mode = 'online'; reloaded.useOnlineSession(dead); reloaded.resumeDeathSession(); await reloaded.settle();
  assert.equal(reloaded.outcomeCalls.length, 0); assert.equal(reloaded.state.drafts[0].name, ''); assert.equal(reloaded.state.locked[0], false);
});

test('a lost automatic death departure retries through session reconciliation and never creates a fighter before departure', async () => {
  const ui = fixture(), dead = { character: initialDuel().fighters[1].character, alive: false, duelWins: 4, activeRoom: 'ABC234' };
  let left = false, commands = 0;
  ui.state.mode = 'online'; ui.useOnlineSession(dead);
  ui.client.session = async () => ({ ...dead, activeRoom: left ? null : 'ABC234' });
  ui.client.room = async () => ({ ...executionView(completedDuel()), you: 1 });
  ui.client.command = async () => { commands++; left = true; throw new Error('Lost departure acknowledgement'); };
  ui.resumeDeathSession(); await ui.settle();
  assert.equal(ui.state.phase, 'outcome'); assert.equal(ui.receiptValues.get('arena-fighters.death-v1:fighter-1'), 'pending');
  await ui.advanceTo(ui.now() + 1000);
  assert.equal(commands, 1); assert.equal(ui.state.screen, 'creator'); assert.equal(ui.state.drafts[0].name, '');
  assert.equal(ui.receiptValues.get('arena-fighters.death-v1:fighter-1'), 'complete');
});

test('online WINNER follows the server open time, then exposes a full20-second mercy window and sends Crowd once', async () => {
  const ui = fixture(), duel = completedDuel(), calls = [];
  ui.state.mode = 'online';
  const start = ui.now(), opensAt = start + 5000;
  ui.applyOnlineView(viewFor(duel, 2, { phase: 'mercy', mercyOpensAt: opensAt, deadline: opensAt + 20000 }), { animate: false });
  await ui.settle(); assert.match(ui.getHtml(), /WINNER!/); assert.doesNotMatch(ui.getHtml(), /MERCY\?/);
  ui.client.command = async (_view, action, payload) => {
    calls.push({ action, decision: payload.decision });
    return viewFor(duel, 3, { phase: 'crowd', deadline: ui.now() + 20000,
      crowdVote: { deadline: ui.now() + 20000, eligibleCount: 6, counts: { spare: 0, execute: 0 }, yourVote: null, canVote: false } });
  };
  await ui.click('mercy', 'crowd'); assert.equal(calls.length, 0);
  await ui.advanceTo(opensAt - 1); assert.doesNotMatch(ui.getHtml(), /MERCY\?/);
  await ui.advanceTo(opensAt); assert.match(ui.getHtml(), /MERCY\?/); assert.match(ui.getHtml(), />20<\/span>/);
  await ui.click('mercy', 'crowd'); await ui.settle();
  assert.deepEqual(calls, [{ action: 'mercy', decision: 'crowd' }]);
  assert.match(ui.getHtml(), /THE CROWD DECIDES/); assert.doesNotMatch(ui.getHtml(), /data-action="mercy"/);
  await ui.click('mercy', 'spare'); assert.equal(calls.length, 1);
  assert.equal(ui.state.decision, null);
});

test('canceling an outcome while a death session fetch is pending prevents late departure or arrival', async () => {
  const response = deferred(), ui = fixture(), dead = { character: initialDuel().fighters[1].character, alive: false, activeRoom: 'ABC234' };
  let rooms = 0, replays = 0;
  ui.state.mode = 'online'; ui.useOnlineSession(dead); ui.arrival = { replay: () => { replays++; return true; } };
  ui.client.session = () => response.promise; ui.client.room = async () => { rooms++; return executionView(completedDuel()); };
  ui.resumeDeathSession(); await ui.settle(); assert.equal(ui.state.phase, 'outcome');
  const signal = ui.outcomeCalls[0][2].signal;
  await ui.click('mode', 'cpu'); await ui.settle(); assert.equal(signal.aborted, true);
  response.resolve(dead); await ui.settle();
  assert.equal(rooms, 0); assert.equal(replays, 0); assert.equal(ui.state.mode, 'cpu'); assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.duel, null);
});

test('a living replacement created elsewhere is adopted before automatic death departure and its new room is preserved', async () => {
  const ui = fixture(), dead = { character: initialDuel().fighters[1].character, alive: false, activeRoom: 'ABC234' };
  const replacement = { character: character('New survivor', 'replacement-1'), alive: true, duelWins: 2, activeRoom: 'NEW234' };
  let commands = 0, replays = 0; const rooms = [];
  ui.state.mode = 'online'; ui.useOnlineSession(dead); ui.arrival = { replay: () => { replays++; return true; } };
  ui.client.session = async () => replacement;
  ui.client.room = async code => { rooms.push(code); return { ...viewFor(initialDuel()), code: 'NEW234' }; };
  ui.client.command = async () => { commands++; assert.fail('The replacement room cannot be left by an old death transition'); };
  ui.resumeDeathSession(); await ui.settle();
  assert.deepEqual(rooms, ['NEW234']); assert.equal(commands, 0); assert.equal(replays, 0);
  assert.equal(ui.view.code, 'NEW234'); assert.equal(ui.session.character.id, 'replacement-1');
  assert.equal(ui.state.drafts[0].id, 'replacement-1'); assert.equal(ui.state.locked[0], true);
  assert.equal(ui.outcome, null);
});
