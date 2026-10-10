import test from 'node:test';
import assert from 'node:assert/strict';
import { playFirstPersonBattleAnimation, playFirstPersonExecutionAnimation } from '../src/first-person-animation.js';

// The fixture has tree/attributes but no CSS/layout engine. Browser review checks appearance.
class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
    this.attributeMap = new Map();
    this.textContent = '';
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
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : !!this.rootConnected; }
  getAttribute(name) { return this.attributeMap.get(name) ?? null; }
  hasAttribute(name) { return this.attributeMap.has(name); }
  setAttribute(name, value) { this.attributeMap.set(name, String(value)); }
  removeAttribute(name) { this.attributeMap.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      this.childNodes.push(node);
      node.parentNode = this;
    }
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
    const descendants = this.childNodes.flatMap(child => [child, ...child.querySelectorAll('*')]);
    return descendants.filter(node => selector === '*' || node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function fixture(localIndex = 0, holdMode = null) {
  const doc = { createElement: tag => new Element(tag, doc), createElementNS: (_, tag) => new Element(tag, doc) };
  const element = (tag, attrs = {}) => {
    const node = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  };
  const container = element('div', { class: 'arena-stage first-person-stage original' });
  container.rootConnected = true;
  const svg = element('svg', { class: 'arena-svg first-person-arena', viewBox: '0 0 920 440', 'data-viewmodel-version': holdMode ? 'v003' : 'v001' });
  const camera = element('g', { class: 'fp-camera' });
  const local = element('g', { class: 'arena-fighter fp-viewmodel', 'data-fighter-index': localIndex, 'data-weapon': 'trident' });
  const hand = element('g', { class: 'fp-mainhand', ...(holdMode ? {} : { transform: 'translate(685 354) scale(2)' }) });
  const handMotion = element('g', { class: 'fp-mainhand-motion' });
  const weapon = holdMode ? element('g', { class: 'fp-weapon' }) : element('path', { class: 'fp-weapon', d: 'M0 -25 V25', fill: '#777' });
  if (holdMode) weapon.append(element('image', { class: 'pixel-sprite fp-whole-hold', href: '/complete-hold.png', x: -355, y: -153, width: 460, height: 220 }));
  handMotion.append(weapon);
  hand.append(handMotion);
  if (holdMode) {
    const placement = element('g', { transform: 'translate(710 306) scale(2)' });
    placement.append(hand);
    local.append(placement);
  } else local.append(hand);
  if (holdMode !== 'both') {
    const off = element('g', { class: 'fp-offhand-motion' });
    if (holdMode) off.append(element('image', { class: 'pixel-sprite fp-whole-hold', href: '/complete-offhand.png', x: -155, y: -153, width: 460, height: 220 }));
    local.append(off);
  }
  local.append(element('g', { class: 'fighter-effects', transform: 'translate(460 330)' }));
  const opponent = element('g', { class: 'arena-fighter fp-opponent', 'data-fighter-index': 1 - localIndex, transform: 'translate(460 347) scale(-1 1)' });
  const gladiator = element('g', { class: 'gladiator clean-gladiator', transform: 'scale(2)' });
  const motion = element('g', { class: 'fighter-motion' });
  motion.append(element('image', { class: 'fighter-body', href: '/unchanged-identity.png', x: -96, y: -152, width: 192, height: 160 }), element('g', { class: 'fighter-effects', transform: 'translate(0 -74)' }));
  gladiator.append(motion);
  opponent.append(gladiator);
  camera.append(opponent, local);
  svg.append(camera, element('g', { class: 'fp-impact', 'aria-hidden': 'true' }));
  container.append(svg);
  return { doc, container, svg, camera, local, opponent, hand, weapon };
}

const snapshot = node => ({ tag: node.tagName, attributes: [...node.attributeMap].sort(), text: node.textContent, children: node.childNodes.map(snapshot) });
const settle = async () => { for (let count = 0; count < 12; count += 1) await Promise.resolve(); };

async function controlled(run) {
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalDocument = globalThis.document;
  let nextId = 0, elapsed = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay: Number(delay) }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const clock = {
    get pending() { return timers.size; },
    get elapsed() { return elapsed; },
    async step() {
      await settle();
      const [id, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'Playback must await a bounded phase');
      timers.delete(id);
      elapsed += timer.delay;
      timer.callback();
      await settle();
    },
    async finish() {
      for (let count = 0; count < 64; count += 1) {
        await settle();
        if (!timers.size) return;
        await this.step();
      }
      assert.fail('Playback failed to finish');
    },
  };
  try { await run(clock); }
  finally { globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; globalThis.document = originalDocument; }
}

test('either seat uses resolved attack contact frames and keeps its equipment and source identity mounted', async () => {
  for (const localIndex of [0, 1]) await controlled(async clock => {
    const arena = fixture(localIndex);
    globalThis.document = arena.doc;
    const before = snapshot(arena.container), weaponBefore = snapshot(arena.weapon);
    const cues = [];
    const steps = Object.freeze([Object.freeze({ type: 'attack', actor: 1 - localIndex, target: localIndex, weapon: 'axe', action: 'strike', damage: 7, text: 'Resolved strike.' })]);
    const playback = playFirstPersonBattleAnimation(arena.container, steps, { reducedMotion: false, onCue: cue => cues.push(cue) });
    await settle();
    assert.equal(arena.opponent.dataset.animation, 'attack');
    assert.equal(arena.local.dataset.animation, undefined, 'A hit starts only at the resolved contact frame');
    assert.equal(arena.container.querySelector('.battle-animation-caption').getAttribute('aria-live'), 'polite');
    await clock.step();
    assert.equal(arena.local.dataset.animation, 'hit');
    assert.equal(arena.local.querySelector('.fighter-combat-effect').querySelector('text').textContent, '−7');
    assert.deepEqual(cues.map(cue => cue.type), ['swing', 'hit']);
    assert.equal(arena.container.querySelector('.fp-weapon'), arena.weapon);
    assert.deepEqual(snapshot(arena.weapon), weaponBefore);
    await clock.finish();
    assert.equal(await playback, true);
    assert.deepEqual(snapshot(arena.container), before);
    assert.equal(clock.pending, 0);
  });
});

test('Focus, guard and actual passive restoration share public captions and never invent a subsequent attack', async () => {
  await controlled(async clock => {
    const arena = fixture(1);
    globalThis.document = arena.doc;
    const before = snapshot(arena.container), cues = [];
    const steps = [{ type: 'focus', actor: 1, weapon: 'trident', damageBonus: 3, text: 'Focus prepared.' },
      { type: 'guard', actor: 0, weapon: 'sword', text: 'Guard raised.' },
      { type: 'stamina-regeneration', actor: 1, weapon: 'trident', restored: 2, text: 'Two stamina restored.' }];
    const playback = playFirstPersonBattleAnimation(arena.container, steps, { reducedMotion: true, onCue: cue => cues.push(cue) });
    await settle();
    assert.equal(arena.local.dataset.animation, 'focus');
    assert.equal(arena.local.querySelector('text').textContent, 'FOCUS +3');
    assert.equal(arena.container.classList.contains('battle-playback-reduced'), true);
    await clock.step();
    await clock.step();
    assert.equal(arena.opponent.dataset.animation, 'guard');
    await clock.step();
    await clock.step();
    assert.equal(arena.local.dataset.animation, 'stamina-regeneration');
    assert.equal(arena.local.querySelector('text').textContent, '+2 SP');
    await clock.finish();
    assert.equal(await playback, true);
    assert.deepEqual(cues.map(cue => cue.type), ['focus', 'guard']);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('battle abort at contact removes temporary effects and restores existing pose attributes', async () => {
  await controlled(async clock => {
    const arena = fixture();
    globalThis.document = arena.doc;
    arena.local.dataset.guarding = 'true';
    const before = snapshot(arena.container), controller = new AbortController();
    const playback = playFirstPersonBattleAnimation(arena.container,
      [{ type: 'attack', actor: 0, target: 1, weapon: 'dagger', damage: 5, text: 'Strike.' }], { signal: controller.signal });
    await clock.step();
    controller.abort();
    assert.equal(await playback, false);
    assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('complete paired and two-handed images stay intact through local attacks, aborts and accepted executions', async () => {
  for (const localIndex of [0, 1]) for (const holdMode of ['paired', 'both']) for (const abort of [false, true]) await controlled(async clock => {
    const arena = fixture(localIndex, holdMode), controller = new AbortController();
    globalThis.document = arena.doc;
    const weapon = holdMode === 'both' ? 'greatsword' : 'sword';
    arena.local.dataset.weapon = weapon;
    const before = snapshot(arena.container), images = arena.local.querySelectorAll('.fp-whole-hold');
    const sourceImages = images.map(snapshot);
    assert.equal(images.length, holdMode === 'paired' ? 2 : 1);
    const playback = playFirstPersonBattleAnimation(arena.container,
      [{ type: 'attack', actor: localIndex, target: 1 - localIndex, weapon, action: 'technique', damage: 5, text: 'Resolved technique.' }],
      { signal: controller.signal, reducedMotion: false });
    await settle();
    assert.equal(arena.local.dataset.animation, 'attack');
    await clock.step();
    if (abort) controller.abort();
    else await clock.finish();
    assert.equal(await playback, !abort);
    assert.deepEqual(images.map(snapshot), sourceImages);
    assert.deepEqual(snapshot(arena.container), before);
    assert.ok(images.every(image => image.isConnected));
    assert.equal(clock.pending, 0);

    const execution = playFirstPersonExecutionAnimation(arena.container,
      { winner: localIndex, loser: 1 - localIndex, weapon, text: 'Confirmed execution.' }, { reducedMotion: false });
    await clock.step();
    await clock.step();
    assert.equal(arena.container.dataset.fpExecutionPhase, 'impact');
    assert.deepEqual(images.map(snapshot), sourceImages);
    await clock.finish();
    assert.equal(await execution, true);
    assert.deepEqual(snapshot(arena.container), before);
    assert.ok(images.every(image => image.isConnected));
    assert.equal(clock.pending, 0);
  });
});

test('accepted execution stays in the same stage for either seat and either outcome with exact cleanup', async () => {
  for (const localIndex of [0, 1]) for (const winner of [0, 1]) await controlled(async clock => {
    const arena = fixture(localIndex), before = snapshot(arena.container), cues = [];
    const event = Object.freeze({ winner, loser: 1 - winner, weapon: 'trident', text: '<script>literal name</script> executes Rival.' });
    const playback = playFirstPersonExecutionAnimation(arena.container, event, { reducedMotion: false, onCue: cue => { cues.push(cue); throw new Error('No audio device'); } });
    await settle();
    assert.equal(arena.container.dataset.fpExecutionView, winner === localIndex ? 'victor' : 'defeated');
    assert.equal(arena.container.dataset.fpExecutionPhase, 'windup');
    assert.equal(arena.container.querySelector('.fp-execution-caption').textContent, event.text);
    assert.equal(arena.container.querySelector('.fp-execution-caption').getAttribute('role'), 'status');
    assert.equal(arena.container.querySelector('.first-person-arena'), arena.svg);
    assert.equal(arena.container.querySelector('.fp-weapon'), arena.weapon);
    await clock.step();
    assert.equal(arena.container.dataset.fpExecutionPhase, 'strike');
    assert.equal(cues.length, 0);
    await clock.step();
    assert.equal(arena.container.dataset.fpExecutionPhase, 'impact');
    assert.deepEqual(cues, [{ type: 'execution', weapon: 'trident' }]);
    await clock.finish();
    assert.equal(await playback, true);
    assert.equal(clock.elapsed, 1950);
    assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('reduced execution has a single stationary contact and abort/navigation restore the mounted source', async () => {
  for (const mode of ['complete', 'abort', 'detach']) await controlled(async clock => {
    const arena = fixture(1), controller = new AbortController();
    arena.local.dataset.defeated = 'true';
    arena.opponent.dataset.riposting = 'true';
    const before = snapshot(arena.container);
    const playback = playFirstPersonExecutionAnimation(arena.container, { winner: 0, loser: 1, weapon: 'sword', text: 'Confirmed verdict.' }, { reducedMotion: true, signal: controller.signal });
    await settle();
    assert.equal(arena.container.dataset.fpExecutionPhase, 'impact');
    assert.equal(arena.container.classList.contains('fp-execution-reduced'), true);
    if (mode === 'abort') controller.abort();
    else {
      if (mode === 'detach') arena.container.rootConnected = false;
      await clock.step();
    }
    assert.equal(await playback, mode === 'complete');
    assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('invalid actors, absent first-person rig and already-aborted requests leave presentation untouched', async () => {
  const event = { winner: 0, loser: 1, weapon: 'sword', text: 'Confirmed verdict.' };
  for (const invalid of [null, {}, { ...event, winner: 2 }, { ...event, loser: 0 }, { ...event, weapon: 'unknown' }]) {
    const arena = fixture(), before = snapshot(arena.container);
    assert.equal(await playFirstPersonExecutionAnimation(arena.container, invalid), false);
    assert.deepEqual(snapshot(arena.container), before);
  }
  for (const selector of ['.fp-viewmodel', '.fp-opponent', '.fp-camera', '.fp-mainhand-motion', '.fighter-motion']) {
    const arena = fixture();
    arena.container.querySelector(selector).remove();
    const before = snapshot(arena.container);
    assert.equal(await playFirstPersonExecutionAnimation(arena.container, event), false);
    assert.deepEqual(snapshot(arena.container), before);
  }
  const arena = fixture(), before = snapshot(arena.container), controller = new AbortController();
  controller.abort();
  assert.equal(await playFirstPersonBattleAnimation(arena.container, [], { signal: controller.signal }), false);
  assert.equal(await playFirstPersonExecutionAnimation(arena.container, event, { signal: controller.signal }), false);
  assert.deepEqual(snapshot(arena.container), before);
});
