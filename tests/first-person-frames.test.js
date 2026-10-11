import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { decodeAvatarPng, avatarChoices, normalizeAppearance } from '../src/avatar.js';
import { FIRST_PERSON_FRAME_CATALOG as catalog } from '../src/first-person-frame-catalog.js';
import { FIRST_PERSON_AXIS_CATALOG as axisCatalog } from '../src/first-person-axis-catalog.js';
import { FIRST_PERSON_BLADE_CATALOG as bladeCatalog } from '../src/first-person-blade-catalog.js';
import { FIRST_PERSON_ARMOR_FRAME_CATALOG as armorCatalog } from '../src/first-person-armor-frame-catalog.js';
import { getFirstPersonFrameClip, firstPersonFrameAt, preloadFirstPersonFrames,
  preparedFirstPersonFrameClip, applyFirstPersonFrame } from '../src/first-person-frames.js';
import { renderFirstPersonArena } from '../src/first-person-arena.js';
import { createFirstPersonSample } from '../src/first-person-preview.js';
import { playFirstPersonBattleAnimation } from '../src/first-person-animation.js';
import { resolveRound } from '../src/combat.js';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import { buildAnimationSteps } from '../src/battle-animation.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { createFightTutorial, renderFightTutorial } from '../src/fight-tutorial.js';
import { renderArmory } from '../src/armory.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';
import { audioBindings } from './fixtures/audio-stub.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const selection = (skin = 'ivory') => ({ weapon: 'sword', armor: 'medium', skin });
const poses = ['windup', 'contact', 'follow', 'recovery'];
const skins = ['porcelain', 'ivory', 'sand', 'copper', 'umber', 'ebony'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = url => fs.readFile(path.join(project, url.replace(/^\//, '')));
const decoded = async url => decodeAvatarPng(new Uint8Array(await bytes(url)));

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
      contains: name => this.classes.includes(name),
      add: (...names) => this.setAttribute('class', [...new Set([...this.classes, ...names])].join(' ')),
      remove: (...names) => this.setAttribute('class', this.classes.filter(name => !names.includes(name)).join(' ')),
    };
  }
  get classes() { return (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean); }
  get className() { return this.getAttribute('class') ?? ''; }
  set className(value) { this.setAttribute('class', value); }
  get isConnected() { return this.parentNode ? this.parentNode.isConnected : !!this.rootConnected; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.remove(); this.childNodes.push(node); node.parentNode = this; } }
  remove() { if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; }
  matches(selector) {
    const tag = selector.match(/^[\w-]+/)?.[0];
    if (tag && tag.toLowerCase() !== this.tagName.toLowerCase()) return false;
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

function fixture(viewerIndex = 0, skin = 'ivory', equipment = {}, artVersion) {
  const document = { createElement: tag => new Element(tag, document), createElementNS: (_, tag) => new Element(tag, document) };
  const container = document.createElement('div');
  container.setAttribute('class', 'arena-stage first-person-stage original'); container.rootConnected = true;
  const stack = [container], duel = createFirstPersonSample({ ...selection(skin), ...equipment });
  // Use the actual renderer so its full saved rival art, source holds and frame
  // registration participate in every restoration test.
  for (const match of renderFirstPersonArena(duel, { viewerIndex, artVersion }).matchAll(/<(\/?)([\w:-]+)\b([^>]*?)(\/?)>/g)) {
    if (match[1]) { stack.pop(); continue; }
    const node = document.createElement(match[2]);
    for (const [, name, value] of match[3].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(name, value);
    stack.at(-1).append(node); if (!match[4]) stack.push(node);
  }
  return { document, container, duel, local: container.querySelector('.fp-viewmodel'),
    rival: container.querySelector('.fp-opponent'), image: container.querySelector('.fp-authored-frame') };
}

const snapshot = node => ({ tag: node.tagName, attrs: [...node.attributes].sort(), text: node.textContent, children: node.childNodes.map(snapshot) });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const attack = (actor, action = 'strike') => ({ type: 'attack', actor, target: 1 - actor, weapon: 'sword', action,
  damage: 5, guarded: false, bypassedGuard: false, targetHp: 15, text: 'Resolved public strike.' });

async function controlled(run) {
  const original = { timeout: globalThis.setTimeout, clear: globalThis.clearTimeout, document: globalThis.document };
  const timers = new Map(), durations = []; let id = 0, elapsed = 0, maxPending = 0;
  globalThis.setTimeout = (callback, milliseconds) => {
    timers.set(++id, { callback, milliseconds }); maxPending = Math.max(maxPending, timers.size); return id;
  };
  globalThis.clearTimeout = key => timers.delete(key);
  const clock = { get elapsed() { return elapsed; }, get pending() { return timers.size; }, get maxPending() { return maxPending; }, durations,
    async step() { await settle(); const [key, timer] = timers.entries().next().value ?? [];
      assert.ok(timer); timers.delete(key); elapsed += timer.milliseconds; durations.push(timer.milliseconds); timer.callback(); await settle(); },
    async finish() { for (let i = 0; i < 64; i++) { await settle(); if (!timers.size) return; await this.step(); } assert.fail('Playback did not finish.'); } };
  try { await run(clock); }
  finally { globalThis.setTimeout = original.timeout; globalThis.clearTimeout = original.clear; globalThis.document = original.document; }
}

async function withImages(run, failUrl = null) {
  const original = globalThis.Image, loads = [], decodes = [];
  globalThis.Image = class {
    set src(url) { this.url = url; loads.push(url); queueMicrotask(() => url === failUrl ? this.onerror?.() : this.onload?.()); }
    decode() { decodes.push(this.url); return Promise.resolve(); }
  };
  try { return await run({ loads, decodes }); } finally { globalThis.Image = original; }
}

async function assertAuthoredFrames(weapon, armor, clip) {
  assert.equal(clip.fullFrame, true); assert.equal(clip.durationMs, 665); assert.equal(clip.contactMs, 285);
  assert.deepEqual(clip.frames.map(frame => frame.pose).sort(), [...poses].sort());
  const alphaHashes = new Set(), colorHashes = new Set();
  for (const frame of clip.frames) {
    assert.deepEqual([frame.width, frame.height], [460, 220]);
    assert.deepEqual(Object.keys(frame.variants).sort(), [...skins].sort());
    const original = await decoded(frame.variants.ivory), maskBytes = await bytes(frame.maskUrl);
    assert.equal(hash(maskBytes), frame.maskSha256);
    const mask = await decodeAvatarPng(new Uint8Array(maskBytes));
    assert.deepEqual([mask.width, mask.height], [460, 220]);
    const alpha = new Uint8Array(460 * 220);
    for (let i = 0; i < alpha.length; i++) alpha[i] = original.pixels[i * 4 + 3];
    alphaHashes.add(hash(alpha)); colorHashes.add(hash(original.pixels));
    let owned = 0;
    for (let i = 0; i < alpha.length; i++) {
      const at = i * 4, owner = mask.pixels[at];
      assert.ok(owner === 0 || owner === 255); assert.equal(mask.pixels[at + 1], owner);
      assert.equal(mask.pixels[at + 2], owner); assert.equal(mask.pixels[at + 3], 255);
      if (owner) { owned++; assert.ok(alpha[i], 'A hand material mask owns only opaque source art.'); }
    }
    assert.ok(owned > 0, 'Every complete pose carries explicit hand material ownership.');
    for (const skin of skins) {
      const source = await bytes(frame.variants[skin]);
      assert.equal(hash(source), frame.sha256s[skin]);
      const image = await decodeAvatarPng(new Uint8Array(source));
      assert.deepEqual([image.width, image.height], [460, 220]);
      let recolored = 0;
      for (let i = 0; i < alpha.length; i++) {
        const at = i * 4; assert.equal(image.pixels[at + 3], alpha[i], 'Palette choices cannot move arms or equipment.');
        const different = image.pixels[at] !== original.pixels[at] || image.pixels[at + 1] !== original.pixels[at + 1] || image.pixels[at + 2] !== original.pixels[at + 2];
        if (different) { recolored++; assert.equal(mask.pixels[at], 255, 'Armor, blade, shield and outline colors remain outside hand-only recoloring.'); }
      }
      if (skin !== 'ivory') assert.ok(recolored > 0);
    }
  }
  assert.equal(alphaHashes.size, 4, `${weapon}/${armor} poses have distinct silhouettes rather than palette-only duplicates.`);
  assert.equal(colorHashes.size, 4);
}

test('four authored full frames are distinct, sealed native poses with identical skin-variant geometry and hand-only color changes', async () => {
  assert.deepEqual(Object.keys(catalog.clips).sort(), [...Object.keys(combat.WEAPONS), 'trident-netcast'].sort(),
    'All nine playable weapons and the separate Entangle cast are admitted.');
  assert.equal(Object.values(catalog.clips).reduce((count, armors) => count + Object.keys(armors).length, 0), 30);
  for (const armors of Object.values(catalog.clips)) assert.deepEqual(Object.keys(armors).sort(), Object.keys(combat.ARMORS).sort(),
    'Each weapon and Entangle cast retains all three armor materials.');
  for (const [weapon, armors] of Object.entries(catalog.clips)) for (const [armor, clip] of Object.entries(armors)) {
    await assertAuthoredFrames(weapon, armor, clip);
  }
});

test('additive greatsword correction changes only the three windup blades and crossguards while preserving every other v005 frame and protected pixel', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(project, 'assets/first-person/v007/manifest.json'), 'utf8'));
  assert.deepEqual(axisCatalog, manifest);
  assert.deepEqual(bladeCatalog, JSON.parse(await fs.readFile(path.join(project, 'assets/first-person/v006/manifest.json'), 'utf8')));
  for (const armors of Object.values(bladeCatalog.overrides)) for (const overrides of Object.values(armors)) for (const frame of Object.values(overrides)) {
    for (const [skin, url] of Object.entries(frame.variants)) assert.equal(hash(await bytes(url)), frame.sha256s[skin], 'The rejected blade-only candidate remains preserved.');
  }
  assert.deepEqual(catalog, JSON.parse(await fs.readFile(path.join(project, 'assets/first-person/v005/manifest.json'), 'utf8')));
  assert.equal(axisCatalog.schema, 1); assert.equal(axisCatalog.version, 'v007'); assert.equal(axisCatalog.baseVersion, 'v005');
  assert.deepEqual(Object.keys(axisCatalog.overrides), ['greatsword']);
  assert.deepEqual(Object.keys(axisCatalog.overrides.greatsword).sort(), ['heavy', 'light', 'medium']);
  const admittedFiles = ['manifest.json'];
  for (const [armor, overrides] of Object.entries(axisCatalog.overrides.greatsword)) {
    assert.deepEqual(Object.keys(overrides), ['windup']);
    const frame = overrides.windup, originalFrame = catalog.clips.greatsword[armor].frames.find(frame => frame.pose === 'windup');
    assert.equal(frame.pose, 'windup'); assert.deepEqual([frame.width, frame.height], [460, 220]);
    const axis = frame.axis;
    for (const name of ['pommel', 'handle', 'guardBladeIntersection', 'bladeExit', 'guardLeft', 'guardRight']) {
      assert.equal(axis?.[name]?.length, 2); assert.ok(axis[name].every(Number.isFinite), 'Audited sword landmarks retain finite native coordinates.');
    }
    const vector = (from, to) => to.map((value, index) => value - from[index]);
    const grip = vector(axis.pommel, axis.handle), blade = vector(axis.guardBladeIntersection, axis.bladeExit);
    const guard = vector(axis.guardLeft, axis.guardRight), length = vector => Math.hypot(...vector);
    const cross = (a, b) => a[0] * b[1] - a[1] * b[0], dot = (a, b) => a[0] * b[0] + a[1] * b[1];
    assert.ok(length(grip) > 50 && length(blade) > 50 && length(guard) > 40);
    assert.ok(Math.abs(cross(grip, blade)) / (length(grip) * length(blade)) < Math.sin(2 * Math.PI / 180),
      'The authored blade and preserved grip follow the same rigid axis.');
    assert.ok(Math.abs(cross(grip, vector(axis.pommel, axis.guardBladeIntersection))) / length(grip) <= 1,
      'The blade intersects the guard on the preserved grip axis within one native pixel.');
    assert.ok(Math.abs(dot(blade, guard)) / (length(blade) * length(guard)) < Math.sin(2 * Math.PI / 180),
      'The authored crossguard is perpendicular to the blade within native raster tolerance.');
    assert.equal(frame.maskUrl, originalFrame.maskUrl, 'Original hand ownership remains registered.');
    assert.deepEqual(Object.keys(frame.variants).sort(), [...skins].sort());
    assert.equal(frame.correctionMaskUrl, `/assets/first-person/v007/greatsword-${armor}-windup-correction-mask.png`);
    admittedFiles.push(path.basename(frame.correctionMaskUrl));
    const correction = await decoded(frame.correctionMaskUrl), hands = await decoded(originalFrame.maskUrl);
    const reference = await decoded(frame.variants.ivory);
    assert.deepEqual([correction.width, correction.height], [460, 220]);
    let changedPixels;
    let variantAlpha;
    for (const skin of skins) {
      assert.equal(frame.variants[skin], `/assets/first-person/v007/greatsword-${armor}-windup-${skin}.png`);
      admittedFiles.push(path.basename(frame.variants[skin]));
      const imageBytes = await bytes(frame.variants[skin]); assert.equal(hash(imageBytes), frame.sha256s[skin]);
      const image = await decodeAvatarPng(new Uint8Array(imageBytes)), original = await decoded(originalFrame.variants[skin]);
      assert.deepEqual([image.width, image.height], [460, 220]);
      const changed = [], alpha = [];
      for (let i = 0; i < 460 * 220; i++) {
        const at = i * 4, owner = correction.pixels[at];
        assert.ok(owner === 0 || owner === 255); assert.equal(correction.pixels[at + 1], owner);
        assert.equal(correction.pixels[at + 2], owner); assert.equal(correction.pixels[at + 3], 255);
        if (owner) assert.equal(hands.pixels[at], 0, 'The blade-and-crossguard edit cannot own either authored hand.');
        const different = image.pixels.subarray(at, at + 4).some((value, channel) => value !== original.pixels[at + channel]);
        if (different) { changed.push(i); assert.equal(owner, 255, 'Every changed cell lies inside the audited blade-and-crossguard mask.'); }
        if (!hands.pixels[at]) for (let channel = 0; channel < 4; channel++) {
          assert.equal(image.pixels[at + channel], reference.pixels[at + channel], 'Armor and equipment remain exact across all six hand palettes.');
        }
        alpha.push(image.pixels[at + 3]);
      }
      assert.ok(changed.length > 0, 'The admitted frame contains an actual blade correction.');
      if (changedPixels) assert.deepEqual(changed, changedPixels, 'The weapon repair has the same cell ownership for all six hand palettes.');
      else changedPixels = changed;
      if (variantAlpha) assert.deepEqual(alpha, variantAlpha, 'Skin palettes retain one complete pose geometry.');
      else variantAlpha = alpha;
    }
  }
  assert.deepEqual((await fs.readdir(path.join(project, 'assets/first-person/v007'))).sort(), admittedFiles.sort(),
    'Only eighteen corrected full-frame images, three correction masks and their manifest are admitted.');
  for (const [weapon, armors] of Object.entries(catalog.clips)) for (const armor of Object.keys(armors)) for (const skin of skins) {
    const selectedWeapon = weapon === 'trident-netcast' ? 'trident' : weapon;
    const before = getFirstPersonFrameClip({ weapon: selectedWeapon, armor, skin, artVersion: 'v005' });
    const current = getFirstPersonFrameClip({ weapon: selectedWeapon, armor, skin, artVersion: 'v007' });
    assert.ok(before); assert.ok(current); assert.equal(current.artVersion, 'v007'); assert.equal(before.artVersion, 'v005');
    for (const pose of poses) {
      const expected = weapon === 'greatsword' && pose === 'windup'
        ? axisCatalog.overrides.greatsword[armor].windup.variants[skin] : before.frames[pose];
      assert.equal(current.frames[pose], expected);
    }
    assert.deepEqual(current.techniqueFrames, before.techniqueFrames, 'Entangle casts remain exact.');
  }
});

test('corrected and explicit prior greatsword playback use their selected windup while retaining contact and cleanup in both seats', async () => {
  for (const artVersion of ['v005', 'v006', 'v007']) {
    const gear = { weapon: 'greatsword', armor: 'light', skin: 'ebony', artVersion };
    await withImages(async () => assert.ok(await preloadFirstPersonFrames(gear)));
    const clip = getFirstPersonFrameClip(gear);
    for (const viewerIndex of [0, 1]) await controlled(async clock => {
      const arena = fixture(viewerIndex, gear.skin, gear, artVersion), before = snapshot(arena.container);
      const frames = [], cues = []; globalThis.document = arena.document;
      assert.equal(arena.local.dataset.frameVersion, artVersion);
      const playback = playFirstPersonBattleAnimation(arena.container, [{ ...attack(viewerIndex), weapon: 'greatsword' }], {
        reducedMotion: false, onCue: cue => cues.push([clock.elapsed, cue.type]),
        onAttackFrame: frame => frames.push([frame.elapsedMs, arena.image.getAttribute('href')]),
      });
      await clock.finish(); assert.equal(await playback, true);
      assert.equal(frames.find(([time]) => time === 90)[1], clip.frames.windup);
      assert.equal(frames.find(([time]) => time === 285)[1], clip.frames.contact);
      assert.equal(clip.frames.contact, getFirstPersonFrameClip({ ...gear, artVersion: 'v005' }).frames.contact);
      assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]); assert.equal(clock.elapsed, 765); assert.equal(clock.maxPending, 1);
      assert.deepEqual(snapshot(arena.container), before);
    });
  }
});

test('an unavailable corrected windup keeps the entire anchored fallback without substituting the rejected v005 blade', async () => {
  const gear = { weapon: 'greatsword', armor: 'heavy', skin: 'copper' }, failure = getFirstPersonFrameClip(gear).frames.windup;
  await withImages(async () => {
    assert.equal(await preloadFirstPersonFrames(gear), null); assert.equal(preparedFirstPersonFrameClip(gear), null);
    await controlled(async clock => {
      const arena = fixture(0, gear.skin, gear), before = snapshot(arena.container); globalThis.document = arena.document;
      const playback = playFirstPersonBattleAnimation(arena.container, [{ ...attack(0), weapon: 'greatsword' }], { reducedMotion: false });
      await clock.step(); assert.equal(arena.local.dataset.framePose, undefined); assert.equal(arena.image.getAttribute('href'), null);
      await clock.finish(); assert.equal(await playback, true); assert.deepEqual(clock.durations, [285, 380, 100]);
      assert.deepEqual(snapshot(arena.container), before);
    });
  }, failure);
});

const garmentFrame = (weapon, armor, pose) => ({
  ...catalog.clips[weapon][armor].frames.find(frame => frame.pose === pose),
  variants: Object.fromEntries(skins.map(skin => [skin, `/assets/first-person/v008/${weapon}-${armor}-${pose}-${skin}.png`])),
});

test('explicit v008 garment frames inherit the repaired greatsword and route ordinary thrusts and Entangle through the same resolver', () => {
  const saved = armorCatalog.overrides;
  const preserved = structuredClone({ catalog, axisCatalog, bladeCatalog });
  try {
    armorCatalog.overrides = {
      trident: { medium: { windup: garmentFrame('trident', 'medium', 'windup') } },
      'trident-netcast': { medium: { contact: garmentFrame('trident-netcast', 'medium', 'contact') } },
      greatsword: { medium: { contact: garmentFrame('greatsword', 'medium', 'contact') } },
    };
    for (const skin of skins) {
      const before = getFirstPersonFrameClip({ weapon: 'greatsword', armor: 'medium', skin, artVersion: 'v007' });
      const garment = getFirstPersonFrameClip({ weapon: 'greatsword', armor: 'medium', skin, artVersion: 'v008' });
      assert.equal(garment.artVersion, 'v008');
      assert.equal(garment.frames.windup, before.frames.windup, 'Sparse armor overrides retain the rigid v007 blade and perpendicular crossguard.');
      assert.equal(garment.frames.contact, armorCatalog.overrides.greatsword.medium.contact.variants[skin]);
      for (const pose of ['follow', 'recovery']) assert.equal(garment.frames[pose], before.frames[pose]);
      const trident = getFirstPersonFrameClip({ weapon: 'trident', armor: 'medium', skin, artVersion: 'v008' });
      assert.equal(firstPersonFrameAt(trident, 90, 'strike').url, armorCatalog.overrides.trident.medium.windup.variants[skin]);
      assert.equal(firstPersonFrameAt(trident, 285, 'technique').url, armorCatalog.overrides['trident-netcast'].medium.contact.variants[skin]);
      assert.equal(firstPersonFrameAt(trident, 285, 'strike').url, getFirstPersonFrameClip({ weapon: 'trident', armor: 'medium', skin, artVersion: 'v007' }).frames.contact);
    }
    for (const weapon of Object.keys(combat.WEAPONS)) for (const armor of Object.keys(combat.ARMORS)) {
      assert.deepEqual(getFirstPersonFrameClip({ weapon, armor }), getFirstPersonFrameClip({ weapon, armor, artVersion: 'v008' }),
        'Default presentation consumes the selected complete garment overlay.');
      for (const version of ['v005', 'v006', 'v007']) {
        const selected = getFirstPersonFrameClip({ weapon, armor, artVersion: version });
        assert.ok(selected); assert.equal(selected.artVersion, version);
        assert.ok(Object.values(selected.frames).every(url => !url.includes('/v008/')));
        assert.ok(Object.values(selected.techniqueFrames ?? {}).every(url => !url.includes('/v008/')));
      }
    }
    const original = renderFirstPersonArena(createFirstPersonSample({ weapon: 'greatsword' }), { viewerIndex: 0, artVersion: 'v007' });
    const candidate = renderFirstPersonArena(createFirstPersonSample({ weapon: 'greatsword' }), { viewerIndex: 0, artVersion: 'v008' });
    assert.match(original, /data-frame-version="v007"/); assert.match(candidate, /data-frame-version="v008"/);
    assert.equal((candidate.match(/class="pixel-sprite fp-authored-frame"/g) ?? []).length, 1);
    assert.deepEqual({ catalog, axisCatalog, bladeCatalog }, preserved, 'Resolving garment frames cannot mutate any preserved source catalog.');
  } finally { armorCatalog.overrides = saved; }
});

test('invalid declared v008 frames reject the whole selected clip without requesting media or changing historical comparisons', async () => {
  const saved = structuredClone(armorCatalog);
  const gear = { weapon: 'trident', armor: 'medium', skin: 'ivory', artVersion: 'v008' };
  try {
    for (const invalid of [
      { contact: { ...garmentFrame('trident-netcast', 'medium', 'contact'), width: 459 } },
      { contact: { ...garmentFrame('trident-netcast', 'medium', 'contact'), pose: 'windup' } },
      { nonexistent: garmentFrame('trident-netcast', 'medium', 'contact') },
      { contact: { ...garmentFrame('trident-netcast', 'medium', 'contact'), variants: { ivory: 'https://invalid.example/frame.png' } } },
      { contact: { ...garmentFrame('trident-netcast', 'medium', 'contact'), variants: { ivory: '/assets/first-person/v008/../contact.png' } } },
      null,
    ]) {
      armorCatalog.overrides = { 'trident-netcast': { medium: invalid } };
      assert.equal(getFirstPersonFrameClip(gear), null, 'A broken declared Entangle frame cannot leave a partially admitted equipment clip.');
      assert.equal(await preloadFirstPersonFrames(gear, { loadFrame: () => assert.fail('Invalid declared artwork cannot request media.') }), null);
      for (const artVersion of ['v005', 'v006', 'v007']) assert.ok(getFirstPersonFrameClip({ ...gear, artVersion }));
    }
    for (const invalid of [null, [], 'invalid']) {
      armorCatalog.overrides = { 'trident-netcast': invalid };
      assert.equal(getFirstPersonFrameClip(gear), null, 'Malformed declared armor groups cannot silently inherit an older cast.');
      armorCatalog.overrides = invalid;
      assert.equal(getFirstPersonFrameClip(gear), null, 'Malformed override roots cannot admit a partial v008 catalog.');
    }
    armorCatalog.overrides = {};
    armorCatalog.baseVersion = 'v005';
    assert.equal(getFirstPersonFrameClip(gear), null, 'Armor admission requires the repaired v007 base.');
    assert.ok(getFirstPersonFrameClip({ ...gear, artVersion: 'v007' }));
  } finally { Object.assign(armorCatalog, saved); }
});

test('v008 full frames predecode as one complete equipment set and preserve the public contact clock and cleanup in both seats', async () => {
  const saved = armorCatalog.overrides;
  const gear = { weapon: 'trident', armor: 'heavy', skin: 'umber', artVersion: 'v008' };
  try {
    armorCatalog.overrides = {
      trident: { heavy: { windup: garmentFrame('trident', 'heavy', 'windup') } },
      'trident-netcast': { heavy: { contact: garmentFrame('trident-netcast', 'heavy', 'contact') } },
    };
    const clip = getFirstPersonFrameClip(gear), requested = [], allUrls = [...Object.values(clip.frames), ...Object.values(clip.techniqueFrames)];
    assert.equal(await preloadFirstPersonFrames(gear, { loadFrame: url => {
      requested.push(url); return url !== clip.techniqueFrames.contact;
    } }), null, 'One missing cast frame retains the complete anchored fallback.');
    assert.deepEqual(requested, allUrls); assert.equal(preparedFirstPersonFrameClip(gear), null);
    await withImages(async ({ loads, decodes }) => {
      assert.ok(await preloadFirstPersonFrames(gear)); assert.equal(loads.length, 8); assert.deepEqual(decodes, loads);
      assert.ok(preparedFirstPersonFrameClip(gear));
    });
    for (const viewerIndex of [0, 1]) await controlled(async clock => {
      const arena = fixture(viewerIndex, gear.skin, gear, 'v008'), before = snapshot(arena.container), frames = [], cues = [];
      globalThis.document = arena.document;
      assert.equal(arena.local.dataset.frameVersion, 'v008');
      const playback = playFirstPersonBattleAnimation(arena.container, [{ ...attack(viewerIndex, 'technique'), weapon: 'trident' }], {
        reducedMotion: false, onCue: cue => cues.push([clock.elapsed, cue.type]),
        onAttackFrame: frame => frames.push([frame.elapsedMs, arena.image.getAttribute('href')]),
      });
      await clock.finish(); assert.equal(await playback, true);
      assert.equal(frames.find(([time]) => time === 285)[1], clip.techniqueFrames.contact);
      assert.equal(clock.elapsed, 765); assert.equal(clock.maxPending, 1); assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]);
      assert.deepEqual(snapshot(arena.container), before);
    });
  } finally { armorCatalog.overrides = saved; }
});

test('admitted greatsword garment frames play all four complete poses and restore exact ready holds in both seats', {
  skip: getFirstPersonFrameClip({ weapon: 'greatsword', armor: 'medium' })?.artVersion === 'v008'
    || ['light', 'medium', 'heavy'].every(armor => Object.hasOwn(armorCatalog.overrides.greatsword ?? {}, armor))
    ? false : 'The full three-armor v008 greatsword set has not been admitted.',
}, async () => {
  for (const armor of ['light', 'medium', 'heavy']) {
    const gear = { weapon: 'greatsword', armor, skin: 'sand', artVersion: 'v008' };
    const clip = getFirstPersonFrameClip(gear);
    await withImages(async () => assert.ok(await preloadFirstPersonFrames(gear)));
    assert.ok(preparedFirstPersonFrameClip(gear));
    for (const viewerIndex of [0, 1]) await controlled(async clock => {
      const arena = fixture(viewerIndex, gear.skin, gear, 'v008'), before = snapshot(arena.container);
      const frames = [], cues = []; globalThis.document = arena.document;
      assert.equal(arena.local.dataset.frameVersion, 'v008');
      const playback = playFirstPersonBattleAnimation(arena.container, [{ ...attack(viewerIndex), weapon: 'greatsword' }], {
        reducedMotion: false, onCue: cue => cues.push([clock.elapsed, cue.type]),
        onAttackFrame: frame => frames.push([frame.elapsedMs, arena.image.getAttribute('href')]),
      });
      await clock.finish(); assert.equal(await playback, true);
      for (const [time, pose] of [[90, 'windup'], [285, 'contact'], [365, 'follow'], [570, 'recovery']]) {
        assert.equal(frames.find(([at]) => at === time)?.[1], clip.frames[pose]);
        assert.match(clip.frames[pose], /\/assets\/first-person\/v008\/greatsword-/);
      }
      assert.equal(clock.elapsed, 765); assert.equal(clock.maxPending, 1);
      assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]);
      assert.deepEqual(snapshot(arena.container), before, 'All authored arms, exact original ready holds and the saved rival restore together.');
    });
  }
});

test('frame selection retains original idle at both ends, contact at285 and the independent feint anticipation pose', () => {
  const clip = getFirstPersonFrameClip(selection()); assert.ok(clip); assert.ok(Object.isFrozen(clip)); assert.ok(Object.isFrozen(clip.frames));
  for (const [time, pose] of [[0, 'idle'], [89, 'idle'], [90, 'windup'], [180, 'windup'], [284, 'windup'],
    [285, 'contact'], [365, 'follow'], [475, 'follow'], [570, 'recovery'], [664, 'recovery'], [665, 'idle']]) {
    assert.equal(firstPersonFrameAt(clip, time).pose, pose);
  }
  assert.equal(firstPersonFrameAt(clip, 90, 'technique').pose, 'contact');
  assert.equal(firstPersonFrameAt(clip, 180, 'technique').pose, 'windup');
  assert.equal(firstPersonFrameAt(clip, 285, 'technique').pose, 'contact');
  assert.equal(firstPersonFrameAt(clip, -100).url, null); assert.equal(firstPersonFrameAt(clip, 1000).url, null);
  assert.equal(firstPersonFrameAt(null, 285), null);
  for (const invalid of [{}, { weapon: 'bad', armor: 'medium' }, { weapon: 'sword', armor: 'bad' }, selection('bad'),
    { ...selection(), artVersion: 'v004' }, { ...selection(), artVersion: 'untrusted' }]) assert.equal(getFirstPersonFrameClip(invalid), null);
});

test('preload is abortable and a failed frame rejects the whole clip; injected loaders cannot spoof the decoded-image cache', async () => {
  const requested = [], accepted = await preloadFirstPersonFrames(selection('porcelain'), { loadFrame: url => { requested.push(url); return true; } });
  assert.ok(accepted); assert.equal(requested.length, 4);
  assert.equal(preparedFirstPersonFrameClip(selection('porcelain')), null);
  assert.equal(await preloadFirstPersonFrames(selection('sand'), { loadFrame: url => url !== getFirstPersonFrameClip(selection('sand')).frames.contact }), null);
  assert.equal(await preloadFirstPersonFrames(selection('copper'), { loadFrame: () => Promise.reject(new Error('Unavailable frame.')) }), null);
  const controller = new AbortController(); let calls = 0;
  const waiting = preloadFirstPersonFrames(selection('ebony'), { signal: controller.signal, loadFrame: () => { calls++; return new Promise(() => {}); } });
  await settle(); controller.abort(); assert.equal(await waiting, null); assert.equal(calls, 4);
  const stopped = new AbortController(); stopped.abort();
  assert.equal(await preloadFirstPersonFrames(selection(), { signal: stopped.signal, loadFrame: () => assert.fail('Aborted preload cannot request images.') }), null);
});

test('a genuine browser image decode prepares all four poses and one full-image swap preserves source holds and rival identity in both seats', async () => {
  await withImages(async ({ loads, decodes }) => {
    const clip = await preloadFirstPersonFrames(selection()); assert.ok(clip);
    assert.equal(loads.length, 4); assert.deepEqual(decodes, loads); assert.ok(preparedFirstPersonFrameClip(selection()));
    for (const viewerIndex of [0, 1]) {
      const arena = fixture(viewerIndex), held = arena.local.querySelectorAll('.fp-whole-hold').map(snapshot), rival = snapshot(arena.rival);
      assert.ok(arena.image); assert.equal(arena.local.querySelectorAll('.fp-authored-frame').length, 1);
      assert.deepEqual(['x', 'y', 'width', 'height'].map(name => arena.image.getAttribute(name)), ['0', '0', '920', '440']);
      for (const time of [0, 90, 285, 365, 570, 665]) {
        assert.equal(applyFirstPersonFrame(arena.local, clip, time, 'strike'), true);
        const frame = firstPersonFrameAt(clip, time);
        assert.equal(arena.image.getAttribute('href'), frame.url);
        assert.deepEqual(arena.local.querySelectorAll('.fp-whole-hold').map(snapshot), held);
        assert.deepEqual(snapshot(arena.rival), rival);
      }
      const before = snapshot(arena.local); arena.container.rootConnected = false;
      assert.equal(applyFirstPersonFrame(arena.local, clip, 285), false); assert.deepEqual(snapshot(arena.local), before);
    }
  });
});

test('resolved local attacks swap complete poses on the shared clock and restore every original image and identity', async () => {
  for (const viewerIndex of [0, 1]) for (const action of ['strike', 'technique']) await controlled(async clock => {
    const arena = fixture(viewerIndex), before = snapshot(arena.container), held = arena.local.querySelectorAll('.fp-whole-hold').map(snapshot), frames = [], cues = [];
    globalThis.document = arena.document;
    const playback = playFirstPersonBattleAnimation(arena.container, [attack(viewerIndex, action)], { reducedMotion: false,
      onCue: cue => cues.push([clock.elapsed, cue.type]), onAttackFrame: frame => {
        frames.push({ at: clock.elapsed, elapsedMs: frame.elapsedMs, href: arena.image.getAttribute('href'),
          pose: arena.local.dataset.framePose, targetReaction: arena.rival.dataset.animation });
      } });
    await settle(); assert.equal(arena.local.dataset.framePose, 'idle');
    for (const time of [90, 180, 285]) { await clock.step(); assert.equal(clock.elapsed, time);
      assert.deepEqual(arena.local.querySelectorAll('.fp-whole-hold').map(snapshot), held); }
    assert.equal(arena.image.getAttribute('href'), getFirstPersonFrameClip(selection()).frames.contact);
    assert.equal(arena.rival.dataset.animation, 'hit');
    await clock.finish(); assert.equal(await playback, true);
    assert.deepEqual(frames.map(frame => frame.elapsedMs), [0, 90, 180, 285, 365, 475, 570, 665]);
    const contact = frames.find(frame => frame.elapsedMs === 285); assert.equal(contact.targetReaction, undefined);
    assert.equal(contact.pose, 'contact'); assert.equal(frames.at(-1).href, null); assert.equal(frames.at(-1).pose, undefined);
    assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]); assert.equal(clock.elapsed, 765); assert.equal(clock.maxPending, 1);
    assert.deepEqual(snapshot(arena.container), before); assert.equal(clock.pending, 0);
  });
});

test('aborting at any complete pose or detaching the arena restores the foreground without inventing later contacts', async () => {
  for (const stopAt of [0, 90, 180, 285, 365, 475, 570, 665]) await controlled(async clock => {
    const arena = fixture(1), controller = new AbortController(), before = snapshot(arena.container), frames = [], cues = [];
    globalThis.document = arena.document;
    const playback = playFirstPersonBattleAnimation(arena.container, [attack(1)], { signal: controller.signal, reducedMotion: false,
      onCue: cue => cues.push(cue.type), onAttackFrame: frame => { frames.push(frame.elapsedMs); if (frame.elapsedMs === stopAt) controller.abort(); } });
    await clock.finish(); assert.equal(await playback, false); assert.equal(frames.at(-1), stopAt);
    assert.equal(cues.includes('hit'), stopAt > 285); assert.equal(clock.pending, 0); assert.deepEqual(snapshot(arena.container), before);
  });
  await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), frames = []; globalThis.document = arena.document;
    const playback = playFirstPersonBattleAnimation(arena.container, [attack(0)], { reducedMotion: false, onAttackFrame: frame => {
      frames.push(frame.elapsedMs); if (frame.elapsedMs === 180) arena.container.rootConnected = false;
    } });
    await clock.finish(); assert.equal(await playback, false); assert.deepEqual(frames, [0, 90, 180]);
    assert.deepEqual(snapshot(arena.container), before); assert.equal(clock.pending, 0);
  });
});

test('failed image decoding selects the whole preserved attack fallback, while reduced motion and rival attacks never swap local poses', async () => {
  const failedSelection = selection('umber'), failure = getFirstPersonFrameClip(failedSelection).frames.contact;
  await withImages(async () => {
    assert.equal(await preloadFirstPersonFrames(failedSelection), null); assert.equal(preparedFirstPersonFrameClip(failedSelection), null);
    await controlled(async clock => {
      const arena = fixture(0, 'umber'), before = snapshot(arena.container); globalThis.document = arena.document;
      const playback = playFirstPersonBattleAnimation(arena.container, [attack(0)], { reducedMotion: false });
      await clock.step(); assert.equal(arena.local.dataset.framePose, undefined); assert.equal(arena.image.getAttribute('href'), null);
      await clock.finish(); assert.equal(await playback, true); assert.deepEqual(clock.durations, [285, 380, 100]);
      assert.deepEqual(snapshot(arena.container), before);
    });
  }, failure);
  for (const mode of ['reduced', 'rival']) await controlled(async clock => {
    const arena = fixture(), before = snapshot(arena.container), frames = []; globalThis.document = arena.document;
    const playback = playFirstPersonBattleAnimation(arena.container, [attack(mode === 'rival' ? 1 : 0)], { reducedMotion: mode === 'reduced',
      onAttackFrame: frame => frames.push([frame.elapsedMs, arena.image.getAttribute('href'), arena.local.dataset.framePose]) });
    await clock.finish(); assert.equal(await playback, true);
    if (mode === 'reduced') { assert.deepEqual(frames, []); assert.deepEqual(clock.durations, [90, 150, 35]); }
    else assert.ok(frames.every(([, href, pose]) => href === null && pose === undefined));
    assert.deepEqual(snapshot(arena.container), before);
  });
});

test('trident Strike and Entangle select distinct complete poses, and all eight decoded images are required before playback', async () => {
  const trident = { weapon: 'trident', armor: 'medium', skin: 'porcelain' };
  const clip = getFirstPersonFrameClip(trident);
  assert.ok(clip?.techniqueFrames, 'The authored Entangle control is present alongside the ordinary thrust.');
  for (const [time, pose] of [[0, 'idle'], [90, 'windup'], [180, 'windup'], [285, 'contact'],
    [365, 'follow'], [475, 'follow'], [570, 'recovery'], [665, 'idle']]) {
    const strike = firstPersonFrameAt(clip, time, 'strike'), cast = firstPersonFrameAt(clip, time, 'technique');
    assert.equal(strike.pose, pose); assert.equal(cast.pose, pose);
    if (pose === 'idle') { assert.equal(strike.url, null); assert.equal(cast.url, null); }
    else { assert.equal(strike.url, clip.frames[pose]); assert.equal(cast.url, clip.techniqueFrames[pose]); assert.notEqual(strike.url, cast.url); }
  }
  assert.equal(new Set([...Object.values(clip.frames), ...Object.values(clip.techniqueFrames)]).size, 8);
  await withImages(async ({ loads, decodes }) => {
    assert.ok(await preloadFirstPersonFrames(trident));
    assert.equal(loads.length, 8); assert.deepEqual(new Set(loads), new Set([...Object.values(clip.frames), ...Object.values(clip.techniqueFrames)]));
    assert.deepEqual(decodes, loads); assert.ok(preparedFirstPersonFrameClip(trident));
  });
  const unavailable = { ...trident, skin: 'umber' }, castFailure = getFirstPersonFrameClip(unavailable).techniqueFrames.contact;
  await withImages(async ({ loads }) => {
    assert.equal(await preloadFirstPersonFrames(unavailable), null); assert.equal(loads.length, 8);
    assert.equal(preparedFirstPersonFrameClip(unavailable), null, 'A failed cast frame keeps the complete equipment set on its preserved fallback.');
    await controlled(async clock => {
      const arena = fixture(0, 'umber', { weapon: 'trident' }), before = snapshot(arena.container); globalThis.document = arena.document;
      const event = { ...attack(0, 'technique'), weapon: 'trident', entangled: true };
      const playback = playFirstPersonBattleAnimation(arena.container, [event], { reducedMotion: false });
      await clock.step(); assert.equal(arena.image.getAttribute('href'), null); assert.equal(arena.local.dataset.framePose, undefined);
      await clock.finish(); assert.equal(await playback, true); assert.deepEqual(clock.durations, [285, 380, 100]);
      assert.deepEqual(snapshot(arena.container), before);
    });
  }, castFailure);
  // The older complete net-cast animation remains usable if the additive cast
  // catalog is unavailable, even when the ordinary thrust clip is present.
  const castCatalog = catalog.clips['trident-netcast'];
  try {
    delete catalog.clips['trident-netcast'];
    const thrustOnly = getFirstPersonFrameClip(trident); assert.ok(thrustOnly); assert.equal(firstPersonFrameAt(thrustOnly, 285, 'technique'), null);
    const arena = fixture(0, 'porcelain', { weapon: 'trident' });
    assert.equal(applyFirstPersonFrame(arena.local, thrustOnly, 285, 'strike'), true);
    assert.equal(applyFirstPersonFrame(arena.local, thrustOnly, 285, 'technique'), false);
    assert.equal(arena.image.getAttribute('href'), null); assert.equal(arena.local.dataset.framePose, undefined);
  } finally { catalog.clips['trident-netcast'] = castCatalog; }
});

test('resolved Entangle and Riposte counters keep contact at285, restore both seats, and abort without later impacts', async () => {
  for (const weapon of ['trident', 'dagger']) {
    const equipment = { weapon, armor: 'medium', skin: 'copper' };
    await withImages(async () => assert.ok(await preloadFirstPersonFrames(equipment)));
    for (const viewerIndex of [0, 1]) for (const stopAt of [null, 180, 285, 570]) await controlled(async clock => {
      const arena = fixture(viewerIndex, 'copper', equipment), controller = new AbortController(), before = snapshot(arena.container);
      const choices = ['strike', 'strike']; choices[viewerIndex] = 'technique';
      if (weapon === 'trident') choices[1 - viewerIndex] = 'focus';
      const resolved = resolveRound(arena.duel, choices, { choiceElapsedMs: [0, 0] });
      const event = buildAnimationSteps(arena.duel, resolved).find(step => step.type === 'attack' && step.actor === viewerIndex);
      assert.ok(event); assert.equal(event.weapon, weapon);
      if (weapon === 'trident') { assert.equal(event.action, 'technique'); assert.equal(event.entangled, true); }
      else { assert.equal(event.action, 'technique'); assert.equal(event.counter, true); }
      const publicResult = structuredClone(resolved), frames = [], cues = []; globalThis.document = arena.document;
      const playback = playFirstPersonBattleAnimation(arena.container, [event], { signal: controller.signal, reducedMotion: false,
        onCue: cue => cues.push([clock.elapsed, cue.type]), onAttackFrame: frame => {
          frames.push({ at: clock.elapsed, elapsed: frame.elapsedMs, href: arena.image.getAttribute('href'), targetReaction: arena.rival.dataset.animation });
          if (frame.elapsedMs === stopAt) controller.abort();
        } });
      await clock.finish(); assert.equal(await playback, stopAt === null);
      const clip = getFirstPersonFrameClip(equipment), expectedFrames = weapon === 'trident' ? clip.techniqueFrames : clip.frames;
      for (const frame of frames) assert.equal(frame.href, firstPersonFrameAt(clip, frame.elapsed, event.action).url);
      const contact = frames.find(frame => frame.elapsed === 285);
      if (contact) { assert.equal(contact.at, 285); assert.equal(contact.href, expectedFrames.contact); assert.equal(contact.targetReaction, undefined); }
      assert.equal(cues.some(([, type]) => type === 'hit'), stopAt === null || stopAt > 285);
      if (stopAt === null) { assert.equal(clock.elapsed, 765); assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]); }
      else assert.equal(frames.at(-1).elapsed, stopAt);
      assert.equal(clock.maxPending, 1); assert.equal(clock.pending, 0);
      assert.deepEqual(snapshot(arena.container), before); assert.deepEqual(resolved, publicResult);
    });
  }
});

test('first-person wrapped synchronous and rejected asynchronous callbacks preserve contact, authored frames and cleanup', async () => {
  await withImages(async () => assert.ok(await preloadFirstPersonFrames(selection())));
  for (const viewerIndex of [0, 1]) for (const failure of ['throw', 'reject']) await controlled(async clock => {
    const arena = fixture(viewerIndex), before = snapshot(arena.container), event = Object.freeze(attack(viewerIndex));
    const frames = [], cues = []; globalThis.document = arena.document;
    const playback = playFirstPersonBattleAnimation(arena.container, [event], { reducedMotion: false,
      onCue: cue => cues.push([clock.elapsed, cue.type]), onAttackFrame: frame => {
        frames.push({ elapsed: frame.elapsedMs, href: arena.image.getAttribute('href'), targetReaction: arena.rival.dataset.animation });
        assert.ok(Object.isFrozen(frame)); assert.ok(Object.isFrozen(frame.step));
        if (failure === 'throw') throw new Error('Optional visual observer failed.');
        return Promise.reject(new Error('Optional asynchronous visual observer failed.'));
      } });
    await clock.finish(); assert.equal(await playback, true);
    assert.deepEqual(frames.map(frame => frame.elapsed), [0, 90, 180, 285, 365, 475, 570, 665]);
    const clip = getFirstPersonFrameClip(selection()), contact = frames.find(frame => frame.elapsed === 285);
    assert.equal(contact.href, clip.frames.contact); assert.equal(contact.targetReaction, undefined);
    assert.deepEqual(cues, [[0, 'swing'], [285, 'hit']]); assert.equal(clock.elapsed, 765);
    assert.equal(clock.maxPending, 1); assert.equal(clock.pending, 0);
    assert.deepEqual(snapshot(arena.container), before); assert.deepEqual(event, attack(viewerIndex));
  });
});

test('explicit v001–v004 comparisons keep their preserved renderer and clock while default/v005/v006/v007/v008 add one complete frame image', async () => {
  const imageTags = svg => [...svg.matchAll(/<image\b[^>]*class="[^"]*\bfp-whole-hold\b[^"]*"[^>]*>/g)].map(match => match[0]);
  const frameImages = svg => [...svg.matchAll(/<image\b[^>]*class="[^"]*\bfp-authored-frame\b[^"]*"[^>]*>/g)].map(match => match[0]);
  for (const weapon of ['sword', 'axe', 'greatsword', 'spear', 'halberd', 'trident', 'flail', 'mace', 'dagger']) for (const viewerIndex of [0, 1]) {
    const duel = createFirstPersonSample({ ...selection(), weapon });
    const legacy = Object.fromEntries(['v001', 'v002', 'v003', 'v004'].map(artVersion =>
      [artVersion, renderFirstPersonArena(duel, { viewerIndex, artVersion })]));
    for (const svg of Object.values(legacy)) { assert.equal(frameImages(svg).length, 0); assert.doesNotMatch(svg, /data-frame-capable/); }
    const current = [['v008', renderFirstPersonArena(duel, { viewerIndex })], ...['v005', 'v006', 'v007', 'v008'].map(artVersion =>
      [artVersion, renderFirstPersonArena(duel, { viewerIndex, artVersion })])];
    for (const [version, svg] of current) {
      const images = frameImages(svg); assert.equal(images.length, 1); assert.match(svg, /data-frame-capable="true"/);
      assert.ok(svg.includes(`data-frame-version="${version}"`));
      assert.doesNotMatch(images[0], /\bhref=/, 'Initial idle uses the preserved ready hold.');
      assert.deepEqual(imageTags(svg), imageTags(legacy.v004), 'The additive frame layer leaves every ready-pose image and registration exact.');
    }
    if (weapon === 'axe') {
      assert.match(legacy.v003, /\/assets\/first-person\/v003\/axe-medium-main-ivory\.png/);
      assert.doesNotMatch(legacy.v003, /\/assets\/first-person\/v004\//);
      assert.match(legacy.v004, /\/assets\/first-person\/v004\/axe-medium-main-ivory\.png/);
    }
  }
  await withImages(async () => assert.ok(await preloadFirstPersonFrames(selection())));
  for (const artVersion of ['v001', 'v002', 'v003', 'v004']) for (const viewerIndex of [0, 1]) await controlled(async clock => {
    const arena = fixture(viewerIndex, 'ivory', {}, artVersion), before = snapshot(arena.container); globalThis.document = arena.document;
    assert.equal(arena.image, null);
    const playback = playFirstPersonBattleAnimation(arena.container, [attack(viewerIndex)], { reducedMotion: false });
    await clock.finish(); assert.equal(await playback, true); assert.deepEqual(clock.durations, [285, 380, 100]);
    assert.equal(arena.local.dataset.framePose, undefined); assert.deepEqual(snapshot(arena.container), before);
  });
});

async function normalApp(frameLoader) {
  const source = await fs.readFile(path.join(project, 'src/app.js'), 'utf8');
  const startup = source.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
  assert.ok(startup > 0, 'The real app startup boundary is present.');
  const attributes = new Map(), timers = new Map(); let now = 100000, timerId = 0;
  const app = { innerHTML: 'Previous screen', inert: false, addEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], setAttribute: (name, value) => attributes.set(name, value) };
  class AppDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    ...audioBindings, ...combat, ...presentation, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    createFightTutorial, renderFightTutorial, renderFirstPersonArena, renderArmory, renderMercyPanel,
    // Keep the actual normal routing, render barrier and local clock. Replace
    // only browser/network and unrelated avatar/media preparation boundaries.
    prepareCleanAvatar: async () => {}, prepareFightTutorial: async () => {}, renderCleanAvatar: () => '',
    ...(frameLoader ? { preloadFirstPersonFrames: frameLoader } : {}),
    OnlineClient: class {}, structuredClone, URLSearchParams, AbortController, Date: AppDate, console,
    setTimeout: (callback, duration) => { timers.set(++timerId, { callback, duration }); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {},
    location: { search: '' }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: selector => selector === '#app' ? app : null, addEventListener() {}, activeElement: null },
  });
  vm.runInContext(source.slice(0, startup).replace(/^import .*;\r?\n/gm, '') + `
    globalThis.frameApp = { state, render, prepareTurn,
      get clock() { return localTurnClock; }, get busy() { return renderBusy; },
      set tutorial(value) { tutorialState = value; }
    };
  `, context, { filename: 'src/app.js' });
  return { ui: context.frameApp, app, attributes, timers, setNow: value => { now = value; } };
}

test('fresh normal lessons, battles and loadouts decode complete poses before controls open or the local choice clock starts', async () => {
  const originalImage = globalThis.Image, loads = [], decodes = [], requests = [], gates = [];
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
  let gate;
  globalThis.Image = class {
    set src(url) { this.url = url; loads.push(url); queueMicrotask(() => this.onload?.()); }
    decode() { decodes.push(this.url); return gate.promise; }
  };
  try {
    const { ui, app, attributes, timers, setNow } = await normalApp(request => {
      requests.push({ ...request }); return preloadFirstPersonFrames(request);
    });
    ui.state.mode = 'cpu';
    const lesson = createFightTutorial();
    lesson.duel = combat.createDuel(lesson.duel.fighters.map((fighter, index) => ({ ...fighter,
      character: { ...fighter.character, appearance: { ...fighter.character.appearance, skin: index ? 'ivory' : 'ebony' } },
    })));
    ui.tutorial = lesson; ui.state.screen = 'tutorial';
    const learner = { weapon: 'sword', armor: 'medium', skin: 'ebony' };
    const duel = combat.createDuel(createFirstPersonSample().fighters.map((fighter, index) => ({
      character: { ...fighter.character, appearance: { ...fighter.character.appearance, skin: index ? 'ebony' : 'sand' } },
      weapon: index ? 'trident' : 'axe', armor: index ? 'light' : 'heavy', helmet: 'none',
    })));
    const battleSelections = [{ weapon: 'axe', armor: 'heavy', skin: 'sand' }, { weapon: 'trident', armor: 'light', skin: 'ebony' }];
    const loadout = { weapon: 'mace', armor: 'heavy', skin: 'porcelain' };
    const stages = [
      { screen: 'tutorial', selections: [learner], imageCount: 4, controls: /data-action="tutorial-move"/, clock: false },
      { screen: 'battle', selections: battleSelections, imageCount: 12, controls: /data-action="fight"/, clock: true },
      { screen: 'loadout', selections: [loadout], imageCount: 4, controls: /data-action="lock-loadout"/, clock: false },
    ];
    for (const [index, stage] of stages.entries()) {
      if (stage.screen !== 'tutorial') {
        ui.state.duel = duel; ui.state.profiles = duel.fighters.map(fighter => ({ character: structuredClone(fighter.character), alive: true, duelWins: 0 }));
        ui.state.loadouts = battleSelections.map(gear => ({ weapon: gear.weapon, armor: gear.armor, helmet: 'none' }));
        ui.state.screen = stage.screen; ui.prepareTurn();
        if (stage.screen === 'loadout') {
          ui.state.picker = 0; ui.state.profiles[0].character.appearance.skin = loadout.skin;
          ui.state.loadouts[0] = { weapon: loadout.weapon, armor: loadout.armor, helmet: 'none' };
        }
      }
      const identities = structuredClone(ui.state.profiles), publicDuel = structuredClone(duel);
      assert.equal(ui.clock, null); assert.equal(timers.size, 0);
      for (const selected of stage.selections) assert.equal(preparedFirstPersonFrameClip(selected), null, 'This view starts with fresh, undecoded poses.');
      gate = deferred(); gates.push(gate); const previousHtml = app.innerHTML, loadStart = loads.length, requestStart = requests.length;
      const rendering = ui.render(); await settle();
      assert.equal(ui.busy, true); assert.equal(app.inert, true); assert.equal(attributes.get('aria-busy'), 'true');
      assert.equal(app.innerHTML, previousHtml, 'Playable controls wait for the actual image decode barrier.');
      assert.equal(ui.clock, null); assert.equal(timers.size, 0, 'Loading cannot consume the independent local choice window.');
      assert.deepEqual(requests.slice(requestStart), stage.selections);
      for (const request of requests.slice(requestStart)) assert.deepEqual(Object.keys(request).sort(), ['armor', 'skin', 'weapon']);
      assert.equal(loads.length - loadStart, stage.imageCount); assert.deepEqual(decodes, loads);
      for (const selected of stage.selections) assert.equal(preparedFirstPersonFrameClip(selected), null, 'Loaded images remain unavailable until decode completes.');
      const openedAt = 102000 + index * 10000; setNow(openedAt); gate.resolve(); await rendering;
      assert.equal(ui.busy, false); assert.equal(app.inert, false); assert.equal(attributes.get('aria-busy'), 'false');
      assert.match(app.innerHTML, stage.controls); assert.equal(ui.state.error, '');
      for (const selected of stage.selections) assert.ok(preparedFirstPersonFrameClip(selected));
      if (stage.clock) {
        assert.equal(ui.clock.openedAt, openedAt); assert.equal(ui.clock.deadline, openedAt + combat.RULES.TURN_SECONDS * 1000);
        assert.equal(timers.size, 1); assert.equal([...timers.values()][0].duration, combat.RULES.TURN_SECONDS * 1000);
      } else { assert.equal(ui.clock, null); assert.equal(timers.size, 0); }
      assert.deepEqual(structuredClone(ui.state.profiles), identities); assert.deepEqual(duel, publicDuel);
    }
    // Existing app harnesses and preserved presentations may omit the additive
    // loader. They still open the normal battle with the complete old fallback.
    const legacy = await normalApp(); legacy.ui.state.mode = 'cpu'; legacy.ui.state.screen = 'battle'; legacy.ui.state.duel = duel;
    legacy.ui.state.profiles = duel.fighters.map(fighter => ({ character: fighter.character, alive: true, duelWins: 0 }));
    legacy.ui.prepareTurn(); await legacy.ui.render();
    assert.match(legacy.app.innerHTML, /data-action="fight"/); assert.equal(legacy.ui.state.error, '');
    assert.ok(legacy.ui.clock); assert.equal(legacy.timers.size, 1);
  } finally { for (const pending of gates) pending.resolve(); globalThis.Image = originalImage; }
});
