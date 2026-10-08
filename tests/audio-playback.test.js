import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, resolveRound } from '../src/combat.js';
import { buildAnimationSteps, playBattleAnimation } from '../src/battle-animation.js';
import { playExecutionAnimation } from '../src/execution-animation.js';

// A tree fixture checks timing and cleanup; it makes no claim about audible quality.
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributeMap = new Map();
    this.textContent = '';
    this.hidden = false;
    this.style = { properties: new Map(), setProperty(name, value) { this.properties.set(name, String(value)); }, removeProperty(name) { this.properties.delete(name); } };
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`) ?? undefined,
      set: (_, key, value) => { this.setAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value); return true; },
      deleteProperty: (_, key) => { this.removeAttribute(`data-${String(key).replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`); return true; },
    });
    this.classList = {
      contains: value => this.classes.includes(value),
      add: (...values) => this.setAttribute('class', [...new Set([...this.classes, ...values])].join(' ')),
      remove: (...values) => this.setAttribute('class', this.classes.filter(value => !values.includes(value)).join(' ')),
    };
  }
  get classes() { return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get attributes() { return [...this.attributeMap].map(([name, value]) => ({ name, value })); }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { return this.parentNode?.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null; }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : !!this.rootConnected; }
  getAttribute(name) { return this.attributeMap.get(name) ?? null; }
  hasAttribute(name) { return this.attributeMap.has(name); }
  setAttribute(name, value) { this.attributeMap.set(name, String(value)); }
  removeAttribute(name) { this.attributeMap.delete(name); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, reference) {
    node.remove();
    const index = reference ? this.childNodes.indexOf(reference) : this.childNodes.length;
    if (index < 0) throw new Error('Missing insertion anchor');
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  matches(selector) {
    const tag = selector.match(/^[\w-]+/)?.[0];
    if (tag && this.tagName.toLowerCase() !== tag.toLowerCase()) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classes.includes(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (!this.hasAttribute(name) || value !== undefined && this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const descendants = this.childNodes.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(node => selectors.some(value => value === '*' || node.matches(value)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function arenaFixture({ loser = 1, defeated = true } = {}) {
  const doc = { createElement: tag => new Element(tag, doc), createElementNS: (_, tag) => new Element(tag, doc) };
  const element = (tag, attrs = {}) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const container = element('div', { class: 'arena-stage existing-container', 'data-preserved': 'yes' });
  container.rootConnected = true;
  const stage = element('svg', { class: 'arena-svg', viewBox: '0 0 800 450' });
  const fighters = [0, 1].map(index => {
    const fighter = element('g', { class: 'arena-fighter', 'data-fighter-index': index, transform: index ? 'translate(610 360) scale(-1 1)' : 'translate(190 360)' });
    if (defeated && index === loser) fighter.setAttribute('data-defeated', 'true');
    const gladiator = element('g', { class: `gladiator pixel-gladiator clean-gladiator${defeated && index === loser ? ' defeated' : ''}`, transform: 'scale(2)' });
    const shadow = element('ellipse', { cx: 0, cy: 1, rx: 25, ry: 4 });
    const motion = element('g', { class: 'fighter-motion' });
    const body = element('image', { class: 'fighter-body pixel-sprite', href: `/preserved-fighter-${index}.png`, x: -96, y: -152, width: 192, height: 160, transform: 'scale(-1 1)' });
    const weapon = element('g', { class: 'fighter-weapon-pivot', transform: 'translate(-12 -26)' });
    weapon.append(element('g', { class: 'fighter-weapon-motion' }));
    const effects = element('g', { class: 'fighter-effects', transform: 'translate(0 -74)' });
    motion.append(body, weapon, effects);
    gladiator.append(shadow, motion);
    fighter.append(gladiator);
    return fighter;
  });
  stage.append(...fighters);
  container.append(stage);
  return { doc, container, stage, fighters };
}

const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
const snapshot = node => ({ tag: node.tagName, attributes: [...node.attributeMap], children: node.childNodes.map(snapshot) });
async function playbackClock(run) {
  const original = { timeout: globalThis.setTimeout, clear: globalThis.clearTimeout, document: globalThis.document };
  const timers = new Map();
  let id = 0, elapsed = 0;
  globalThis.setTimeout = (callback, delay) => { timers.set(++id, { callback, delay }); return id; };
  globalThis.clearTimeout = timer => timers.delete(timer);
  const clock = {
    get elapsed() { return elapsed; },
    async step() {
      await settle();
      const [timer, entry] = timers.entries().next().value ?? [];
      assert.ok(entry, 'Playback should reach its next visual phase.');
      timers.delete(timer); elapsed += entry.delay; entry.callback(); await settle();
    },
    async finish() {
      for (let count = 0; count < 100; count++) {
        await settle();
        if (!timers.size) return;
        await this.step();
      }
      assert.fail('Playback must finish in a bounded number of phases.');
    },
  };
  try { await run(clock); }
  finally {
    globalThis.setTimeout = original.timeout; globalThis.clearTimeout = original.clear;
    if (original.document === undefined) delete globalThis.document;
    else globalThis.document = original.document;
  }
}
const step = (type, extra = {}) => ({ type, actor: 0, weapon: 'dagger', text: type, ...extra });

test('resolved playback cues occur at swing/contact and distinguish Guard, bypass and Riposte', async () => {
  await playbackClock(async clock => {
    const arena = arenaFixture({ defeated: false }); globalThis.document = arena.doc;
    const steps = [step('reveal', { actor: null }), step('guard'), step('riposte'), step('riposte-miss'),
      step('recover', { restored: 3 }),
      step('attack', { target: 1, damage: 2, guarded: true }),
      step('attack', { target: 1, damage: 3, guarded: true, bypassedGuard: true }),
      step('attack', { target: 1, damage: 2, parried: true, counter: true }), step('defeat')];
    const preserved = structuredClone(steps), cues = [];
    const playback = playBattleAnimation(arena.container, steps, { reducedMotion: false, onCue: cue => {
      assert.equal(Object.isFrozen(cue), true); cues.push(cue);
    } });
    assert.deepEqual(cues, [{ type: 'round' }]);
    await clock.finish(); assert.equal(await playback, true);
    assert.deepEqual(cues.map(cue => cue.type), ['round', 'guard', 'guard', 'recover', 'swing', 'parry', 'swing', 'hit', 'swing', 'parry', 'defeat']);
    assert.deepEqual(cues.filter(cue => cue.counter), [{ type: 'swing', weapon: 'dagger', counter: true }, { type: 'parry', weapon: 'dagger', counter: true }]);
    assert.deepEqual(steps, preserved);
    assert.equal(arena.container.querySelectorAll('.fighter-combat-effect').length, 0);
    assert.equal(arena.container.querySelectorAll('.battle-animation-caption').length, 0);
    assert.equal(arena.container.classList.contains('battle-playback'), false);
  });
});

test('canceled lethal responses produce no second swing or hidden-choice sound', async () => {
  await playbackClock(async clock => {
    const arena = arenaFixture({ defeated: false }); globalThis.document = arena.doc;
    const character = name => ({ name, trait: 'balanced', stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 } });
    const before = structuredClone(createDuel([{ character: character('A'), weapon: 'spear', armor: 'light' }, { character: character('B'), weapon: 'axe', armor: 'heavy' }]));
    before.fighters[1].hp = 1;
    const after = resolveRound(before, ['technique', 'strike']);
    const cues = [], playback = playBattleAnimation(arena.container, buildAnimationSteps(before, after, ['guard', 'recover']), { reducedMotion: true, onCue: cue => cues.push(cue.type) });
    await clock.finish(); assert.equal(await playback, true);
    assert.deepEqual(cues, ['round', 'swing', 'hit', 'defeat']);
  });
});

test('aborting during windup emits no later impact and cleans the visual state', async () => {
  await playbackClock(async () => {
    const arena = arenaFixture({ defeated: false }); globalThis.document = arena.doc;
    const controller = new AbortController(), cues = [];
    const playback = playBattleAnimation(arena.container, [step('attack', { target: 1, damage: 3 })], { signal: controller.signal, onCue: cue => { cues.push(cue.type); controller.abort(); } });
    assert.equal(await playback, false); assert.deepEqual(cues, ['swing']);
    assert.equal(arena.container.querySelectorAll('.fighter-combat-effect').length, 0);
    assert.equal(arena.container.classList.contains('battle-playback'), false);
    assert.ok(arena.fighters.every(fighter => fighter.dataset.animation === undefined));
  });
});

test('synchronous and asynchronous audio failures cannot interrupt round playback', async () => {
  for (const rejectAsync of [false, true]) await playbackClock(async clock => {
    const arena = arenaFixture({ defeated: false }); globalThis.document = arena.doc;
    const playback = playBattleAnimation(arena.container, [step('attack', { target: 1, damage: 3 })], { onCue: () => {
      if (rejectAsync) return Promise.reject(new Error('Audio unavailable'));
      throw new Error('Audio unavailable');
    } });
    await clock.finish(); assert.equal(await playback, true);
    assert.equal(arena.container.querySelectorAll('.fighter-combat-effect').length, 0);
    assert.ok(arena.fighters.every(fighter => fighter.dataset.animation === undefined));
  });
});

test('an arena detached during windup emits no impact cue', async () => {
  await playbackClock(async clock => {
    const arena = arenaFixture({ defeated: false }); globalThis.document = arena.doc;
    const cues = [], playback = playBattleAnimation(arena.container, [step('attack', { target: 1, damage: 3 })], { onCue: cue => cues.push(cue.type) });
    arena.container.rootConnected = false;
    await clock.step(); assert.equal(await playback, false);
    assert.deepEqual(cues, ['swing']);
    assert.equal(arena.container.classList.contains('battle-playback'), false);
  });
});

const execution = { winner: 0, loser: 1, weapon: 'dagger', text: 'Accepted execution.' };
test('execution cue fires once at connected impact, including reduced motion, and handler failure preserves cleanup', async () => {
  for (const reducedMotion of [false, true]) await playbackClock(async clock => {
    const arena = arenaFixture(), preserved = snapshot(arena.container), cues = [];
    const playback = playExecutionAnimation(arena.container, execution, { reducedMotion, onCue: cue => {
      assert.equal(arena.container.getAttribute('data-execution-phase'), 'impact');
      assert.equal(Object.isFrozen(cue), true); cues.push({ cue, at: clock.elapsed });
      throw new Error('Audio unavailable');
    } });
    if (!reducedMotion) { assert.equal(cues.length, 0); await clock.step(); assert.equal(cues.length, 0); }
    await clock.finish(); assert.equal(await playback, true);
    assert.deepEqual(cues, [{ cue: { type: 'execution', weapon: 'dagger' }, at: reducedMotion ? 0 : 740 }]);
    assert.deepEqual(snapshot(arena.container), preserved);
  });
});

test('aborted or invalid execution has no impact cue and preserves the registered figure tree', async () => {
  await playbackClock(async clock => {
    const arena = arenaFixture(), preserved = snapshot(arena.container), controller = new AbortController(), cues = [];
    const playback = playExecutionAnimation(arena.container, execution, { signal: controller.signal, onCue: cue => cues.push(cue) });
    await clock.step(); controller.abort(); assert.equal(await playback, false);
    assert.deepEqual(cues, []); assert.deepEqual(snapshot(arena.container), preserved);
    assert.equal(await playExecutionAnimation(arena.container, { ...execution, loser: 0 }, { onCue: cue => cues.push(cue) }), false);
    assert.deepEqual(cues, []);
  });
});
