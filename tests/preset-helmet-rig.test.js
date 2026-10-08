import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAvatarPng, encodeAvatarPng } from '../src/avatar.js';
import { validatePresetCatalog } from '../src/preset-identity.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
const catalog = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v012/manifest.json'), 'utf8'));
const rig = scale => ({ scale, sourceAnchor: [96, 86], targetAnchor: [93, 86] });
const candidate = { ...structuredClone(catalog), identityOffsetBySex: { male: [0, 3], female: [0, 3] }, helmetTransformBySex: { male: rig(.84), female: rig(.756) } };
const emptyUrl = '/assets/clean-gladiator/v013/helmet-rig-empty.png';
const empty = await encodeAvatarPng(192, 160, new Uint8Array(192 * 160 * 4));
const fixtures = new Map([[emptyUrl, empty]]);
globalThis.fetch = async input => {
  const url = new URL(input), file = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== origin || !file.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  if (fixtures.has(url.pathname)) return new Response(fixtures.get(url.pathname));
  try { return new Response(await fs.readFile(file)); } catch { return new Response('', { status: 404 }); }
};
async function isolated(name, data, version) {
  const fixture = structuredClone(data);
  for (const sex of ['male', 'female']) for (const armor of ['light', 'medium', 'heavy']) {
    fixture.bodies[sex][armor].url = emptyUrl; fixture.bodies[sex][armor].handsUrl = emptyUrl;
  }
  const manifestUrl = `/assets/clean-gladiator/v${version}/manifest.json`;
  fixtures.set(manifestUrl, JSON.stringify(fixture));
  const renderer = await import(`../src/arena-avatar.js?helmet-rig-${name}`);
  await renderer.preloadCleanArt({ manifestUrl });
  return renderer;
}
const renderer = await isolated('candidate', candidate, 911);
const previous = await isolated('previous', catalog, 912);
const fallback = await isolated('fallback', { ...structuredClone(catalog), helmetTransformBySex: { male: rig(.84), female: rig(.84) } }, 913);
const decodePrepared = result => decodeAvatarPng(new Uint8Array(Buffer.from(result.url.split(',')[1], 'base64')));

test('optional helmet rigs require complete bounded source transforms and leave historical catalogs valid', () => {
  assert.equal(validatePresetCatalog(catalog), catalog);
  assert.equal(validatePresetCatalog(candidate), candidate);
  for (const invalid of [null, [], {}, { male: rig(.84) }, { male: rig(.84), female: rig(.756), other: rig(.84) },
    { male: rig(.84), female: rig(.49) }, { male: rig(.84), female: rig(1.01) },
    { male: rig(.84), female: { ...rig(.756), scale: '0.756' } },
    { male: rig(.84), female: { ...rig(.756), targetAnchor: [93, 86.5] } },
    { male: rig(.84), female: { ...rig(.756), sourceAnchor: [192, 86] } },
    { male: rig(.84), female: { ...rig(.756), targetAnchor: [93] } }]) {
    assert.throws(() => validatePresetCatalog({ ...candidate, helmetTransformBySex: invalid }), /bounded complete socket rigs/);
  }
});

test('each replacement helmet samples its original source exactly once at the combined sex scale and final offset', async () => {
  for (const sex of ['male', 'female']) for (const helmet of ['closed_bascinet', 'barbute', 'greathelm']) {
    const entry = candidate.helmets[helmet];
    const source = await decodeAvatarPng(new Uint8Array(await fs.readFile(path.join(project, `.${entry.url}`))));
    const scale = sex === 'female' ? .756 : .84, expected = new Uint8Array(192 * 160 * 4);
    // Independent inverse map from final native centers directly into the
    // original helmet, combining the one fit and the three-row translation.
    for (let y = 3; y < 160; y++) for (let x = 0; x < 192; x++) {
      const sx = Math.floor(96 + (x + .5 - 93) / scale);
      const sy = Math.floor(86 + (y + .5 - 89) / scale);
      if (sx < 0 || sy < 0 || sx >= 192 || sy >= 160) continue;
      const offset = (sy * 192 + sx) * 4;
      // Transparent source RGB is not visible paint and the body overlay
      // retains its empty pixel at that position.
      if (source.pixels[offset + 3]) expected.set(source.pixels.subarray(offset, offset + 4), (y * 192 + x) * 4);
    }
    for (const armor of ['light', 'medium', 'heavy']) {
      const result = await renderer.prepareCleanAvatar({ sex, facePreset: 'p05', skin: 'ebony', hairColor: 'silver', eyes: 'jade' }, 'battle', { armor, helmet });
      assert.deepEqual((await decodePrepared(result)).pixels, expected, `${sex}/${armor}/${helmet} equals original source sampled once`);
      assert.deepEqual(result.helmetTransform, rig(scale));
      assert.deepEqual(result.identityTransform, catalog.identityTransform, 'the common historical rig metadata remains preserved');
      assert.deepEqual(result.identityOffset, [0, 3]); assert.deepEqual(result.assembledIdentityAnchor, [93, 89]);
      const other = await renderer.prepareCleanAvatar({ sex, facePreset: 'p10', skin: 'porcelain', hairColor: 'chestnut', eyes: 'amber' }, 'battle', { armor, helmet });
      assert.equal(other.url, result.url, 'a complete helmet hides every underlying preset and palette');
    }
  }
});

test('an absent sex helmet rig retains the exact former helmet pixels and never rescales prepared heads', async () => {
  for (const sex of ['male', 'female']) for (const helmet of ['none', 'closed_bascinet', 'barbute', 'greathelm']) {
    const a = { sex, facePreset: 'p05' }, gear = { armor: 'medium', helmet };
    const before = await previous.prepareCleanAvatar(a, 'battle', gear), explicit = await fallback.prepareCleanAvatar(a, 'battle', gear);
    assert.equal(explicit.url, before.url, 'declaring the historical fit equals the absent-field fallback');
    if (helmet === 'none') {
      const current = await renderer.prepareCleanAvatar(a, 'battle', gear).then(decodePrepared);
      const old = await decodePrepared(before);
      const rows = sex === 'male' ? 3 * 192 * 4 : 0;
      assert.deepEqual(current.pixels.subarray(rows), old.pixels.subarray(0, old.pixels.length - rows), 'uncovered preset receives only its integer seating offset');
    }
  }
});
