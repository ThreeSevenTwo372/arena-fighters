import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { avatarChoices, decodeAvatarPng } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance, presetAppearanceSignature } from '../src/face-presets.js';
import { composePresetIdentityPixels, validatePresetCatalog, getPresetIdentityDiagnostics } from '../src/preset-identity.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
const catalogPath = '/assets/clean-gladiator/v007/manifest.json';
const catalog = JSON.parse(await fs.readFile(path.join(project, `.${catalogPath}`), 'utf8'));
const sexes = ['male', 'female'], armors = ['light', 'medium', 'heavy'];
const ids = Array.from({ length: 10 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
const requests = [];
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = url => fs.readFile(path.resolve(project, `.${new URL(url, origin).pathname}`));
const image = async url => decodeAvatarPng(new Uint8Array(await bytes(url)));
const decoded = rendered => decodeAvatarPng(new Uint8Array(Buffer.from(rendered.url.split(',')[1], 'base64')));
const rgba = (picture, x, y) => picture.pixels.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4);
const appearance = (sex, facePreset = 'p01') => normalizePresetAppearance({ sex, facePreset, skin: 'ivory', hairColor: 'chestnut', eyes: 'amber' });
const config = { catalog, baseUrl: `${origin}/` };
const raw = new Map();
for (const sex of sexes) for (const id of ids) {
  const entry = catalog.facePresets[sex][id];
  raw.set(`${sex}/${id}`, { entry, head: await image(entry.url), mask: await image(entry.materialsUrl) });
}
globalThis.fetch = async input => {
  const url = new URL(input); requests.push(url.pathname);
  const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== origin || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
const main = await import('../src/arena-avatar.js?preset-main-control');
const candidate = await import('../src/arena-avatar.js?preset-candidate-control');

function componentCount(picture) {
  const seen = new Uint8Array(picture.width * picture.height); let count = 0;
  for (let p = 0; p < seen.length; p++) {
    if (seen[p] || !picture.pixels[p * 4 + 3]) continue;
    count++; seen[p] = 1; const stack = [p];
    while (stack.length) {
      const current = stack.pop(), x = current % picture.width, y = Math.floor(current / picture.width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= picture.width || ny >= picture.height) continue;
        const q = ny * picture.width + nx;
        if (!seen[q] && picture.pixels[q * 4 + 3]) { seen[q] = 1; stack.push(q); }
      }
    }
  }
  return count;
}

test('twenty source presets have distinct registered whole heads and exclusive visible material ownership', async () => {
  validatePresetCatalog(catalog, `${origin}/`);
  const allHeads = new Set();
  for (const sex of sexes) {
    assert.deepEqual(Object.keys(catalog.facePresets[sex]), ids);
    assert.deepEqual(facePresetChoices(sex).map(option => option.id), ids);
    for (const id of ids) {
      const { entry, head, mask } = raw.get(`${sex}/${id}`), label = `${sex}/${id}`;
      assert.equal(hash(await bytes(entry.url)), entry.sha256, `${label} source hash`);
      assert.equal(hash(await bytes(entry.materialsUrl)), entry.materialsSha256, `${label} material source hash`);
      assert.equal(head.width, 192); assert.equal(head.height, 160);
      assert.equal(mask.width, 192); assert.equal(mask.height, 160);
      assert.deepEqual(entry.anchor, [93, 86]); assert.equal(entry.alreadyFitted, true);
      assert.equal(componentCount(head), 1, `${label} has no detached visible pixels`);
      allHeads.add(hash(head.pixels));
      const counts = { skin: 0, hair: 0, iris: 0, white: 0, ink: 0 };
      for (let p = 0; p < 192 * 160; p++) {
        const offset = p * 4, source = head.pixels.subarray(offset, offset + 4), ownership = mask.pixels.subarray(offset, offset + 4);
        if (ownership[3]) {
          assert.equal(ownership[3], 255, `${label} mask alpha`);
          const color = ownership.subarray(0, 3).join(',');
          assert.ok(['255,0,0', '0,255,0', '0,0,255'].includes(color), `${label} assigns at most one material per pixel`);
          assert.ok(source[3] > 0, `${label} material belongs to visible artwork`);
          counts[{ '255,0,0': 'skin', '0,255,0': 'hair', '0,0,255': 'iris' }[color]]++;
        } else if (source[3]) {
          if (Math.min(...source.subarray(0, 3)) > 175) counts.white++;
          if (Math.max(...source.subarray(0, 3)) < 45) counts.ink++;
        }
      }
      assert.ok(counts.skin > 100 && counts.hair > 0 && counts.iris > 0, `${label} keeps customizable skin, hair/brows, and visible irises`);
      assert.ok(counts.white > 0 && counts.ink > 30, `${label} retains literal eye whites and facial/silhouette ink`);
    }
  }
  assert.equal(allHeads.size, 20, 'the roster contains twenty distinct drawings at the same baked palette');
});

test('default palettes reproduce every baked source RGBA without resampling', async () => {
  for (const sex of sexes) for (const id of ids) {
    const result = await composePresetIdentityPixels(appearance(sex, id), config), { head } = raw.get(`${sex}/${id}`);
    assert.deepEqual(result.pixels, head.pixels, `${sex}/${id} literal final artwork`);
    assert.equal(result.alreadyFitted, true); assert.equal(result.facePreset, id);
    assert.deepEqual(result.anchor, [93, 86]);
    assert.deepEqual(result.registration, catalog.identityTransform);
  }
});

test('each palette changes only its authored material and preserves alpha and fixed facial details', async () => {
  const fields = [['skin', 0], ['hairColor', 1], ['eyes', 2]];
  for (const sex of sexes) for (const id of ids) {
    const { head, mask } = raw.get(`${sex}/${id}`), base = appearance(sex, id);
    for (const [field, channel] of fields) {
      const images = new Set();
      for (const option of avatarChoices[field]) {
        const result = await composePresetIdentityPixels({ ...base, [field]: option.id }, config);
        images.add(hash(result.pixels));
        for (let p = 0; p < 192 * 160; p++) {
          const offset = p * 4;
          assert.equal(result.pixels[offset + 3], head.pixels[offset + 3], `${sex}/${id}/${field}/${option.id} alpha`);
          if (!mask.pixels[offset + 3] || mask.pixels[offset + channel] !== 255) {
            for (let c = 0; c < 3; c++) if (result.pixels[offset + c] !== head.pixels[offset + c]) assert.fail(`${sex}/${id}/${field}/${option.id} changed a pixel outside its source material mask at ${p % 192},${Math.floor(p / 192)}`);
          }
        }
      }
      assert.equal(images.size, avatarChoices[field].length, `${sex}/${id} each ${field} choice remains visible`);
    }
  }
  // Independent literal eye fixtures from the final PNGs, not renderer metadata.
  for (const [sex, id, x, y, color] of [
    ['male', 'p01', 91, 74, [241, 234, 235, 253]],
    ['female', 'p04', 91, 72, [234, 223, 220, 253]],
    ['male', 'p10', 89, 73, [247, 248, 246, 253]],
    ['female', 'p10', 89, 73, [215, 227, 227, 253]],
  ]) {
    const result = await composePresetIdentityPixels({ ...appearance(sex, id), skin: 'ebony', hairColor: 'silver', eyes: 'ruby' }, config);
    assert.deepEqual([...rgba(result, x, y)], color, `${sex}/${id} literal eye white remains readable under contrasting palettes`);
  }
});

test('presets keep their complete facial identity when legacy hairstyle, expression, or beard changes', async () => {
  for (const sex of sexes) for (const id of ids) {
    const { head } = raw.get(`${sex}/${id}`), base = appearance(sex, id);
    for (const field of ['hairstyle', 'eyeStyle', 'beard']) for (const option of avatarChoices[field]) {
      const result = await composePresetIdentityPixels({ ...base, [field]: option.id }, config);
      assert.deepEqual(result.pixels, head.pixels, `${sex}/${id}/${field}/${option.id} cannot replace or erase part of a finished identity`);
      assert.equal(result.appearance[field], option.id, 'legacy selection remains in the saved appearance recipe');
      assert.equal(result.appearance.facePreset, id);
    }
  }
});

test('legacy appearance migration preserves presets, palette choices, and surviving identity fields', () => {
  for (const sex of sexes) {
    for (const preset of facePresetChoices(sex).slice(0, 9)) {
      const legacy = normalizePresetAppearance({ sex, hairstyle: preset.legacyHairstyle, beard: 'trimmed_full', eyeStyle: 'sharp', skin: 'copper', hairColor: 'silver', eyes: 'jade' });
      assert.equal(legacy.facePreset, preset.id); assert.equal(legacy.hairstyle, preset.legacyHairstyle);
      assert.equal(legacy.beard, 'trimmed_full'); assert.equal(legacy.eyeStyle, 'sharp');
      assert.equal(legacy.skin, 'copper'); assert.equal(legacy.hairColor, 'silver'); assert.equal(legacy.eyes, 'jade');
      const explicit = normalizePresetAppearance({ ...legacy, facePreset: 'p10' });
      assert.equal(explicit.facePreset, 'p10');
      const changedSex = normalizePresetAppearance({ ...explicit, sex: sex === 'male' ? 'female' : 'male' });
      assert.equal(changedSex.facePreset, 'p10'); assert.equal(changedSex.beard, 'trimmed_full');
      assert.deepEqual(normalizePresetAppearance(JSON.parse(JSON.stringify(explicit))), explicit, 'saved character identity survives a JSON round trip');
    }
  }
  assert.equal(normalizePresetAppearance({ facePreset: 'unrecognized' }).facePreset, 'p01');
  assert.notEqual(presetAppearanceSignature(appearance('male', 'p01')), presetAppearanceSignature(appearance('male', 'p10')));
});

test('main catalog remains v006 while explicit and query-gated review renderers use v007', async () => {
  assert.equal((await main.preloadCleanArt()).styleVersion, 'arena-identity-v3');
  assert.equal((await candidate.preloadCleanArt({ manifestUrl: catalogPath })).identityMode, 'preset-faces-v1');
  assert.ok(requests.includes('/assets/clean-gladiator/v006/manifest.json'));
  const previousLocation = globalThis.location;
  try {
    globalThis.location = { href: `${origin}/?face-presets-review=1`, search: '?face-presets-review=1' };
    const review = await import('../src/arena-avatar.js?preset-query-control');
    assert.equal((await review.preloadCleanArt()).styleVersion, 'arena-identity-v4');
  } finally { if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation; }
});

test('creator and combat share unchanged complete figures with a registered collar and preserved lower body', async () => {
  await candidate.preloadCleanArt({ manifestUrl: catalogPath });
  const bodies = new Map();
  for (const sex of sexes) for (const armor of armors) bodies.set(`${sex}/${armor}`, await image(catalog.bodies[sex][armor].url));
  for (const sex of sexes) for (const id of ids) for (const armor of armors) {
    const a = appearance(sex, id), gear = { armor, weapon: 'sword', helmet: 'none' };
    const creator = await candidate.prepareCleanAvatar(a, 'world', gear), combat = await candidate.prepareCleanAvatar(a, 'battle', gear);
    assert.equal(creator, combat, `${sex}/${id}/${armor} uses one complete figure across screens`);
    const complete = await decoded(combat), body = bodies.get(`${sex}/${armor}`), head = raw.get(`${sex}/${id}`).head;
    assert.deepEqual(complete.pixels.subarray(88 * 192 * 4), body.pixels.subarray(88 * 192 * 4), `${sex}/${id}/${armor} never alters the shoulders below the head, hands, torso, or legs`);
    assert.deepEqual(combat.mainhandGrip, catalog.bodies[sex][armor].mainhandGrip);
    assert.deepEqual(combat.offhandGrip, catalog.bodies[sex][armor].offhandGrip);
    let directPixels = 0, collarContact = 0;
    for (let y = 0; y < 160; y++) for (let x = 0; x < 192; x++) {
      const facePixel = rgba(head, x, y), bodyPixel = rgba(body, x, y);
      if (facePixel[3] && !bodyPixel[3]) { assert.deepEqual(rgba(complete, x, y), facePixel, `${sex}/${id}/${armor} keeps literal registered source pixels`); directPixels++; }
      if (x >= 86 && x <= 103 && y >= 80 && y <= 90 && facePixel[3] >= 16 && bodyPixel[3] >= 16) collarContact++;
    }
    assert.ok(directPixels > 200, `${sex}/${id}/${armor} verifies the complete unscaled head`);
    assert.ok(collarContact > 0, `${sex}/${id}/${armor} overlaps the authored garment collar`);
    assert.ok(candidate.renderCleanAvatar(a, 'world', gear).includes('data-art-version="arena-identity-v4"'));
  }
  const first = await candidate.prepareCleanAvatar(appearance('male', 'p01'), 'world', { armor: 'medium' });
  const tenth = await candidate.prepareCleanAvatar(appearance('male', 'p10'), 'world', { armor: 'medium' });
  assert.notEqual(first, tenth); assert.notEqual(first.url, tenth.url, 'preset identity participates in the arena cache key');
});

test('full-head helmets suppress all twenty presets and restore the saved identity when removed', async () => {
  await candidate.preloadCleanArt({ manifestUrl: catalogPath });
  for (const sex of sexes) for (const helmet of ['closed_bascinet', 'barbute', 'greathelm']) {
    let coveredUrl;
    for (const id of ids) {
      const a = appearance(sex, id), gear = { armor: 'medium', weapon: 'halberd', helmet };
      const uncovered = await candidate.prepareCleanAvatar(a, 'world', { ...gear, helmet: 'none' });
      const covered = await candidate.prepareCleanAvatar({ ...a, skin: 'ebony', hairColor: 'silver', eyes: 'ruby' }, 'battle', gear);
      coveredUrl ??= covered.url;
      assert.equal(covered.url, coveredUrl, `${sex}/${helmet}/${id} has no residual hair, face, or preset-specific pixels`);
      assert.equal(covered.appearance.facePreset, id);
      assert.equal(covered.appearance.skin, 'ebony'); assert.equal(covered.appearance.hairColor, 'silver');
      const restored = await candidate.prepareCleanAvatar(a, 'battle', { ...gear, helmet: 'none' });
      assert.equal(restored, uncovered); assert.notEqual(restored.url, covered.url);
    }
  }
  const diagnostics = candidate.getCleanArtDiagnostics();
  assert.equal(diagnostics.pendingRenders, 0); assert.ok(diagnostics.renders > 0 && diagnostics.renders <= 24);
  assert.ok(diagnostics.textureBytes > 0 && diagnostics.textureBytes <= 16 * 1024 * 1024);
  assert.equal(getPresetIdentityDiagnostics().pendingSources, 0);
  assert.ok(getPresetIdentityDiagnostics().sourceTextures > 0 && getPresetIdentityDiagnostics().sourceTextures <= 24);
  assert.ok(!requests.some(url => /portrait.*\.png$/.test(url)), 'preset review does not reintroduce portrait presentation');
});
