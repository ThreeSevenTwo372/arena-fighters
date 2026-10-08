import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, forfeitDuel, WEAPONS } from '../src/combat.js';
import { buildExecutionEvent, playExecutionAnimation } from '../src/execution-animation.js';

const character = name => ({
  name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b45143', appearance: { sex: 'male', facePreset: 'p05' },
});
const duelFor = (winner = 0, weapon = 'sword') => forfeitDuel(createDuel([
  { character: character('Cassian'), weapon: winner === 0 ? weapon : 'sword', armor: 'medium' },
  { character: character('Mira'), weapon: winner === 1 ? weapon : 'sword', armor: 'medium' },
]), 1 - winner);
const verdictFor = winner => ({ decision: 'execute', winner, loser: 1 - winner });

test('execution events follow the confirmed verdict for either fighter and every equipped weapon', () => {
  for (const winner of [0, 1]) {
    for (const weapon of Object.keys(WEAPONS)) {
      const duel = duelFor(winner, weapon);
      const decision = verdictFor(winner);
      const beforeDuel = structuredClone(duel), beforeDecision = structuredClone(decision);
      const event = buildExecutionEvent(duel, decision);
      assert.deepEqual(event, {
        winner, loser: 1 - winner, weapon,
        text: `${duel.fighters[winner].character.name} executes ${duel.fighters[1 - winner].character.name}.`,
      });
      assert.equal(Object.isFrozen(event), true);
      assert.deepEqual(duel, beforeDuel);
      assert.deepEqual(decision, beforeDecision);
      assert.equal(duel.fighters[winner].character.appearance.facePreset, 'p05');
    }
  }
});

test('spared rivals, draws, unfinished fights and forged actor indices never produce an execution', () => {
  const duel = duelFor();
  for (const decision of [null, undefined, {}, 'execute',
    { ...verdictFor(0), decision: 'spare' }, { ...verdictFor(0), decision: 'anything' },
    verdictFor(1), { decision: 'execute', winner: 0, loser: 0 },
    { decision: 'execute', winner: 0, loser: 2 }, { decision: 'execute', winner: '0', loser: 1 },
    { decision: 'execute', winner: 0, loser: '1' },
  ]) assert.equal(buildExecutionEvent(duel, decision), null);
  for (const invalid of [null, undefined, {}, { ...duel, status: 'active' },
    { ...duel, fighters: [duel.fighters[0]] }, { ...duel, fighters: [] },
    { ...duel, result: null }, { ...duel, result: { winner: null, reason: 'draw' } },
    { ...duel, result: { winner: 2 } }, { ...duel, result: { winner: '0' } },
  ]) assert.equal(buildExecutionEvent(invalid, verdictFor(0)), null);
});

test('a missing weapon has a stable sword animation without changing the saved loadout', () => {
  const duel = structuredClone(duelFor());
  duel.fighters[0].weapon = 'unknown';
  assert.equal(buildExecutionEvent(duel, verdictFor(0)).weapon, 'sword');
  assert.equal(duel.fighters[0].weapon, 'unknown');
});

test('execution captions retain literal player names as event data', () => {
  const duel = structuredClone(duelFor());
  duel.fighters[0].character.name = '<script>champion</script>';
  duel.fighters[1].character.name = 'A & B';
  assert.equal(buildExecutionEvent(duel, verdictFor(0)).text, '<script>champion</script> executes A & B.');
});

// This small SVG fixture preserves tree order and registered source attributes.
// It deliberately has no layout or CSS engine; browser review verifies the art.
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

const snapshot = node => ({
  tag: node.tagName, attributes: [...node.attributeMap], text: node.textContent,
  style: [...node.style.properties], children: node.childNodes.map(snapshot),
});
const settle = async () => { for (let count = 0; count < 12; count += 1) await Promise.resolve(); };

async function controlledPlayback(run) {
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let nextId = 0, elapsed = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { callback, delay: Number(delay) });
    return id;
  };
  globalThis.clearTimeout = id => timers.delete(id);
  const clock = {
    get pending() { return timers.size; },
    get elapsed() { return elapsed; },
    async step() {
      await settle();
      const [id, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, 'Playback should be waiting for a phase timer');
      timers.delete(id);
      elapsed += timer.delay;
      timer.callback();
      await settle();
    },
    async finish() {
      for (let count = 0; count < 20; count += 1) {
        await settle();
        if (!timers.size) return;
        await this.step();
      }
      assert.fail('Execution playback failed to make bounded progress');
    },
  };
  try { await run(clock); }
  finally { globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear; }
}

test('execution stages use either facing, expose the defeated fighter, and restore all registered art', async () => {
  for (const winner of [0, 1]) {
    await controlledPlayback(async clock => {
      const arena = arenaFixture({ loser: 1 - winner });
      const before = snapshot(arena.container);
      const bodies = arena.fighters.map(fighter => fighter.querySelector('.fighter-body'));
      const bodyBefore = bodies.map(snapshot);
      const sourceMotions = arena.fighters.map(fighter => fighter.querySelector('.fighter-motion'));
      const motionParents = sourceMotions.map(motion => motion.parentNode);
      const event = buildExecutionEvent(duelFor(winner, 'greatsword'), verdictFor(winner));
      const playback = playExecutionAnimation(arena.container, event, { reducedMotion: false });
      await settle();
      assert.equal(arena.container.getAttribute('data-execution-phase'), 'windup');
      assert.equal(arena.container.querySelector('.execution-caption').textContent, event.text);
      assert.equal(arena.fighters[1 - winner].hasAttribute('data-defeated'), false,
        'A knockout figure must become visible for the finisher before it falls again');
      assert.equal(arena.fighters[1 - winner].querySelector('.gladiator').classList.contains('defeated'), false);
      assert.equal(arena.container.querySelectorAll('.execution-motion').length, 2);
      assert.equal(sourceMotions[winner].parentNode.style.properties.get('--execution-approach'), '146px',
        'Approach comes from the arena registration and native scale for either facing');
      assert.deepEqual(bodies.map(snapshot), bodyBefore, 'Execution cannot rewrite identity pixels, sizes or frame origins');
      await clock.step();
      assert.equal(arena.container.getAttribute('data-execution-phase'), 'strike');
      assert.equal(arena.container.querySelector('.execution-blood'), null, 'Blood appears at contact, after windup and swing');
      await clock.step();
      assert.equal(arena.container.getAttribute('data-execution-phase'), 'impact');
      const blood = arena.container.querySelector('.execution-blood');
      assert.equal(blood.parentNode, arena.fighters[1 - winner].querySelector('.gladiator'),
        'Blood uses the defeated figure’s local coordinates, including its arena facing');
      assert.equal(arena.fighters[winner].querySelector('.execution-blood'), null);
      assert.equal(blood.getAttribute('shape-rendering'), 'crispEdges');
      for (const rect of blood.querySelectorAll('rect')) {
        for (const name of ['x', 'y', 'width', 'height']) assert.equal(Number.isInteger(Number(rect.getAttribute(name))), true);
      }
      assert.equal(arena.fighters[1 - winner].querySelector('.fighter-effects').getAttribute('transform'), 'translate(0 -74)');
      await clock.step();
      assert.equal(arena.container.getAttribute('data-execution-phase'), 'settle');
      await clock.finish();
      assert.equal(await playback, true);
      assert.equal(clock.elapsed, 2550);
      assert.equal(clock.pending, 0);
      assert.deepEqual(snapshot(arena.container), before);
      sourceMotions.forEach((motion, index) => assert.equal(motion.parentNode, motionParents[index]));
    });
  }
});

test('reduced motion gives a brief stationary impact with no windup or strike phases', async () => {
  await controlledPlayback(async clock => {
    const arena = arenaFixture();
    const before = snapshot(arena.container);
    const event = buildExecutionEvent(duelFor(), verdictFor(0));
    const playback = playExecutionAnimation(arena.container, event, { reducedMotion: true });
    await settle();
    assert.equal(arena.container.classList.contains('execution-playback-reduced'), true);
    assert.equal(arena.container.getAttribute('data-execution-phase'), 'impact');
    assert.ok(arena.fighters[1].querySelector('.execution-blood'));
    assert.equal(clock.pending, 1);
    await clock.step();
    assert.equal(await playback, true);
    assert.equal(clock.elapsed, 650);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('navigation abort at contact cancels the timer and restores the prior defeat and source tree', async () => {
  await controlledPlayback(async clock => {
    const arena = arenaFixture();
    const before = snapshot(arena.container);
    const controller = new AbortController();
    const playback = playExecutionAnimation(arena.container,
      buildExecutionEvent(duelFor(), verdictFor(0)), { signal: controller.signal, reducedMotion: false });
    await clock.step();
    await clock.step();
    assert.ok(arena.container.querySelector('.execution-blood'));
    controller.abort();
    await settle();
    assert.equal(await playback, false);
    assert.equal(clock.pending, 0, 'Aborted playback must leave no delayed work');
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('a removed arena cancels at the next phase boundary and still cleans its detached tree', async () => {
  await controlledPlayback(async clock => {
    const arena = arenaFixture({ loser: 0 });
    const before = snapshot(arena.container);
    const playback = playExecutionAnimation(arena.container,
      buildExecutionEvent(duelFor(1), verdictFor(1)), { reducedMotion: false });
    arena.container.rootConnected = false;
    await clock.step();
    assert.equal(await playback, false);
    assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('unplayable events, missing rig parts and already-aborted calls leave the arena untouched', async () => {
  await controlledPlayback(async clock => {
    const event = buildExecutionEvent(duelFor(), verdictFor(0));
    for (const invalid of [null, {}, { ...event, winner: 2 }, { ...event, loser: 0 }, { ...event, weapon: 'unknown' }]) {
      const arena = arenaFixture(), before = snapshot(arena.container);
      assert.equal(await playExecutionAnimation(arena.container, invalid), false);
      assert.deepEqual(snapshot(arena.container), before);
    }
    for (const selector of ['.arena-svg', '.arena-fighter[data-fighter-index="1"]', '.gladiator', '.fighter-motion']) {
      const arena = arenaFixture();
      arena.container.querySelector(selector).remove();
      const before = snapshot(arena.container);
      assert.equal(await playExecutionAnimation(arena.container, event), false, selector);
      assert.deepEqual(snapshot(arena.container), before);
    }
    const arena = arenaFixture(), before = snapshot(arena.container), controller = new AbortController();
    controller.abort();
    assert.equal(await playExecutionAnimation(arena.container, event, { signal: controller.signal }), false);
    assert.equal(await playExecutionAnimation(null, event), false);
    assert.deepEqual(snapshot(arena.container), before);
    assert.equal(clock.pending, 0);
  });
});

test('blood construction failure restores the registered body and pre-existing animation attributes', async () => {
  await controlledPlayback(async clock => {
    const arena = arenaFixture();
    arena.fighters[0].setAttribute('data-animation', 'recover');
    arena.fighters[0].setAttribute('data-guarding', 'true');
    arena.fighters[1].setAttribute('data-combat-action', 'technique');
    const before = snapshot(arena.container);
    const create = arena.doc.createElementNS;
    arena.doc.createElementNS = (namespace, tag) => {
      if (tag === 'rect') throw new Error('Synthetic SVG allocation failure');
      return create(namespace, tag);
    };
    const outcome = playExecutionAnimation(arena.container,
      buildExecutionEvent(duelFor(), verdictFor(0)), { reducedMotion: false }).then(
      value => ({ value }), error => ({ error }),
    );
    await clock.finish();
    const result = await outcome;
    assert.match(result.error?.message ?? '', /Synthetic SVG allocation failure/);
    assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('partial wrapper construction failure does not strand the original motion group', async () => {
  await controlledPlayback(async clock => {
    const arena = arenaFixture(), before = snapshot(arena.container);
    const create = arena.doc.createElementNS;
    let wrappers = 0;
    arena.doc.createElementNS = (namespace, tag) => {
      const node = create(namespace, tag);
      if (tag === 'g' && ++wrappers === 2) node.append = () => { throw new Error('Synthetic wrap failure'); };
      return node;
    };
    await assert.rejects(playExecutionAnimation(arena.container,
      buildExecutionEvent(duelFor(), verdictFor(0)), { reducedMotion: false }), /Synthetic wrap failure/);
    assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before);
  });
});
