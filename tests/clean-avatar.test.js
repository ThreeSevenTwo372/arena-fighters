import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeAvatarHeadPixels, decodeAvatarPng, encodeAvatarPng, normalizeAppearance } from '../src/avatar.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let instance = 0;
async function fixture(change = () => {}) {
  const pixels = new Uint8Array(192 * 160 * 4);
  // Keep the head area empty; the sole opaque body strip exercises exact RGBA.
  for (let y = 146; y < 152; y++) for (let x = 80; x < 112; x++) pixels.set([48, 67, 86, x === 80 ? 128 : 255], (y * 192 + x) * 4);
  const body = await encodeAvatarPng(192, 160, pixels);
  const gearPixels = new Uint8Array(8 * 12 * 4);
  for (let y = 0; y < 12; y++) gearPixels.set([162, 188, 201, 255], (y * 8 + 3) * 4);
  const gear = await encodeAvatarPng(8, 12, gearPixels);
  const manifest = {
    styleVersion: 'clean-v1', canvas: [192, 160], headOrigin: [64, 36], pivot: [96, 152], mainhandGrip: [70, 111], offhandGrip: [106, 113],
    bodies: Object.fromEntries(['male', 'female'].map(sex => [sex, Object.fromEntries(['light', 'medium', 'heavy'].map(armor => [armor, { url: `${sex}-${armor}.png`, width: 192, height: 160 }]))])),
    weapons: Object.fromEntries(['sword', 'spear', 'axe', 'shield'].map(name => [name, { url: `${name}.png`, width: 8, height: 12, grip: [3, 10] }])),
  };
  change(manifest);
  const files = new Map();
  for (const sex of ['male', 'female']) for (const armor of ['light', 'medium', 'heavy']) files.set(`/assets/clean-gladiator/v003/${sex}-${armor}.png`, body);
  for (const name of ['sword', 'spear', 'axe', 'shield']) files.set(`/assets/clean-gladiator/v003/${name}.png`, gear);
  files.set('/assets/clean-gladiator/v003/hands.png', body);
  const fetches = [];
  globalThis.fetch = async input => {
    const url = new URL(input); fetches.push(url.href);
    if (url.pathname === '/assets/clean-gladiator/v003/manifest.json') return new Response(JSON.stringify(manifest));
    if (files.has(url.pathname)) return new Response(files.get(url.pathname));
    const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
    try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
  };
  const renderer = await import(`../src/clean-avatar.js?fixture=${++instance}`);
  return { renderer, pixels, fetches, manifest };
}
const decodePrepared = async image => decodeAvatarPng(new Uint8Array(Buffer.from(image.url.split(',')[1], 'base64')));

test('legacy clean-v1 catalogs preserve original identity pixels for both sexes and palette extremes', async () => {
  const { renderer, pixels } = await fixture();
  for (const sex of ['male', 'female']) for (const skin of ['porcelain', 'ebony']) {
    const appearance = normalizeAppearance({ sex, skin, hairstyle: 'braided_ponytail', hairColor: skin === 'porcelain' ? 'raven' : 'silver', eyes: 'jade', beard: 'trimmed_full' });
    const original = await composeAvatarHeadPixels(appearance, { direction: 'W', canvas: [192, 160], headOrigin: [64, 36] });
    const prepared = await renderer.prepareCleanAvatar(appearance, 'battle', { weapon: 'axe', armor: 'heavy' });
    const result = await decodePrepared(prepared);
    let visibleHeadPixels = 0;
    for (let index = 0; index < original.pixels.length; index += 4) if (original.pixels[index + 3]) {
      assert.equal(pixels[index + 3], 0, 'fixture body must not cover identity');
      assert.deepEqual(result.pixels.subarray(index, index + 4), original.pixels.subarray(index, index + 4), `${sex}/${skin} identity pixel ${index / 4}`);
      visibleHeadPixels++;
    }
    assert.ok(visibleHeadPixels > 400);
    const foot = (150 * 192 + 80) * 4;
    assert.deepEqual([...result.pixels.subarray(foot, foot + 4)], [48, 67, 86, 128]);
    assert.equal(prepared.appearance.skin, skin);
    assert.equal(prepared.appearance.sex, sex);
  }
});

test('weapons stay separate from the body and authored grips survive preparation', async () => {
  const { renderer } = await fixture(manifest => {
    manifest.bodies.male.medium.mainhandGrip = [73, 114];
    manifest.bodies.male.medium.offhandGrip = [104, 115];
    manifest.bodies.male.medium.handsUrl = 'hands.png';
  });
  const appearance = Object.freeze(normalizeAppearance({ hairstyle: 'short_swept' }));
  const sword = await renderer.prepareCleanAvatar(appearance, 'battle', Object.freeze({ weapon: 'sword', armor: 'medium' }));
  const spear = await renderer.prepareCleanAvatar(appearance, 'battle', { weapon: 'spear', armor: 'medium' });
  assert.equal(sword.url, spear.url, 'equipment changes its own layer, never the identity pixels');
  assert.notEqual(sword.weaponImage.url, spear.weaponImage.url);
  assert.deepEqual(sword.mainhandGrip, [73, 114]);
  assert.deepEqual(sword.offhandGrip, [104, 115]);
  assert.deepEqual(sword.weaponImage.grip, [3, 10]);
  assert.ok(sword.handsImage.url.endsWith('/hands.png'));
  assert.equal(sword.nativeWeapon, false);
  assert.equal(sword.sourceFacing, 'W');
  assert.throws(() => { sword.mainhandGrip[0] = 1; }, TypeError);
  assert.throws(() => { sword.weaponImage.grip[0] = 1; }, TypeError);
});

test('idle aliases share prepared artwork and preview labels are escaped', async () => {
  const { renderer } = await fixture();
  const gear = { armor: 'medium', weapon: 'sword' };
  const prepared = await renderer.prepareCleanAvatar({}, 'world', gear);
  assert.equal(renderer.getCleanAvatarImage({}, 'idle', gear), prepared);
  const markup = renderer.renderCleanAvatar({}, 'world', gear, { alt: '" onload="bad()<script>' });
  assert.ok(markup.includes('class="linked-avatar clean-avatar clean-avatar--world"'));
  assert.ok(markup.includes('&quot; onload=&quot;bad()&lt;script&gt;'));
  assert.ok(!markup.includes('<script>'));
  assert.ok(markup.includes('clean-mainhand'));
  assert.ok(markup.includes('clean-shield'));
});

test('outside URLs and invalid registration fail before loading any textures', async () => {
  for (const change of [
    manifest => { manifest.weapons.spear.url = 'https://outside.example/spear.png'; },
    manifest => { manifest.bodies.female.light.url = '../outside.png'; },
    manifest => { manifest.weapons.axe.url = '%2e%2e/outside.png'; },
    manifest => { manifest.weapons.shield.grip = [80, 10]; },
    manifest => { manifest.bodies.male.light.mainhandGrip = [-1, 111]; },
  ]) {
    const { renderer, fetches } = await fixture(change);
    await assert.rejects(renderer.preloadCleanArt(), /outside|invalid/);
    assert.equal(fetches.length, 1);
  }
  const { renderer, fetches } = await fixture();
  await assert.rejects(renderer.preloadCleanArt({ manifestUrl: 'https://outside.example/manifest.json' }), /outside/);
  assert.equal(fetches.length, 0);
});

test('mislabeled texture dimensions are rejected instead of stretching the equipment', async () => {
  const { renderer } = await fixture(manifest => { manifest.weapons.sword.width = 9; });
  await assert.rejects(renderer.prepareCleanAvatar({}, 'battle'), /dimensions disagree/);
});

test('in-flight requests deduplicate and the render cache remains bounded', async () => {
  const { renderer, fetches } = await fixture();
  const [first, second] = await Promise.all([renderer.prepareCleanAvatar({}, 'world'), renderer.prepareCleanAvatar({}, 'world')]);
  assert.equal(first, second);
  assert.equal(fetches.filter(url => url.endsWith('/male-light.png')).length, 1);
  for (const sex of ['male', 'female']) for (const hairColor of ['raven', 'chestnut', 'auburn', 'ashen', 'silver', 'wheat', 'wine', 'indigo']) for (const skin of ['porcelain', 'ebony']) await renderer.prepareCleanAvatar({ sex, hairColor, skin }, 'battle');
  const diagnostics = renderer.getCleanArtDiagnostics();
  assert.equal(diagnostics.renders, 24);
  assert.equal(diagnostics.pendingRenders, 0);
  assert.ok(diagnostics.textureBytes < 16 * 1024 * 1024);
});
