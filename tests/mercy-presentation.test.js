import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMercyPanel, renderOutcomeOverlay, playLoserOutcome } from '../src/mercy-presentation.js';
import { renderTournamentSpectator } from '../src/tournament-view.js';
import { createDuel } from '../src/combat.js';

test('the winner segment names the victor before exposing any mercy controls', () => {
  const html = renderMercyPanel({ phase: 'winner', winnerName: 'Cassian', isWinner: true });
  assert.match(html, /Cassian/);
  assert.match(html, /WINNER!/);
  assert.doesNotMatch(html, /MERCY\?|<button|data-deadline/);
});

test('the victor receives the exact three choices and an authoritative twenty-second clock', () => {
  const html = renderMercyPanel({ phase: 'mercy', winnerName: 'Cassian', isWinner: true, deadline: 21000, now: 1000 });
  assert.match(html, /MERCY\?/);
  assert.match(html, /data-deadline="21000">20<\/span>/);
  assert.match(html, /data-action="mercy" data-value="spare"[^>]*>Spare<\/button>/);
  assert.match(html, /data-action="mercy" data-value="execute"[^>]*>Kill<\/button>/);
  assert.match(html, /data-action="mercy" data-value="crowd"[^>]*>Let crowd decide<\/button>/);
  assert.equal((html.match(/<button/g) || []).length, 3);
});

test('other viewers cannot choose mercy and in-flight victor controls are disabled', () => {
  const spectator = renderMercyPanel({ winnerName: 'Cassian', isWinner: false });
  assert.match(spectator, /Awaiting the winner’s verdict/);
  assert.doesNotMatch(spectator, /<button/);
  const busy = renderMercyPanel({ isWinner: true, disabled: true });
  assert.equal((busy.match(/ disabled/g) || []).length, 3);
});

test('crowd votes use the public counts, current vote and voting permissions', () => {
  const html = renderMercyPanel({ phase: 'crowd', now: 9000, crowdVote: {
    deadline: 24000, counts: { spare: 4, execute: 2 }, canVote: true, yourVote: null,
  } });
  assert.match(html, /THE CROWD DECIDES/);
  assert.match(html, /data-deadline="24000">15<\/span>/);
  assert.match(html, /Spare <strong>4<\/strong>/);
  assert.match(html, /Kill <strong>2<\/strong>/);
  assert.equal((html.match(/data-action="crowd-vote"/g) || []).length, 2);
  assert.doesNotMatch(html, / disabled|data-action="mercy"/);
  const voted = renderMercyPanel({ phase: 'crowd', crowdVote: {
    counts: { spare: 4, execute: 3 }, canVote: false, yourVote: 'execute',
  } });
  assert.equal((voted.match(/ disabled/g) || []).length, 2);
  assert.match(voted, /data-value="execute" aria-pressed="true"/);
  assert.match(voted, /Your vote: Kill/);
  assert.doesNotMatch(renderMercyPanel({ phase: 'crowd', crowdVote: { canVote: false } }), /<button/);
});

test('names are escaped and malformed countdown/count values cannot create markup', () => {
  const html = renderMercyPanel({ winnerName: '<img src=x onerror="evil()">', deadline: '<script>', now: 0 });
  assert.match(html, /&lt;img src=x onerror=&quot;evil\(\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img|<script|data-deadline/);
  assert.match(renderMercyPanel({ deadline: 999999, now: 0 }), />20<\/span>/);
  assert.match(renderMercyPanel({ deadline: -1000, now: 0 }), />0<\/span>/);
  const votes = renderMercyPanel({ phase: 'crowd', crowdVote: { counts: { spare: -1, execute: '99' } } });
  assert.equal((votes.match(/<strong>0<\/strong>/g) || []).length, 2);
  assert.equal(renderMercyPanel({ phase: 'invented' }), '');
});

test('personal outcomes use the exact phrases and procedural blood only for death', () => {
  const spared = renderOutcomeOverlay('spare');
  assert.match(spared, /You live to fight another day!/);
  assert.doesNotMatch(spared, /<svg|outcome-blood/);
  const death = renderOutcomeOverlay({ decision: 'execute' });
  assert.match(death, /Hades takes your soul\./);
  assert.match(death, /loser-outcome-death/);
  assert.match(death, /shape-rendering="crispEdges"/);
  assert.match(death, /outcome-blood-drip/);
  assert.doesNotMatch(death, /<image|<img|href=/);
  assert.equal(renderOutcomeOverlay('crowd'), '');
  assert.equal(renderOutcomeOverlay(null), '');
});

class Node {
  constructor(document, connected = false) { this.ownerDocument = document; this.children = []; this.parentNode = null; this.connected = connected; }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : this.connected; }
  append(node) { node.remove(); node.parentNode = this; this.children.push(node); }
  remove() { if (!this.parentNode) return; const parent = this.parentNode; parent.children.splice(parent.children.indexOf(this), 1); this.parentNode = null; }
}
function fixture() {
  const document = { createElement() { return new Node(document); } };
  const container = new Node(document, true), nativeArena = new Node(document);
  container.append(nativeArena);
  return { document, container, nativeArena };
}
async function withClock(run) {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const timers = new Map();
  let id = 0;
  globalThis.setTimeout = (callback, delay) => { const key = ++id; timers.set(key, { callback, delay }); return key; };
  globalThis.clearTimeout = key => timers.delete(key);
  try { await run({ timers, finish() { const [key, timer] = timers.entries().next().value; timers.delete(key); timer.callback(); } }); }
  finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; }
}

test('the normal personal overlay lasts 3.5 seconds and restores the original arena node', async () => {
  await withClock(async clock => {
    const { container, nativeArena } = fixture();
    const result = playLoserOutcome(container, 'execute', { reducedMotion: false });
    assert.equal(container.children.length, 2);
    assert.match(container.children[1].innerHTML, /Hades takes your soul/);
    assert.equal([...clock.timers.values()][0].delay, 3500);
    clock.finish();
    assert.equal(await result, true);
    assert.deepEqual(container.children, [nativeArena]);
    assert.equal(clock.timers.size, 0);
  });
});

test('reduced motion is a short quiet cue with the original stage preserved', async () => {
  await withClock(async clock => {
    const { container, nativeArena } = fixture();
    const result = playLoserOutcome(container, 'spare', { reducedMotion: true });
    assert.match(container.children[1].className, /loser-outcome-reduced/);
    assert.equal([...clock.timers.values()][0].delay, 650);
    clock.finish();
    assert.equal(await result, true);
    assert.deepEqual(container.children, [nativeArena]);
  });
});

test('a held death cue stays above the native arena until the departure handoff aborts it', async () => {
  await withClock(async clock => {
    const { container, nativeArena } = fixture();
    const controller = new AbortController();
    const result = playLoserOutcome(container, 'execute', { signal: controller.signal, reducedMotion: false, hold: true });
    clock.finish();
    assert.equal(await result, true);
    assert.equal(container.children.length, 2);
    assert.equal(container.children[0], nativeArena);
    controller.abort();
    assert.deepEqual(container.children, [nativeArena]);
    assert.equal(clock.timers.size, 0);
  });
});

test('browser disconnection releases a held outcome and its observer', async () => {
  await withClock(async clock => {
    const { document, container, nativeArena } = fixture();
    let observer;
    document.documentElement = container;
    document.defaultView = { MutationObserver: class {
      constructor(callback) { this.callback = callback; observer = this; }
      observe() { this.observing = true; }
      disconnect() { this.observing = false; }
    } };
    const result = playLoserOutcome(container, 'execute', { hold: true });
    clock.finish();
    assert.equal(await result, true);
    assert.equal(observer.observing, true);
    container.connected = false;
    observer.callback();
    assert.deepEqual(container.children, [nativeArena]);
    assert.equal(observer.observing, false);
  });
});

test('abort and unexpected overlay removal cancel presentation without disturbing the arena', async () => {
  await withClock(async clock => {
    const { container, nativeArena } = fixture();
    const controller = new AbortController();
    const result = playLoserOutcome(container, 'execute', { signal: controller.signal });
    controller.abort();
    assert.equal(await result, false);
    assert.deepEqual(container.children, [nativeArena]);
    assert.equal(clock.timers.size, 0);
    const removed = playLoserOutcome(container, 'spare');
    container.children[1].remove();
    clock.finish();
    assert.equal(await removed, false);
    assert.deepEqual(container.children, [nativeArena]);
  });
});

test('invalid outcomes, detached stages and pre-aborted signals create no overlay', async () => {
  const { container, nativeArena } = fixture();
  const controller = new AbortController(); controller.abort();
  assert.equal(await playLoserOutcome(container, 'execute', { signal: controller.signal }), false);
  assert.equal(await playLoserOutcome(container, 'crowd'), false);
  container.connected = false;
  assert.equal(await playLoserOutcome(container, 'spare'), false);
  assert.deepEqual(container.children, [nativeArena]);
});

test('a partially failed overlay mount cleans its own node and preserves the native arena', async () => {
  const { container, nativeArena } = fixture();
  const append = container.append.bind(container);
  container.append = node => { append(node); throw new Error('synthetic mount failure'); };
  await assert.rejects(playLoserOutcome(container, 'execute'), /synthetic mount failure/);
  assert.deepEqual(container.children, [nativeArena]);
});

const fighter = name => ({ character: { name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' }, weapon: 'sword', armor: 'medium' });
function spectatorView(phase) {
  const duel = structuredClone(createDuel([fighter('Cassian'), fighter('Lyra')]));
  duel.status = 'complete'; duel.result = { winner: 0, reason: 'knockout' }; duel.fighters[1].hp = 0;
  return { type: 'tournament', code: 'ROME12', you: 2, phase, currentMatchIndex: 0,
    players: [{ character: { name: 'Cassian' } }, { character: { name: 'Lyra' } }, { character: { name: 'Watcher' }, alive: true }],
    bracket: [{ index: 0, slots: [0, 1], status: 'active' }],
    match: { slots: [0, 1], duel, deadline: Date.now() + 20000, crowdVote: { deadline: Date.now() + 20000, counts: { spare: 2, execute: 1 }, canVote: true, yourVote: null } } };
}

test('spectators retain the same native stands frame while seeing mercy and crowd votes', () => {
  const mercy = renderTournamentSpectator(spectatorView('mercy'));
  assert.match(mercy, /MERCY\?/);
  assert.match(mercy, /translate\(340 365\) scale\(\.5\)/);
  assert.match(mercy, /spectator-frame/);
  assert.doesNotMatch(mercy, /data-action="mercy"/);
  const crowd = renderTournamentSpectator(spectatorView('crowd'));
  assert.match(crowd, /THE CROWD DECIDES/);
  assert.equal((crowd.match(/data-action="crowd-vote"/g) || []).length, 2);
  assert.match(crowd, /translate\(580 365\) scale\(-\.5 \.5\)/);
});

test('winner reveal and execution keep the spectator arena even across a completed final', () => {
  const winner = renderTournamentSpectator(spectatorView('mercy'), { verdictPhase: 'winner' });
  assert.match(winner, /WINNER!/);
  assert.doesNotMatch(winner, /MERCY\?|data-action="mercy"/);
  const view = spectatorView('complete'); view.champion = 0;
  const execution = renderTournamentSpectator(view, { executing: true, duel: view.match.duel });
  assert.match(execution, /arena-svg/);
  assert.match(execution, /spectator-frame/);
  assert.match(execution, /translate\(340 365\) scale\(\.5\)/);
  assert.doesNotMatch(execution, /takes the crown|data-action="mercy"|data-action="crowd-vote"/);
  assert.match(renderTournamentSpectator(view), /takes the crown/);
});
