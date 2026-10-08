import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarChoices, encodeAvatarPng, decodeAvatarPng } from '../src/avatar.js';
import { classifyDarkIdentityMaterial, recolorDarkIdentityPixels, preloadDarkIdentity, composeDarkIdentityPixels, prepareDarkIdentity, getDarkIdentityImage, renderDarkIdentity } from '../src/dark-identity.js';

const source = { width: 2, height: 2, pixels: new Uint8Array([30, 28, 28, 255, 197, 141, 112, 128, 98, 110, 131, 255, 66, 152, 134, 255]) };
const config = { irisBounds: [1, 1, 2, 2], eyeBounds: [0, 0, 2, 2] };

test('identity materials separate skin, cool hair and teal iris while preserving ink', () => {
  assert.equal(classifyDarkIdentityMaterial([30, 28, 28, 255]), null);
  assert.equal(classifyDarkIdentityMaterial([197, 141, 112, 255]), 'skin');
  assert.equal(classifyDarkIdentityMaterial([98, 110, 131, 255]), 'hair');
  assert.equal(classifyDarkIdentityMaterial([66, 152, 134, 255], 1, 1, config), 'iris');
  assert.equal(classifyDarkIdentityMaterial([66, 152, 134, 0], 1, 1, config), null);
});

test('palette choices change their own materials and retain alpha and linework', () => {
  const initial = recolorDarkIdentityPixels(source, { skin: 'ivory', hairColor: 'chestnut', eyes: 'amber' }, config);
  const skin = recolorDarkIdentityPixels(source, { skin: 'ebony', hairColor: 'chestnut', eyes: 'amber' }, config);
  const hair = recolorDarkIdentityPixels(source, { skin: 'ivory', hairColor: 'silver', eyes: 'amber' }, config);
  const eyes = recolorDarkIdentityPixels(source, { skin: 'ivory', hairColor: 'chestnut', eyes: 'violet' }, config);
  assert.deepEqual(initial.pixels.slice(0, 4), source.pixels.slice(0, 4));
  assert.equal(initial.pixels[7], 128);
  assert.notDeepEqual(initial.pixels.slice(4, 7), skin.pixels.slice(4, 7));
  assert.deepEqual(initial.pixels.slice(8), skin.pixels.slice(8));
  assert.notDeepEqual(initial.pixels.slice(8, 11), hair.pixels.slice(8, 11));
  assert.deepEqual(initial.pixels.slice(0, 8), hair.pixels.slice(0, 8));
  assert.notDeepEqual(initial.pixels.slice(12, 15), eyes.pixels.slice(12, 15));
  assert.deepEqual(initial.pixels.slice(0, 12), eyes.pixels.slice(0, 12));
  assert.deepEqual(source.pixels, new Uint8Array([30, 28, 28, 255, 197, 141, 112, 128, 98, 110, 131, 255, 66, 152, 134, 255]));
});

test('explicit material masks preserve fixed highlights and intense eyes remain distinct', () => {
  const materials = { width: 2, height: 2, pixels: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) };
  const classic = recolorDarkIdentityPixels(source, { eyeStyle: 'classic' }, config, materials);
  const sharp = recolorDarkIdentityPixels(source, { eyeStyle: 'sharp' }, config, materials);
  assert.notDeepEqual(classic.pixels, sharp.pixels);
  assert.deepEqual(classic.pixels.slice(12), sharp.pixels.slice(12));
  assert.throws(() => recolorDarkIdentityPixels(source, {}, config, { width: 1, height: 1, pixels: new Uint8Array(4) }), /mask dimensions/);
});

const manifest = { styleVersion: 'dark-v1', identities: {}, beards: {} };
for (const sex of ['male', 'female']) {
  manifest.identities[sex] = {};
  for (const { id } of avatarChoices.hairstyle) {
    manifest.identities[sex][id] = {};
    for (const kind of ['portrait', 'chibi']) manifest.identities[sex][id][kind] = { url: '/assets/clean-gladiator/v003/identities/fixture.png', width: 2, height: 2, anchor: [1, 1], ...config };
  }
}
manifest.beards.stubble = { portrait: { url: '/assets/clean-gladiator/v003/identities/beard.png', width: 2, height: 2, anchor: [1, 1] }, chibi: { url: '/assets/clean-gladiator/v003/identities/beard.png', width: 2, height: 2, anchor: [1, 1] } };
const png = await encodeAvatarPng(2, 2, source.pixels);
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.pathname.endsWith('/identity.json')) return new Response(JSON.stringify(manifest));
  if (url.pathname.endsWith('/fixture.png') || url.pathname.endsWith('/beard.png')) return new Response(png);
  return new Response('', { status: 404 });
};

test('each sex and hairstyle uses the same target chin registration in both views', async () => {
  await preloadDarkIdentity();
  for (const sex of ['male', 'female']) for (const { id } of avatarChoices.hairstyle) for (const kind of ['portrait', 'chibi']) {
    const image = await composeDarkIdentityPixels({ sex, hairstyle: id }, kind);
    assert.deepEqual(image.anchor, kind === 'portrait' ? [256, 420] : [96, 86]);
    const pixel = ((image.anchor[1] - 1) * image.width + image.anchor[0] - 1) * 4;
    assert.deepEqual(image.pixels.slice(pixel, pixel + 4), source.pixels.slice(0, 4));
    assert.equal(image.expression, 'solemn');
  }
});

test('female identity hides preserved facial hair and prepared head PNG stays exact', async () => {
  const clean = await composeDarkIdentityPixels({ sex: 'female', beard: 'none' });
  const bearded = await composeDarkIdentityPixels({ sex: 'female', beard: 'stubble' });
  assert.deepEqual(clean.pixels, bearded.pixels);
  const appearance = { sex: 'male', beard: 'stubble', hairstyle: 'high_ponytail' };
  const image = await prepareDarkIdentity(appearance, 'chibi');
  assert.equal(image.facialHairAvailable, true);
  assert.equal(getDarkIdentityImage(appearance, 'chibi'), image);
  const expected = await composeDarkIdentityPixels(appearance, 'chibi');
  const decoded = await decodeAvatarPng(new Uint8Array(Buffer.from(image.url.split(',')[1], 'base64')));
  assert.deepEqual(decoded.pixels, expected.pixels);
  assert.ok(renderDarkIdentity(appearance, 'chibi', { alt: '<script>"' }).includes('&lt;script&gt;&quot;'));
  await assert.rejects(composeDarkIdentityPixels(appearance, 'chibi', { canvas: [0, 160] }), /registration/);
});
