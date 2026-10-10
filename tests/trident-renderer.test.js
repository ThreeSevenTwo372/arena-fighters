import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeAvatarPng, normalizeAppearance } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { preloadCleanArt, prepareCleanAvatar, renderCleanAvatar } from '../src/current-avatar.js';
import { renderArmory, ARMORY_WEAPON_DISPLAY } from '../src/armory.js';
import { renderArena } from '../src/arena.js';
import { createDuel, resolveRound } from '../src/combat.js';
import { buildAnimationSteps } from '../src/battle-animation.js';
import { buildExecutionEvent } from '../src/execution-animation.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), origin = 'http://127.0.0.1:4173';
const read = url => fs.readFile(path.join(root, url.replace(/^\//, '')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
globalThis.fetch = async input => {
  const url = new URL(input), target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== origin || !target.startsWith(`${root}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
const character = (sex, preset = true) => ({ name: sex, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced',
  appearance: preset ? normalizePresetAppearance({ sex, facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' }) : normalizeAppearance({ sex, hairstyle: 'shag', skin: 'ivory', hairColor: 'chestnut' }) });

test('native trident and net PNGs match every authored integer sample and preserved preparation hash', async () => {
  const directory = 'assets/clean-gladiator/v015-equipment/', receipt = JSON.parse(await read(`${directory}PREPARATION_RECEIPT.json`));
  for (const control of receipt.textures) {
    const sourceBytes = await read(`${directory}${control.id}.source.json`), source = JSON.parse(sourceBytes);
    const bytes = await read(`${directory}weapons/${control.id}.png`), image = await decodeAvatarPng(new Uint8Array(bytes));
    assert.equal(hash(sourceBytes), control.sourceSha256); assert.equal(hash(bytes), control.textureSha256);
    assert.equal(hash(await read(`${directory}${control.id}.source.svg`)), control.sourceSvgSha256);
    assert.deepEqual([image.width, image.height], source.canvas);
    const expected = new Uint8Array(image.pixels.length), occupied = new Set();
    for (const { position: [x, y], material } of source.cells) {
      const index = y * image.width + x; assert.ok(!occupied.has(index)); occupied.add(index);
      expected.set(source.palette[material].rgba, index * 4);
    }
    assert.deepEqual(image.pixels, expected); assert.equal(source.provenance.providerCalls, 0);
    assert.equal(image.pixels[(source.grip[1] * image.width + source.grip[0]) * 4 + 3], 255, 'The recorded grip is an authored opaque cell.');
  }
});

test('additive trident overlay preserves the exact dagger entry and the historical identity catalogs', async () => {
  const current = await preloadCleanArt(), previous = JSON.parse(await read('assets/clean-gladiator/v014-equipment/manifest.json'));
  assert.deepEqual(current.weapons.dagger, previous.weapons.dagger);
  assert.deepEqual(current.weapons.trident.grip, [12, 64]); assert.deepEqual(current.weapons.trident.offhand.grip, [5, 4]);
  for (const version of ['v006', 'v013']) {
    const source = JSON.parse(await read(`assets/clean-gladiator/${version}/manifest.json`));
    assert.equal(source.weapons.trident, undefined); assert.equal(source.weapons.dagger, undefined);
    for (const id of ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'shield']) assert.deepEqual(current.weapons[id], source.weapons[id]);
  }
});

test('all armor and identity paths keep exact complete figure pixels and hand sockets while attaching both new pieces', async () => {
  for (const armor of ['light', 'medium', 'heavy']) for (const sex of ['male', 'female']) for (const preset of [false, true]) {
    const fighter = character(sex, preset), before = structuredClone(fighter), gear = { weapon: 'trident', armor, helmet: 'none' };
    const trident = await prepareCleanAvatar(fighter.appearance, 'battle', gear), sword = await prepareCleanAvatar(fighter.appearance, 'battle', { ...gear, weapon: 'sword' });
    assert.equal(trident.url, sword.url, 'Body/head identity RGBA stays exact.');
    for (const field of ['mainhandGrip', 'offhandGrip', 'handsImage', 'identityTransform', 'identityOffset', 'assembledIdentityAnchor', 'pivot']) assert.deepEqual(trident[field], sword[field]);
    assert.deepEqual(fighter, before); assert.match(trident.shieldImage.url, /v015-equipment\/weapons\/net\.png/);
    const svg = renderCleanAvatar(fighter.appearance, 'battle', gear);
    assert.match(svg, /x="-12" y="-64" width="26" height="92"/); assert.match(svg, /x="-5" y="-4" width="38" height="42"/);
    for (const [id, item, grip, angle, mirror] of [['trident', trident.weaponImage, trident.mainhandGrip, trident.weaponAngle, trident.weaponMirror], ['net', trident.shieldImage, trident.offhandGrip, 0, 1]]) {
      const image = await decodeAvatarPng(new Uint8Array(await read(item.url.replace(origin, '')))), radians = angle * Math.PI / 180;
      for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.pixels[(y * image.width + x) * 4 + 3]) {
        const dx = (x + .5 - item.grip[0]) * mirror, dy = y + .5 - item.grip[1];
        const tx = grip[0] + dx * Math.cos(radians) - dy * Math.sin(radians), ty = grip[1] + dx * Math.sin(radians) + dy * Math.cos(radians);
        assert.ok(tx >= 0 && tx <= 160 && ty >= 32 && ty <= 160, `${sex}/${armor}/${id}: full equipment silhouette fits the unchanged complete-figure view.`);
        if (id === 'trident' && y < 28) assert.ok(tx < 80, 'Outward tines stay clear of the canonical face.');
      }
    }
  }
});

test('armory, both arena facings and public attack/execution playback retain the trident identity', async () => {
  const fighters = ['male', 'female'].map(sex => character(sex)), gear = { weapon: 'trident', armor: 'medium', helmet: 'none' };
  await Promise.all(fighters.map(fighter => prepareCleanAvatar(fighter.appearance, 'battle', gear)));
  const armory = renderArmory({ character: fighters[0], gear });
  assert.deepEqual(ARMORY_WEAPON_DISPLAY.trident, { width: 26, height: 92 }); assert.match(armory, /data-value="trident" aria-pressed="true"/); assert.match(armory, /Entangle/);
  const state = createDuel(fighters.map(character => ({ character, ...gear }))), arena = renderArena(state);
  assert.equal((arena.match(/v015-equipment\/weapons\/trident\.png/g) ?? []).length, 2);
  assert.equal((arena.match(/v015-equipment\/weapons\/net\.png/g) ?? []).length, 2);
  const after = resolveRound(state, ['technique', 'strike']), steps = buildAnimationSteps(state, after);
  assert.ok(steps.find(step => step.type === 'attack' && step.actor === 0 && step.weapon === 'trident' && step.entangled));
  assert.ok(steps.filter(step => step.type !== 'stamina-regeneration').length <= 3, 'Net effect is attached to the existing attack, with no added net playback interval.');
  assert.equal(steps.filter(step => step.type === 'stamina-regeneration').length, 2);
  const won = structuredClone(state); won.status = 'complete'; won.result = { winner: 0, reason: 'knockout' };
  assert.equal(buildExecutionEvent(won, { decision: 'execute', winner: 0, loser: 1 }).weapon, 'trident');
});

test('optional offhand registration cannot redirect to outside assets', async () => {
  const baseFetch = globalThis.fetch, overlay = JSON.parse(await read('assets/clean-gladiator/v015-equipment/manifest.json'));
  overlay.weapons.trident.offhand.url = 'https://invalid.example/net.png';
  globalThis.fetch = async input => new URL(input).pathname.endsWith('v015-equipment/manifest.json') ? new Response(JSON.stringify(overlay)) : baseFetch(input);
  try { const renderer = await import('../src/arena-avatar.js?trident-invalid-offhand');
    await assert.rejects(renderer.preloadCleanArt({ equipmentManifestUrl: '/assets/clean-gladiator/v015-equipment/manifest.json' }), /preserved local asset package/);
  } finally { globalThis.fetch = baseFetch; }
});
