import test from 'node:test';
import assert from 'node:assert/strict';
import { playBattleAnimation } from '../src/battle-animation.js';

// Attribute-only fixtures keep this test about the public clock and cleanup;
// browser captures separately verify how authored pose frames look.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.parentNode = null;
    this.childNodes = []; this.attributes = new Map(); this.textContent = '';
    this.dataset = new Proxy({}, {
      get: (_, name) => this.getAttribute(`data-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_, name, value) => { this.setAttribute(`data-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, value); return true; },
      deleteProperty: (_, name) => { this.removeAttribute(`data-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`); return true; },
    });
    this.classList = {
      add: (...names) => this.setAttribute('class', [...new Set([...this.classes, ...names])].join(' ')),
      remove: (...names) => this.setAttribute('class', this.classes.filter(name => !names.includes(name)).join(' ')),
    };
  }
  get classes() { return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  set className(value) { this.setAttribute('class', value); }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : !!this.rootConnected; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.remove(); this.childNodes.push(node); node.parentNode = this; } }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  matches(selector) {
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classes.includes(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (!this.hasAttribute(name) || value !== undefined && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    return this.childNodes.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(node => selector === '*' || node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function fixture() {
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_, tag) => new Element(tag, document) };
  const node = (tag, attrs) => {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    return element;
  };
  const container = node('div', { class: 'arena-stage first-person-stage original' });
  container.rootConnected = true;
  const fighters = [0, 1].map(index => node('g', { class: 'arena-fighter', 'data-fighter-index': index, 'data-weapon': 'sword' }));
  for (const fighter of fighters) fighter.append(node('g', { class: 'fighter-effects' }));
  container.append(...fighters);
  return { document, container, fighters };
}

const snapshot = node => ({ tag: node.tagName, attrs: [...node.attributes].sort(), text: node.textContent, children: node.childNodes.map(snapshot) });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const milestones = [0, 90, 180, 285, 365, 475, 570, 665];

async function controlled(run) {
  const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout, originalDocument = globalThis.document;
  const timers = new Map(), durations = [];
  let id = 0, elapsed = 0, maxPending = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    timers.set(++id, { callback, milliseconds }); maxPending = Math.max(maxPending, timers.size); return id;
  };
  globalThis.clearTimeout = timer => timers.delete(timer);
  const clock = {
    get elapsed() { return elapsed; }, get pending() { return timers.size; },
    get maxPending() { return maxPending; }, durations,
    async step() {
      await settle();
      const [key, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'Playback has exactly one bounded wait to advance.');
      timers.delete(key); elapsed += timer.milliseconds; durations.push(timer.milliseconds); timer.callback(); await settle();
    },
    async finish() { for (let i = 0; i < 64; i++) { await settle(); if (!timers.size) return; await this.step(); } assert.fail('Playback failed to finish.'); },
  };
  try { await run(clock); }
  finally { globalThis.setTimeout = timeout; globalThis.clearTimeout = clear; globalThis.document = originalDocument; }
}

const attack = (actor = 0) => ({ type: 'attack', actor, target: 1 - actor, weapon: 'sword', action: 'technique',
  damage: 5, guarded: false, bypassedGuard: false, targetHp: 15, text: 'Resolved attack.' });

test('complete pose milestones use one clock and reach the contact frame before the public target reaction', async () => {
  for (const actor of [0, 1]) await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), step = attack(actor), events = [], cues = [];
    globalThis.document = arena.document;
    const original = structuredClone(step);
    const playback = playBattleAnimation(arena.container, [step], { reducedMotion: false,
      onCue: cue => cues.push([clock.elapsed, cue.type]),
      onAttackFrame: frame => {
        assert.ok(Object.isFrozen(frame)); assert.ok(Object.isFrozen(frame.step));
        assert.deepEqual(frame.step, original); assert.notEqual(frame.step, step);
        if (frame.elapsedMs <= 285) assert.equal(arena.fighters[1 - actor].dataset.animation, undefined,
          'Damage feedback cannot precede the authoritative contact frame.');
        events.push([clock.elapsed, frame.elapsedMs]);
      } });
    await settle();
    assert.deepEqual(events, [[0, 0]]);
    for (const time of [90, 180, 285]) {
      await clock.step(); assert.equal(clock.elapsed, time);
      if (time < 285) assert.equal(arena.fighters[1 - actor].dataset.animation, undefined);
    }
    assert.equal(arena.fighters[1 - actor].dataset.animation, 'hit');
    assert.ok(arena.fighters[1 - actor].querySelector('.fighter-combat-effect'));
    await clock.finish();
    assert.equal(await playback, true);
    assert.deepEqual(events, milestones.map(time => [time, time]));
    assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]);
    assert.equal(clock.elapsed, 765, 'The 665ms attack and existing 100ms inter-step interval remain unchanged.');
    assert.equal(clock.maxPending, 1, 'Frame swaps add no concurrent timer.');
    assert.equal(clock.pending, 0); assert.deepEqual(step, original); assert.deepEqual(snapshot(arena.container), before);
  });
});

test('spectators keep the original two attack waits and reduced motion receives no authored frame sequence', async () => {
  for (const reducedMotion of [false, true]) await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), frames = [];
    globalThis.document = arena.document;
    const options = { reducedMotion, ...(reducedMotion ? { onAttackFrame: frame => frames.push(frame) } : {}) };
    const playback = playBattleAnimation(arena.container, [attack()], options);
    await clock.finish();
    assert.equal(await playback, true); assert.deepEqual(frames, []);
    assert.deepEqual(clock.durations, reducedMotion ? [90, 150, 35] : [285, 380, 100]);
    assert.equal(clock.maxPending, 1); assert.deepEqual(snapshot(arena.container), before);
  });
});

test('presentation callback failures leave every public attack milestone, contact and final cleanup intact', async () => {
  await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), frames = [], cues = [];
    globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack()], { reducedMotion: false,
      onCue: cue => cues.push([clock.elapsed, cue.type]), onAttackFrame: frame => {
        frames.push(frame.elapsedMs);
        if (frame.elapsedMs === 180) return Promise.reject(new Error('Frame media failed.'));
        if (frame.elapsedMs === 365) throw new Error('Frame callback failed.');
      } });
    await clock.finish();
    assert.equal(await playback, true); assert.deepEqual(frames, milestones);
    assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]); assert.equal(clock.elapsed, 765);
    assert.equal(clock.pending, 0); assert.deepEqual(snapshot(arena.container), before);
  });
});

test('abort at any authored pose stops later frames and cleans captions, effects and temporary attributes', async () => {
  for (const stopAt of milestones) await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), frames = [], controller = new AbortController(), cues = [];
    globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack()], { signal: controller.signal, reducedMotion: false,
      onCue: cue => cues.push(cue.type), onAttackFrame: frame => {
        frames.push(frame.elapsedMs); if (frame.elapsedMs === stopAt) controller.abort();
      } });
    await clock.finish();
    assert.equal(await playback, false); assert.deepEqual(frames, milestones.filter(time => time <= stopAt));
    assert.equal(cues.includes('hit'), stopAt > 285, 'An abort at contact happens before target damage feedback.');
    assert.equal(clock.pending, 0); assert.deepEqual(snapshot(arena.container), before);
  });
});

test('detachment during a pose prevents subsequent frames and an already-aborted request emits nothing', async () => {
  await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), frames = [];
    globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack()], { reducedMotion: false, onAttackFrame: frame => {
      frames.push(frame.elapsedMs); if (frame.elapsedMs === 180) arena.container.rootConnected = false;
    } });
    await clock.finish();
    assert.equal(await playback, false); assert.deepEqual(frames, [0, 90, 180]);
    assert.equal(clock.pending, 0); assert.deepEqual(snapshot(arena.container), before);
    const controller = new AbortController(); controller.abort(); arena.container.rootConnected = true;
    assert.equal(await playBattleAnimation(arena.container, [attack()], { signal: controller.signal, onAttackFrame: frame => frames.push(frame.elapsedMs) }), false);
    assert.deepEqual(frames, [0, 90, 180]); assert.deepEqual(snapshot(arena.container), before);
  });
});
