import test from 'node:test';
import assert from 'node:assert/strict';
import { createPixelBloodEffect, pixelBloodParticles, pixelBloodProfile } from '../src/pixel-blood.js';

test('blood follows positive resolved damage, growing up to a bounded particle count', () => {
  assert.equal(pixelBloodProfile({ damage: 1 }).count, 7);
  assert.equal(pixelBloodProfile({ damage: 5 }).count, 19);
  assert.equal(pixelBloodProfile({ damage: 12 }).count, 40);
  let previous = 0;
  for (let damage = 1; damage <= 100; damage++) {
    const profile = pixelBloodProfile({ damage });
    assert.ok(profile.count >= previous);
    assert.ok(profile.count <= 72);
    previous = profile.count;
  }
  assert.equal(pixelBloodProfile({ damage: Number.MAX_VALUE }).count, 72);
  assert.equal(pixelBloodProfile({ damage: Number.MAX_VALUE }).spread, 38);
});

test('zero damage, misses and invalid public values do not create attack blood', () => {
  for (const damage of [undefined, null, 0, -1, -Infinity, Infinity, NaN, '12', {}, true]) {
    assert.equal(pixelBloodProfile({ damage }), null);
    assert.deepEqual(pixelBloodParticles({ damage }), []);
    assert.equal(createPixelBloodEffect(null, { damage }), null);
  }
});

test('execution uses a larger bounded burst without depending on a made-up damage value', () => {
  const execution = pixelBloodProfile({ execution: true });
  const largestAttack = pixelBloodProfile({ damage: Number.MAX_VALUE });
  assert.equal(execution.count, 96);
  assert.equal(execution.damage, 0);
  assert.ok(execution.count > largestAttack.count);
  assert.ok(execution.spread > largestAttack.spread);
  assert.equal(pixelBloodParticles({ execution: true }).length, 96);
});

test('public-event seeds repeat exact pixel trajectories without shared random state', () => {
  const options = { damage: 13, seed: 'round:8:target:1' };
  const before = structuredClone(options);
  const expected = pixelBloodParticles(options);
  pixelBloodParticles({ damage: 4, seed: 'unrelated' });
  assert.deepEqual(pixelBloodParticles(options), expected);
  assert.notDeepEqual(pixelBloodParticles({ ...options, seed: 'round:8:target:0' }), expected);
  assert.deepEqual(options, before);
  assert.ok(Object.isFrozen(expected));
  assert.ok(expected.every(Object.isFrozen));
});

test('fighter and screen bursts retain square integer clusters and bounded travel', () => {
  for (const execution of [false, true]) {
    for (const view of ['fighter', 'screen']) {
      const options = { damage: 12, execution, view, seed: 991 };
      const profile = pixelBloodProfile(options);
      for (const particle of pixelBloodParticles(options)) {
        for (const name of ['x', 'y', 'size', 'midX', 'midY', 'endX', 'endY', 'finalX', 'finalY']) {
          assert.ok(Number.isInteger(particle[name]), `${name} remains a native grid coordinate`);
          assert.equal(Math.abs(particle[name] % profile.scale), 0);
        }
        assert.ok(particle.size > 0 && particle.size <= 3 * profile.scale);
        assert.ok(Math.abs(particle.finalX) <= profile.spread);
        assert.ok(Math.abs(particle.finalY) <= 1.35 * profile.spread);
      }
    }
  }
});

test('reduced motion shows a static, compact burst with the same damage intensity', () => {
  const options = { damage: 15, seed: 84, view: 'screen' };
  const moving = pixelBloodParticles(options);
  const still = pixelBloodParticles({ ...options, reducedMotion: true });
  const profile = pixelBloodProfile(options);
  assert.equal(still.length, moving.length);
  assert.ok(still.every((particle, index) => Math.abs(particle.x - (index % 2 === 0 ? -240 : 240)) <= profile.spread * .55 + profile.scale));
  assert.ok(still.every(particle => Math.abs(particle.y + 12) <= profile.spread * .55 + profile.scale));
  assert.notDeepEqual(still, moving);
});

test('incoming screen blood forms two foreground side clusters within the native viewport', () => {
  for (const execution of [false, true]) {
    for (const reducedMotion of [false, true]) {
      for (let seed = 0; seed < 20; seed++) {
        const options = { damage: Number.MAX_VALUE, execution, reducedMotion, seed, view: 'screen' };
        const particles = pixelBloodParticles(options);
        assert.ok(particles.filter(particle => particle.x < 0).length > 0);
        assert.ok(particles.filter(particle => particle.x > 0).length > 0);
        for (const [index, particle] of particles.entries()) {
          const clusterX = index % 2 === 0 ? -240 : 240;
          assert.ok(Math.abs(particle.x - clusterX) <= (reducedMotion ? 93 : 12));
          const milestones = reducedMotion ? [[0, 0]] : [[0, 0], [particle.midX, particle.midY], [particle.endX, particle.endY], [particle.finalX, particle.finalY]];
          for (const [dx, dy] of milestones) {
            const x = 460 + particle.x + dx;
            const y = 270 + particle.y + dy;
            assert.ok(x >= 0 && x + particle.size <= 920, `screen square x bounds at seed ${seed}`);
            assert.ok(y >= 0 && y + particle.size <= 440, `screen square y bounds at seed ${seed}`);
          }
        }
      }
    }
  }
});

test('foreground placement does not change fighter-space trajectories or wound registration', () => {
  const options = { damage: 12, seed: 991 };
  const particles = pixelBloodParticles(options);
  assert.deepEqual(pixelBloodParticles({ ...options, view: 'fighter' }), particles);
  assert.ok(particles.every(particle => Math.abs(particle.x) <= 4 && particle.y >= -6 && particle.y <= 1));
});

class SvgElement {
  constructor(namespace, tagName) {
    this.namespace = namespace;
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  append(node) { this.children.push(node); }
}
const document = { createElementNS: (namespace, tagName) => new SvgElement(namespace, tagName) };

test('SVG effect is inert, origin-centered square geometry with inspectable intensity', () => {
  const effect = createPixelBloodEffect(document, { damage: 7, seed: 17 });
  assert.equal(effect.namespace, 'http://www.w3.org/2000/svg');
  assert.equal(effect.tagName, 'g');
  assert.equal(effect.getAttribute('aria-hidden'), 'true');
  assert.equal(effect.getAttribute('shape-rendering'), 'crispEdges');
  assert.equal(effect.getAttribute('data-blood-damage'), '7');
  assert.equal(effect.getAttribute('data-blood-particles'), '25');
  assert.equal(effect.getAttribute('data-blood-execution'), 'false');
  assert.equal(effect.getAttribute('transform'), undefined, 'the existing scene owns placement');
  assert.equal(effect.children.length, 25);
  for (const square of effect.children) {
    assert.equal(square.tagName, 'rect');
    assert.equal(square.getAttribute('width'), square.getAttribute('height'));
    assert.match(square.getAttribute('fill'), /^#[0-9a-f]{6}$/);
    assert.match(square.getAttribute('style'), /--blood-final-y:-?\d+px/);
  }
});

test('reduced-motion execution records its bounded static mode without requiring DOM style helpers', () => {
  const effect = createPixelBloodEffect(document, { execution: true, reducedMotion: true, view: 'screen' });
  assert.equal(effect.getAttribute('data-blood-execution'), 'true');
  assert.equal(effect.getAttribute('data-reduced-motion'), 'true');
  assert.equal(effect.getAttribute('data-blood-view'), 'screen');
  assert.equal(effect.children.length, 96);
  assert.equal(effect.getAttribute('style'), '--blood-duration:760ms');
});

test('browser trajectories use CSSOM assignments compatible with the strict style policy', () => {
  const styledDocument = { createElementNS: (namespace, tag) => {
    const node = new SvgElement(namespace, tag);
    node.properties = new Map();
    node.style = { setProperty: (name, value) => node.properties.set(name, value) };
    const setAttribute = node.setAttribute.bind(node);
    node.setAttribute = (name, value) => {
      assert.notEqual(name, 'style', 'The browser blocks inline style attributes under style-src self.');
      setAttribute(name, value);
    };
    return node;
  } };
  const effect = createPixelBloodEffect(styledDocument, { execution: true, seed: 11 });
  assert.equal(effect.properties.get('--blood-duration'), '760ms');
  for (const square of effect.children) {
    assert.equal(square.properties.size, 6);
    assert.match(square.properties.get('--blood-end-x'), /^-?\d+px$/);
  }
});
