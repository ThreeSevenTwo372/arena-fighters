import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeAvatarPng } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { composePresetIdentityPixels, validatePresetCatalog } from '../src/preset-identity.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
const candidatePath = '/assets/clean-gladiator/v008/manifest.json';
const old = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v007/manifest.json'), 'utf8'));
const catalog = JSON.parse(await fs.readFile(path.join(project, `.${candidatePath}`), 'utf8'));
const sexes = ['male', 'female'];
const ids = Array.from({ length: 10 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
const revisedIds = new Set(['p02', 'p03', 'p05', 'p08']);
const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = url => fs.readFile(path.resolve(project, `.${new URL(url, origin).pathname}`));
const image = async url => decodeAvatarPng(new Uint8Array(await bytes(url)));
const rgba = (picture, x, y) => picture.pixels.subarray((y * picture.width + x) * 4, (y * picture.width + x) * 4 + 4);
const appearance = (sex, facePreset) => normalizePresetAppearance({ sex, facePreset, skin: 'ivory', hairColor: 'chestnut', eyes: 'amber' });
const config = { catalog, baseUrl: `${origin}/` };
const entries = new Map();
for (const sex of sexes) for (const id of ids) {
  const previous = old.facePresets[sex][id], entry = catalog.facePresets[sex][id];
  entries.set(`${sex}/${id}`, {
    previous, entry,
    before: await image(previous.url), beforeMask: await image(previous.materialsUrl),
    head: await image(entry.url), mask: await image(entry.materialsUrl),
  });
}
const requests = [];
globalThis.fetch = async input => {
  const url = new URL(input); requests.push(url.pathname);
  const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== origin || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};

function components(picture) {
  const area = picture.width * picture.height, seen = new Uint8Array(area); let count = 0;
  for (let p = 0; p < area; p++) {
    if (seen[p] || !picture.pixels[p * 4 + 3]) continue;
    count++; seen[p] = 1; const queue = [p];
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i], x = q % picture.width, y = Math.floor(q / picture.width);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= picture.width || ny >= picture.height) continue;
        const next = ny * picture.width + nx;
        if (!seen[next] && picture.pixels[next * 4 + 3]) { seen[next] = 1; queue.push(next); }
      }
    }
  }
  return count;
}

test('the diversity pass preserves all twenty IDs and the original complete-figure registration', () => {
  validatePresetCatalog(catalog, `${origin}/`);
  for (const property of ['bodies', 'weapons', 'helmets', 'identityTransform', 'canvas', 'pivot', 'headOrigin', 'neckCenter']) {
    assert.deepEqual(catalog[property], old[property], `${property} is independent of face variety`);
  }
  for (const sex of sexes) {
    assert.deepEqual(Object.keys(catalog.facePresets[sex]), ids);
    for (const id of ids) {
      const { previous, entry } = entries.get(`${sex}/${id}`);
      assert.deepEqual(entry.materialDefaults, previous.materialDefaults);
      assert.deepEqual(entry.anchor, [93, 86]);
      assert.equal(entry.width, 192); assert.equal(entry.height, 160);
      assert.equal(entry.alreadyFitted, true);
    }
  }
});

test('the eight revised drawings change actual facial features while twelve controls and all collar joins stay intact', async () => {
  let revisions = 0, preserved = 0;
  for (const [label, { previous, entry, before, beforeMask, head, mask }] of entries) {
    const id = label.split('/')[1];
    if (!revisedIds.has(id)) {
      assert.equal(hash(await bytes(entry.url)), hash(await bytes(previous.url)), `${label} unchanged head source`);
      assert.equal(hash(await bytes(entry.materialsUrl)), hash(await bytes(previous.materialsUrl)), `${label} unchanged material source`);
      preserved++; continue;
    }
    revisions++;
    assert.notEqual(hash(head.pixels), hash(before.pixels), `${label} revised drawing`);
    assert.deepEqual(head.pixels.subarray(84 * 192 * 4, 87 * 192 * 4), before.pixels.subarray(84 * 192 * 4, 87 * 192 * 4), `${label} preserves the visible authored neck/collar join`);
    assert.deepEqual(mask.pixels.subarray(84 * 192 * 4, 87 * 192 * 4), beforeMask.pixels.subarray(84 * 192 * 4, 87 * 192 * 4), `${label} preserves neck material ownership`);
    let changedFacialPixels = 0;
    for (let y = 65; y < 84; y++) for (let x = 65; x <= 115; x++) {
      const offset = (y * 192 + x) * 4;
      const oldHair = beforeMask.pixels[offset + 3] && beforeMask.pixels[offset + 1] === 255;
      const newHair = mask.pixels[offset + 3] && mask.pixels[offset + 1] === 255;
      const oldFace = beforeMask.pixels[offset + 3] && (beforeMask.pixels[offset] === 255 || beforeMask.pixels[offset + 2] === 255);
      const newFace = mask.pixels[offset + 3] && (mask.pixels[offset] === 255 || mask.pixels[offset + 2] === 255);
      if (oldHair || newHair || (!oldFace && !newFace)) continue;
      if (head.pixels.subarray(offset, offset + 4).some((value, channel) => value !== before.pixels[offset + channel])) changedFacialPixels++;
    }
    assert.ok(changedFacialPixels >= 8, `${label} must change face/iris artwork, rather than only hair or a palette choice`);
  }
  assert.equal(revisions, 8); assert.equal(preserved, 12);
});

test('every candidate keeps one connected head and exclusive visible skin, hair, and iris ownership', async () => {
  for (const [label, { entry, head, mask }] of entries) {
    assert.equal(hash(await bytes(entry.url)), entry.sha256, `${label} source receipt`);
    assert.equal(hash(await bytes(entry.materialsUrl)), entry.materialsSha256, `${label} material receipt`);
    assert.equal(head.width, 192); assert.equal(head.height, 160);
    assert.equal(mask.width, 192); assert.equal(mask.height, 160);
    assert.equal(components(head), 1, `${label} has no detached visible debris`);
    const owners = new Set(); let whites = 0, facialInk = 0;
    for (let p = 0; p < 192 * 160; p++) {
      const offset = p * 4, color = head.pixels.subarray(offset, offset + 4), material = mask.pixels.subarray(offset, offset + 4);
      if (material[3]) {
        assert.equal(material[3], 255, `${label} opaque material mask`);
        const owner = material.subarray(0, 3).join(',');
        assert.ok(['255,0,0', '0,255,0', '0,0,255'].includes(owner), `${label} one material per pixel`);
        assert.ok(color[3], `${label} ownership cannot fill a transparent pixel`);
        owners.add(owner);
      } else if (color[3]) {
        const x = p % 192, y = Math.floor(p / 192);
        if (x >= 80 && x <= 105 && y >= 66 && y <= 85) {
          if (Math.min(...color.subarray(0, 3)) > 175) whites++;
          if (Math.max(...color.subarray(0, 3)) < 45) facialInk++;
        }
      }
    }
    assert.equal(owners.size, 3, `${label} retains every customizable material`);
    assert.ok(whites > 0, `${label} visible literal eye white`);
    assert.ok(facialInk > 0, `${label} retained dark facial contours`);
  }
});

test('finished candidate pixels reach runtime without a second fit and retain literal details under recoloring', async () => {
  for (const sex of sexes) for (const id of ids) {
    const label = `${sex}/${id}`, { head, mask } = entries.get(label), a = appearance(sex, id);
    const rendered = await composePresetIdentityPixels(a, config);
    assert.deepEqual(rendered.pixels, head.pixels, `${label} unscaled source parity`);
    assert.equal(rendered.alreadyFitted, true); assert.deepEqual(rendered.anchor, [93, 86]);
    for (const [field, value, channel] of [['skin', 'ebony', 0], ['hairColor', 'silver', 1], ['eyes', 'ruby', 2]]) {
      const recolored = await composePresetIdentityPixels({ ...a, [field]: value }, config); let changes = 0;
      for (let p = 0; p < 192 * 160; p++) {
        const offset = p * 4;
        assert.equal(recolored.pixels[offset + 3], head.pixels[offset + 3], `${label}/${field} silhouette`);
        const owns = mask.pixels[offset + 3] && mask.pixels[offset + channel] === 255;
        for (let c = 0; c < 3; c++) if (recolored.pixels[offset + c] !== head.pixels[offset + c]) {
          assert.ok(owns, `${label}/${field} cannot erase or recolor literal facial detail`); changes++;
        }
      }
      assert.ok(changes > 0, `${label}/${field} remains customizable`);
    }
  }
});

test('the explicit historical review renderer preserves v008 while the regular game keeps v006', async () => {
  const normal = await import('../src/arena-avatar.js?diversity-main-control');
  assert.equal((await normal.preloadCleanArt()).identityMode, 'fixed-skull-v1');
  const previousLocation = globalThis.location;
  try {
    globalThis.location = { href: `${origin}/?face-presets-review=1`, search: '?face-presets-review=1' };
    const review = await import('../src/arena-avatar.js?diversity-query-control');
    const result = await review.preloadCleanArt({ manifestUrl: candidatePath });
    assert.equal(result.identityMode, 'preset-faces-v1');
    assert.equal(result.facePresets.male.p01.url, catalog.facePresets.male.p01.url);
    assert.ok(requests.includes(candidatePath), 'explicit review renderer retains the historical versioned candidate');
    assert.ok(requests.includes('/assets/clean-gladiator/v006/manifest.json'), 'main path remains preserved');
  } finally {
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});

test('new identities retain the lower body, hand registration, collar contact, and complete helmet replacement', async () => {
  const renderer = await import('../src/arena-avatar.js?diversity-assembly-control');
  await renderer.preloadCleanArt({ manifestUrl: candidatePath });
  for (const sex of sexes) {
    for (const armor of ['light', 'medium', 'heavy']) {
      const body = await image(catalog.bodies[sex][armor].url);
      for (const id of ids) {
        const a = appearance(sex, id), { head } = entries.get(`${sex}/${id}`);
        const rendered = await renderer.prepareCleanAvatar(a, 'battle', { armor, helmet: 'none' });
        const complete = await decodeAvatarPng(new Uint8Array(Buffer.from(rendered.url.split(',')[1], 'base64')));
        assert.deepEqual(complete.pixels.subarray(100 * 192 * 4), body.pixels.subarray(100 * 192 * 4), `${sex}/${id}/${armor} preserves torso, hands, and legs below any rear hair`);
        assert.deepEqual(rendered.mainhandGrip, catalog.bodies[sex][armor].mainhandGrip);
        assert.deepEqual(rendered.offhandGrip, catalog.bodies[sex][armor].offhandGrip);
        let collarContact = 0;
        for (let y = 80; y <= 87; y++) for (let x = 86; x <= 103; x++) {
          if (rgba(head, x, y)[3] >= 16 && rgba(body, x, y)[3] >= 16) collarContact++;
        }
        assert.ok(collarContact > 0, `${sex}/${id}/${armor} has an authored garment overlap`);
      }
    }
    for (const helmet of ['closed_bascinet', 'barbute', 'greathelm']) {
      let firstUrl;
      for (const id of ids) {
        const covered = await renderer.prepareCleanAvatar(appearance(sex, id), 'battle', { armor: 'medium', helmet });
        firstUrl ??= covered.url;
        assert.equal(covered.url, firstUrl, `${sex}/${id}/${helmet} suppresses the entire head identity`);
        assert.equal(covered.appearance.facePreset, id);
      }
    }
  }
});
