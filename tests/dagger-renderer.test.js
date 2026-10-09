import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodeAvatarPng, normalizeAppearance } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { preloadCleanArt, prepareCleanAvatar, renderCleanAvatar } from '../src/current-avatar.js';
import { renderArmory, ARMORY_WEAPON_DISPLAY } from '../src/armory.js';
import { renderArena } from '../src/arena.js';
import { createDuel } from '../src/combat.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
const read = url => fs.readFile(path.join(root, url.replace(/^\//, '')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
globalThis.fetch = async input => {
  const url = new URL(input), target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== origin || !target.startsWith(`${root}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};

test('the new dagger is exact authored integer artwork with a connected opaque grip', async () => {
  const directory = 'assets/clean-gladiator/v014-equipment/';
  const sourceBytes = await read(`${directory}dagger.source.json`), source = JSON.parse(sourceBytes);
  const receipt = JSON.parse(await read(`${directory}PREPARATION_RECEIPT.json`));
  const bytes = await read(`${directory}weapons/dagger.png`), image = await decodeAvatarPng(new Uint8Array(bytes));
  assert.equal(hash(sourceBytes), receipt.sourceSha256);
  assert.equal(hash(bytes), receipt.textureSha256);
  assert.equal(hash(await read(`${directory}dagger.source.svg`)), receipt.sourceSvgSha256);
  assert.deepEqual([image.width, image.height], [16, 36]);
  const expected = new Uint8Array(image.pixels.length), occupied = new Set();
  for (const row of source.rows) for (const [offset, code] of [...row.cells].entries()) {
    const index = row.y * image.width + row.x + offset;
    assert.ok(!occupied.has(index)); occupied.add(index);
    expected.set(source.palette[code].rgba, index * 4);
  }
  assert.deepEqual(image.pixels, expected, 'The PNG contains each authored cell without resampling or material inference.');
  const todo = [occupied.values().next().value], connected = new Set(todo);
  while (todo.length) { const index = todo.pop(), x = index % image.width, y = Math.floor(index / image.width);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const tx = x + dx, ty = y + dy, next = ty * image.width + tx;
      if (tx >= 0 && ty >= 0 && tx < image.width && ty < image.height && occupied.has(next) && !connected.has(next)) { connected.add(next); todo.push(next); }
    }
  }
  assert.equal(connected.size, occupied.size, 'The blade, guard, grip and pommel are one connected silhouette.');
  assert.equal(image.pixels[(29 * 16 + 7) * 4 + 3], 255);
  assert.equal(source.provenance.providerCalls, 0);
});

test('dagger admission merges equipment while both historical source catalogs stay independent', async () => {
  const current = await preloadCleanArt();
  assert.deepEqual(current.weapons.dagger.grip, [7, 29]);
  assert.equal(current.weapons.dagger.url, '/assets/clean-gladiator/v014-equipment/weapons/dagger.png');
  assert.equal(current.equipmentRevision, 'trident-net-v001');
  for (const version of ['v006', 'v013']) {
    const original = JSON.parse(await read(`assets/clean-gladiator/${version}/manifest.json`));
    assert.equal(original.weapons.dagger, undefined);
    const historic = await import(`../src/arena-avatar.js?dagger-control-${version}`);
    const control = await historic.preloadCleanArt({ manifestUrl: `/assets/clean-gladiator/${version}/manifest.json` });
    assert.equal(control.weapons.dagger, undefined, 'Old catalogs still validate without a new required weapon.');
    for (const weapon of ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'shield']) assert.deepEqual(control.weapons[weapon], original.weapons[weapon]);
  }
});

test('both saved legacy and current preset figures attach the dagger without changing body, head, hands, or rig', async () => {
  for (const sex of ['male', 'female']) for (const preset of [false, true]) for (const armor of ['light', 'medium', 'heavy']) {
    const appearance = preset ? normalizePresetAppearance({ sex, facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' }) : normalizeAppearance({ sex, hairstyle: 'shag', skin: 'ivory', hairColor: 'chestnut' });
    const before = structuredClone(appearance), gear = { armor, helmet: 'none', weapon: 'dagger' };
    const [dagger, sword] = await Promise.all([prepareCleanAvatar(appearance, 'battle', gear), prepareCleanAvatar(appearance, 'battle', { ...gear, weapon: 'sword' })]);
    assert.equal(dagger.weapon, 'dagger');
    assert.equal(dagger.url, sword.url, `${sex}/${preset}/${armor}: the complete body/head bitmap stays exact`);
    for (const field of ['mainhandGrip', 'offhandGrip', 'handsImage', 'identityTransform', 'identityOffset', 'assembledIdentityAnchor', 'pivot']) assert.deepEqual(dagger[field], sword[field], field);
    assert.equal(dagger.weaponAngle, sword.weaponAngle); assert.equal(dagger.weaponMirror, sword.weaponMirror);
    assert.deepEqual(appearance, before);
    const output = renderCleanAvatar(appearance, 'world', gear);
    assert.match(output, /v014-equipment\/weapons\/dagger\.png/);
    assert.match(output, /x="-7" y="-29" width="16" height="36"/);
    assert.match(output, /viewBox="0 32 160 128"/);
    // Bound every actual authored weapon cell in the complete native preview.
    const image = await decodeAvatarPng(new Uint8Array(await read(dagger.weaponImage.url.replace(origin, ''))));
    const radians = dagger.weaponAngle * Math.PI / 180;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.pixels[(y * image.width + x) * 4 + 3]) {
      const dx = (x + .5 - 7) * dagger.weaponMirror, dy = y + .5 - 29;
      const tx = dagger.mainhandGrip[0] + dx * Math.cos(radians) - dy * Math.sin(radians), ty = dagger.mainhandGrip[1] + dx * Math.sin(radians) + dy * Math.cos(radians);
      assert.ok(tx >= 0 && tx <= 160 && ty >= 32 && ty <= 160, `${sex}/${armor}: dagger remains inside the whole-figure view`);
    }
  }
});

test('armory and both arena facings use the same registered dagger texture', async () => {
  const appearances = ['male', 'female'].map(sex => normalizePresetAppearance({ sex, facePreset: 'p05' }));
  const gear = { weapon: 'dagger', armor: 'medium', helmet: 'none' };
  await Promise.all(appearances.map(appearance => prepareCleanAvatar(appearance, 'battle', gear)));
  const characters = appearances.map((appearance, index) => ({ name: index ? 'Mira' : 'Cassian', appearance, color: '#b45143', trait: 'balanced', stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 } }));
  const armory = renderArmory({ character: characters[0], gear });
  assert.deepEqual(ARMORY_WEAPON_DISPLAY.dagger, { width: 16, height: 36 });
  assert.match(armory, /data-value="dagger" aria-pressed="true"/);
  assert.match(armory, /\+2 initiative/); assert.match(armory, /Strike 3 stamina/); assert.match(armory, /Technique 5 stamina/); assert.match(armory, /Riposte/);
  const arena = renderArena(createDuel(characters.map(character => ({ character, ...gear }))));
  assert.equal((arena.match(/v014-equipment\/weapons\/dagger\.png/g) ?? []).length, 2);
  assert.equal((arena.match(/x="-7" y="-29" width="16" height="36"/g) ?? []).length, 2);
});

test('the optional overlay rejects external paths and replacements of preserved weapons', async () => {
  const outside = await import('../src/arena-avatar.js?dagger-invalid-origin');
  await assert.rejects(outside.preloadCleanArt({ equipmentManifestUrl: 'https://invalid.example/assets/clean-gladiator/v014-equipment/manifest.json' }), /local versioned equipment/);
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async input => new URL(input).pathname.endsWith('v014-equipment/manifest.json') ? new Response(JSON.stringify({ schema: 'last-laurel.arena-equipment.v1', compatibleIdentityCatalogs: ['v006'], weapons: { sword: {} } })) : baseFetch(input);
  try {
    const replacement = await import('../src/arena-avatar.js?dagger-invalid-replacement');
    await assert.rejects(replacement.preloadCleanArt({ equipmentManifestUrl: '/assets/clean-gladiator/v014-equipment/manifest.json' }), /cannot replace a preserved weapon/);
  } finally { globalThis.fetch = baseFetch; }
});
