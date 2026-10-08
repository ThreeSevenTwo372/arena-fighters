import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeAvatarPng, encodeAvatarPng } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { composePresetIdentityPixels, validatePresetCatalog } from '../src/preset-identity.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
const candidatePath = '/assets/clean-gladiator/v012/manifest.json';
const originalPath = '/assets/clean-gladiator/v011/manifest.json';
const bytes = url => fs.readFile(path.resolve(project, `.${new URL(url, origin).pathname}`));
const catalog = JSON.parse(await bytes(candidatePath));
const original = JSON.parse(await bytes(originalPath));
const hash = value => createHash('sha256').update(value).digest('hex');
const decode = async url => decodeAvatarPng(new Uint8Array(await bytes(url)));
const decodePrepared = result => decodeAvatarPng(new Uint8Array(Buffer.from(result.url.split(',')[1], 'base64')));
const rgba = (image, x, y) => image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
const sexes = ['male', 'female'];
const armors = ['light', 'medium', 'heavy'];
const helmets = ['closed_bascinet', 'barbute', 'greathelm'];
const ids = Array.from({ length: 10 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
const appearance = (sex, facePreset, palette = {}) => normalizePresetAppearance({ sex, facePreset, skin: 'ivory', hairColor: 'chestnut', eyes: 'amber', ...palette });
const requests = [];
const fixtures = new Map();
const emptyUrl = '/assets/clean-gladiator/v012/placement-empty.png';
const empty = await encodeAvatarPng(192, 160, new Uint8Array(192 * 160 * 4));
fixtures.set(emptyUrl, empty);
globalThis.fetch = async input => {
  const url = new URL(input); requests.push(url.pathname);
  if (url.origin !== origin) return new Response('', { status: 403 });
  if (fixtures.has(url.pathname)) return new Response(fixtures.get(url.pathname));
  const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (!target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
function isolatedManifest(source) {
  const copy = structuredClone(source);
  for (const sex of sexes) for (const armor of armors) {
    copy.bodies[sex][armor].url = emptyUrl;
    copy.bodies[sex][armor].handsUrl = emptyUrl;
  }
  return copy;
}
async function renderer(name, data, version) {
  const manifestUrl = `/assets/clean-gladiator/v${version}/manifest.json`;
  fixtures.set(manifestUrl, JSON.stringify(data));
  const result = await import(`../src/arena-avatar.js?placement-${name}`);
  await result.preloadCleanArt({ manifestUrl });
  return result;
}
const sourceRenderer = await renderer('source', isolatedManifest(original), 901);
const isolated = await renderer('isolated', isolatedManifest(catalog), 902);
const baseline = await renderer('baseline', original, 903);
const assembled = await renderer('assembled', catalog, 904);

test('the female socket correction changes metadata while retaining every source head, mask and equipment entry', async () => {
  validatePresetCatalog(catalog, `${origin}/`);
  assert.deepEqual(catalog.identityOffsetBySex, { male: [0, 0], female: [0, 3] });
  assert.equal(catalog.identitySourceCatalog, originalPath);
  for (const property of ['facePresets', 'bodies', 'weapons', 'helmets', 'identityTransform', 'canvas', 'pivot', 'headOrigin', 'neckCenter']) {
    assert.deepEqual(catalog[property], original[property], `${property} retains the actual original artwork and registration`);
  }
  for (const sex of sexes) for (const id of ids) {
    const entry = catalog.facePresets[sex][id];
    assert.equal(hash(await bytes(entry.url)), entry.sha256);
    assert.equal(hash(await bytes(entry.materialsUrl)), entry.materialsSha256);
    const source = await composePresetIdentityPixels(appearance(sex, id), { catalog, baseUrl: `${origin}/` });
    assert.deepEqual(source.pixels, (await decode(entry.url)).pixels, 'the baked source is not shifted, resized or recolored during preparation');
    assert.deepEqual(source.anchor, [93, 86]); assert.equal(source.alreadyFitted, true);
  }
});

test('optional placement rejects fractional, incomplete and excessive offsets and preserves the original fallback', () => {
  assert.equal(validatePresetCatalog(original), original);
  const valid = structuredClone(original);
  valid.identityOffsetBySex = { male: [-4, 4], female: [4, -4] };
  assert.equal(validatePresetCatalog(valid), valid);
  for (const invalid of [null, [], {}, { male: [0, 0] }, { male: [0, 0], female: [0, 3], other: [0, 0] },
    { male: [0, 0], female: [0, 1.5] }, { male: [0, 0], female: [0, 5] }, { male: [0, 0], female: [0, -5] },
    { male: [0, 0], female: ['0', 3] }, { male: [0, 0], female: [0, 3, 0] }]) {
    assert.throws(() => validatePresetCatalog({ ...original, identityOffsetBySex: invalid }), /bounded integer pairs/);
  }
});

test('all ten female identities move by exactly three rows without losing any authored face or hair pixels', async () => {
  for (const sex of sexes) for (const id of ids) {
    const a = appearance(sex, id);
    const before = await sourceRenderer.prepareCleanAvatar(a, 'battle', { armor: 'medium' });
    const result = await isolated.prepareCleanAvatar(a, 'battle', { armor: 'medium' });
    const source = await decodePrepared(before), moved = await decodePrepared(result);
    const dy = sex === 'female' ? 3 : 0, rows = dy * 192 * 4;
    assert.deepEqual(moved.pixels.subarray(rows), source.pixels.subarray(0, source.pixels.length - rows), `${sex}/${id}: every source RGBA moves intact`);
    assert.deepEqual(moved.pixels.subarray(0, rows), new Uint8Array(rows));
    assert.deepEqual(source.pixels.subarray(source.pixels.length - rows), new Uint8Array(rows), 'only transparent margins leave the frame');
    assert.deepEqual(result.identityOffset, [0, dy]);
    assert.deepEqual(result.assembledIdentityAnchor, [93, 86 + dy]);
    assert.deepEqual(result.identityTransform, original.identityTransform, 'the previous fit is never applied again');
    if (sex === 'male') assert.equal(result.url, before.url);
  }
});

test('literal eye whites, braid bindings and extreme palettes retain exact identity colors after seating', async () => {
  const literal = [
    { id: 'p05', cell: [88, 72], expected: [245, 233, 211, 255] },
    { id: 'p05', cell: [107, 79], expected: [87, 57, 44, 255] },
    { id: 'p05', cell: [106, 80], expected: [67, 43, 35, 255] },
  ];
  for (const palette of [{ skin: 'porcelain', hairColor: 'silver', eyes: 'jade' }, { skin: 'ebony', hairColor: 'raven', eyes: 'amber' }]) {
    for (const id of ['p02', 'p05', 'p07', 'p10']) {
      const a = appearance('female', id, palette);
      const source = await sourceRenderer.prepareCleanAvatar(a, 'battle', { armor: 'medium' }).then(decodePrepared);
      const moved = await isolated.prepareCleanAvatar(a, 'battle', { armor: 'medium' }).then(decodePrepared);
      assert.deepEqual(moved.pixels.subarray(3 * 192 * 4), source.pixels.subarray(0, 157 * 192 * 4));
      for (const fixture of literal.filter(row => row.id === id)) {
        assert.deepEqual([...rgba(moved, fixture.cell[0], fixture.cell[1] + 3)], fixture.expected, 'fixed paint stays literal at the moved landmark');
      }
    }
  }
});

test('all thirty female outfit assemblies keep the same head placement and the original body, hands and equipment', async () => {
  for (const id of ids) for (const armor of armors) {
    const a = appearance('female', id), gear = { armor, weapon: 'halberd', helmet: 'none' };
    const result = await assembled.prepareCleanAvatar(a, 'battle', gear);
    const complete = await decodePrepared(result);
    const head = await isolated.prepareCleanAvatar(a, 'battle', gear).then(decodePrepared);
    const body = await decode(catalog.bodies.female[armor].url);
    assert.deepEqual(result.identityOffset, [0, 3]); assert.deepEqual(result.assembledIdentityAnchor, [93, 89]);
    assert.deepEqual(result.mainhandGrip, catalog.bodies.female[armor].mainhandGrip);
    assert.deepEqual(result.offhandGrip, catalog.bodies.female[armor].offhandGrip);
    const previous = await baseline.prepareCleanAvatar(a, 'battle', gear);
    for (const property of ['handsImage', 'weaponImage', 'shieldImage', 'weaponAngle', 'weaponMirror', 'pivot', 'width', 'height']) assert.deepEqual(result[property], previous[property]);
    for (let p = 0; p < 192 * 160; p++) {
      const offset = p * 4, alpha = head.pixels[offset + 3];
      if (!alpha) assert.deepEqual(complete.pixels.subarray(offset, offset + 4), body.pixels.subarray(offset, offset + 4), 'uncovered garment/body is exactly preserved');
      else if (alpha === 255 || !body.pixels[offset + 3]) assert.deepEqual(complete.pixels.subarray(offset, offset + 4), head.pixels.subarray(offset, offset + 4), 'visible authored identity pixels are exact');
    }
    assert.ok(assembled.renderCleanAvatar(a, 'world', gear).includes(result.url), 'all displays use the same already seated whole-figure image');
    assert.equal(await assembled.prepareCleanAvatar(a, 'world', gear), result);
  }
});

test('all three replacement helmets share the female group translation and suppress every saved face across all outfits', async () => {
  for (const sex of sexes) for (const helmet of helmets) for (const armor of armors) {
    const a = appearance(sex, 'p05'), gear = { armor, helmet };
    const before = await sourceRenderer.prepareCleanAvatar(a, 'battle', gear).then(decodePrepared);
    const result = await isolated.prepareCleanAvatar(a, 'battle', gear);
    const moved = await decodePrepared(result), rows = (sex === 'female' ? 3 : 0) * 192 * 4;
    assert.deepEqual(moved.pixels.subarray(rows), before.pixels.subarray(0, before.pixels.length - rows), `${sex}/${armor}/${helmet} moves the complete already-fitted helmet once`);
    const variants = [];
    for (const id of ['p01', 'p05', 'p10']) variants.push(await assembled.prepareCleanAvatar(appearance(sex, id, { skin: 'ebony', hairColor: 'silver', eyes: 'jade' }), 'battle', gear));
    assert.equal(new Set(variants.map(image => image.url)).size, 1, 'closed helmets hide the complete head and long hair');
    assert.deepEqual(variants.map(image => image.appearance.facePreset), ['p01', 'p05', 'p10'], 'identity remains saved under the replacement helmet');
    if (sex === 'male') {
      const old = await baseline.prepareCleanAvatar(a, 'battle', gear), current = await assembled.prepareCleanAvatar(a, 'battle', gear);
      assert.equal(current.url, old.url, 'male helmet assembly is unchanged');
    }
  }
});

test('translation rejects a nontransparent edge instead of silently clipping source art', async () => {
  const data = isolatedManifest(catalog), pixels = new Uint8Array(192 * 160 * 4);
  pixels.set([21, 22, 23, 255], (159 * 192 + 93) * 4);
  const url = '/assets/clean-gladiator/v012/faces/placement-edge.png';
  const maskUrl = '/assets/clean-gladiator/v012/faces/placement-edge-materials.png';
  fixtures.set(url, await encodeAvatarPng(192, 160, pixels));
  fixtures.set(maskUrl, empty);
  data.facePresets.female.p05.url = url; data.facePresets.female.p05.materialsUrl = maskUrl;
  const edge = await renderer('clip-edge', data, 905);
  await assert.rejects(edge.prepareCleanAvatar(appearance('female', 'p05')), /clip authored pixels/);
});

test('the historical v012 male figures stay byte-exact and its explicit catalog retains the female socket', async () => {
  for (const id of ids) for (const armor of armors) {
    const a = appearance('male', id), gear = { armor };
    const previous = await baseline.prepareCleanAvatar(a, 'battle', gear), current = await assembled.prepareCleanAvatar(a, 'battle', gear);
    assert.equal(current.url, previous.url, 'male composed body/head remains byte-identical');
  }
  const previousLocation = globalThis.location;
  try {
    delete globalThis.location;
    const normal = await import('../src/arena-avatar.js?placement-main-route');
    assert.equal((await normal.preloadCleanArt()).identityMode, 'fixed-skull-v1');
    const main = await normal.prepareCleanAvatar({ sex: 'female', hairstyle: 'braided_ponytail' });
    assert.deepEqual(main.identityOffset, [0, 0]); assert.deepEqual(main.assembledIdentityAnchor, [93, 86]);
    globalThis.location = { href: `${origin}/?face-presets-review=1`, search: '?face-presets-review=1' };
    const review = await import('../src/arena-avatar.js?placement-review-route');
    const active = await review.preloadCleanArt({ manifestUrl: candidatePath });
    assert.deepEqual(active.identityOffsetBySex, { male: [0, 0], female: [0, 3] });
    assert.ok(requests.includes(candidatePath)); assert.ok(requests.includes('/assets/clean-gladiator/v006/manifest.json'));
  } finally {
    if (previousLocation === undefined) delete globalThis.location; else globalThis.location = previousLocation;
  }
});
