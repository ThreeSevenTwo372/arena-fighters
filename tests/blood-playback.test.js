import test from 'node:test';
import assert from 'node:assert/strict';
import { playBattleAnimation } from '../src/battle-animation.js';

// A layout-free SVG fixture checks public contact, ownership and cleanup.
class Element {
  constructor(tag, document) {
    this.tagName = tag; this.ownerDocument = document; this.parentNode = null;
    this.childNodes = []; this.attributes = new Map(); this.textContent = '';
    const attribute = name => `data-${String(name).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`;
    this.dataset = new Proxy({}, {
      get: (_, name) => this.getAttribute(attribute(name)) ?? undefined,
      set: (_, name, value) => { this.setAttribute(attribute(name), value); return true; },
      deleteProperty: (_, name) => { this.attributes.delete(attribute(name)); return true; },
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
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...nodes) { for (const node of nodes) { node.remove(); this.childNodes.push(node); node.parentNode = this; } }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  matches(selector) {
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classes.includes(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (!this.attributes.has(name) || value !== undefined && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    return this.childNodes.flatMap(child => [child, ...child.querySelectorAll('*')]).filter(node => selector === '*' || node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function fixture(viewer) {
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_, tag) => new Element(tag, document) };
  const node = (tag, attrs) => {
    const result = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) result.setAttribute(name, value);
    return result;
  };
  const container = node('div', { class: 'arena-stage' });
  container.rootConnected = true;
  const stage = node('svg', { class: 'arena-svg' });
  const fighters = [0, 1].map(index => node('g', {
    class: `arena-fighter${viewer === index ? ' fp-viewmodel' : ''}`, 'data-fighter-index': index, 'data-weapon': 'sword',
  }));
  for (const fighter of fighters) fighter.append(node('g', { class: 'fighter-effects', transform: 'translate(0 -74)' }));
  stage.append(...fighters); container.append(stage);
  return { document, container, stage, fighters };
}

const snapshot = node => ({ attrs: [...node.attributes].sort(), text: node.textContent, children: node.childNodes.map(snapshot) });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const attack = (actor, damage, extra = {}) => ({ type: 'attack', actor, target: 1 - actor, round: 3,
  weapon: 'sword', action: 'strike', damage, text: 'A resolved attack.', ...extra });

async function controlled(run) {
  const timeout = globalThis.setTimeout, clear = globalThis.clearTimeout, document = globalThis.document;
  const timers = new Map(); let id = 0, elapsed = 0, maxPending = 0;
  globalThis.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); maxPending = Math.max(maxPending, timers.size); return id; };
  globalThis.clearTimeout = timer => timers.delete(timer);
  const clock = {
    get elapsed() { return elapsed; }, get pending() { return timers.size; }, get maxPending() { return maxPending; },
    async step() {
      await settle(); const [key, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'The existing public playback wait is present.');
      timers.delete(key); elapsed += timer.delay; timer.callback(); await settle();
    },
    async finish() { for (let i = 0; i < 32; i++) { await settle(); if (!timers.size) return; await this.step(); } assert.fail('Playback must be bounded.'); },
  };
  try { await run(clock); }
  finally { globalThis.setTimeout = timeout; globalThis.clearTimeout = clear; globalThis.document = document; }
}

test('blood appears at resolved contact on either fighter, increases with public damage, and uses no new wait', async () => {
  for (const actor of [0, 1]) {
    let previousCount = 0;
    for (const damage of [1, 8, 20]) await controlled(async clock => {
      const arena = fixture(), before = snapshot(arena.container), step = attack(actor, damage), original = structuredClone(step);
      globalThis.document = arena.document;
      const playback = playBattleAnimation(arena.container, [step], { reducedMotion: false });
      await settle();
      assert.equal(arena.container.querySelector('.pixel-blood-effect'), null);
      await clock.step(); assert.equal(clock.elapsed, 285);
      const blood = arena.fighters[1 - actor].querySelector('.pixel-blood-effect');
      assert.ok(blood); assert.equal(arena.fighters[actor].querySelector('.pixel-blood-effect'), null);
      assert.equal(blood.getAttribute('data-blood-damage'), String(damage));
      const count = blood.querySelectorAll('.pixel-blood-particle').length;
      assert.ok(count > previousCount); previousCount = count;
      assert.equal(blood.parentNode.parentNode, arena.fighters[1 - actor].querySelector('.fighter-effects'));
      await clock.finish(); assert.equal(await playback, true);
      assert.equal(clock.elapsed, 765); assert.equal(clock.maxPending, 1); assert.equal(clock.pending, 0);
      assert.deepEqual(step, original); assert.deepEqual(snapshot(arena.container), before);
    });
  }
});

test('a zero-damage parry or block has its existing impact cue without blood', async () => {
  for (const extra of [{ parried: true }, { guarded: true }]) await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container); globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack(0, 0, extra)], { reducedMotion: false });
    await clock.step();
    assert.equal(arena.fighters[1].dataset.animation, 'blocked');
    assert.ok(arena.fighters[1].querySelector('.fighter-combat-effect'));
    assert.equal(arena.container.querySelector('.pixel-blood-effect'), null);
    await clock.finish(); assert.equal(await playback, true); assert.equal(clock.elapsed, 765);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('positive guarded and parried chip damage still produces its smaller public-damage burst', async () => {
  for (const extra of [{ parried: true }, { guarded: true }]) await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container); globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack(0, 2, extra)], { reducedMotion: false });
    await clock.step();
    const blood = arena.fighters[1].querySelector('.pixel-blood-effect');
    assert.equal(blood.getAttribute('data-blood-damage'), '2');
    assert.equal(blood.querySelectorAll('.pixel-blood-particle').length, 10);
    await clock.finish(); assert.equal(await playback, true);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('first-person incoming damage uses screen coordinates and navigation abort removes the whole overlay', async () => {
  for (const viewer of [0, 1]) await controlled(async clock => {
    const arena = fixture(viewer), before = snapshot(arena.container), controller = new AbortController();
    globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack(1 - viewer, 9)], { signal: controller.signal, reducedMotion: false });
    await clock.step();
    const blood = arena.container.querySelector('.pixel-blood-effect');
    assert.equal(blood.getAttribute('data-blood-view'), 'screen');
    assert.equal(blood.parentNode.getAttribute('transform'), 'translate(460 270)');
    assert.equal(blood.parentNode.parentNode.parentNode, arena.stage);
    assert.equal(arena.fighters[viewer].querySelector('.pixel-blood-effect'), null);
    controller.abort(); await settle(); assert.equal(await playback, false);
    assert.equal(clock.pending, 0); assert.deepEqual(snapshot(arena.container), before);
  });
});

test('reduced-motion blood keeps stationary geometry and the existing 275ms attack interval', async () => {
  await controlled(async clock => {
    const arena = fixture(0), before = snapshot(arena.container); globalThis.document = arena.document;
    const playback = playBattleAnimation(arena.container, [attack(1, 7)], { reducedMotion: true });
    await clock.step(); assert.equal(clock.elapsed, 90);
    const blood = arena.container.querySelector('.pixel-blood-effect');
    assert.equal(blood.getAttribute('data-reduced-motion'), 'true');
    assert.equal(blood.parentNode.getAttribute('transform'), 'translate(460 270)');
    await clock.finish(); assert.equal(await playback, true); assert.equal(clock.elapsed, 275);
    assert.equal(clock.maxPending, 1); assert.deepEqual(snapshot(arena.container), before);
  });
});
