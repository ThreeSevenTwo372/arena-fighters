import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { avatarChoices, decodeAvatarPng, encodeAvatarPng, normalizeAppearance } from '../src/avatar.js';
import { composeFixedIdentityPixels } from '../src/fixed-identity.js';
import { prepareCleanAvatar as preparePreservedAvatar } from '../src/clean-avatar.js';
import { preloadCleanArt, prepareCleanAvatar, getCleanAvatarImage, renderCleanAvatar, getCleanArtDiagnostics } from '../src/arena-avatar.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const weapons = ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword'];
const armors = ['light', 'medium', 'heavy'];
const helmets = ['closed_bascinet', 'barbute', 'greathelm'];
let registrationRenderer;
const requests = [];
globalThis.fetch = async input => {
  const url = new URL(input); requests.push(url.pathname);
  const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== 'http://127.0.0.1:4173' || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
const file = url => fs.readFile(path.resolve(project, `.${new URL(url, 'http://127.0.0.1:4173').pathname}`));
const decodePrepared = image => decodeAvatarPng(new Uint8Array(Buffer.from(image.url.split(',')[1], 'base64')));
const rgbaAt = (image, x, y) => image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
const ids = field => avatarChoices[field].map(option => typeof option === 'string' ? option : option.id);

test('arena catalog preserves the approved six bodies and authored hand overlays', async () => {
  const catalog = await preloadCleanArt();
  const approved = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v003/manifest.json'), 'utf8'));
  assert.equal(catalog.styleVersion, 'arena-identity-v3');
  assert.equal(catalog.identityMode, 'fixed-skull-v1');
  assert.equal(catalog.identityTransform.scale, .84);
  assert.deepEqual(catalog.identityTransform.sourceAnchor, [96, 86]);
  assert.deepEqual(catalog.identityTransform.targetAnchor, [93, 86]);
  for (const sex of ['male', 'female']) for (const armor of armors) {
    const entry = catalog.bodies[sex][armor], original = approved.bodies[sex][armor];
    assert.deepEqual(await file(entry.url), await file(original.url), `${sex}/${armor} body remains the selected source artwork`);
    assert.deepEqual(await file(entry.handsUrl), await file(original.handsUrl), `${sex}/${armor} matching hand overlay`);
    assert.deepEqual(entry.mainhandGrip, original.mainhandGrip);
    assert.deepEqual(entry.offhandGrip, original.offhandGrip);
  }
  assert.ok(requests.includes('/assets/clean-gladiator/v006/manifest.json'));
});

test('creator, loadout, and arena share one cache object and exact rendered pixels', async () => {
  const appearance = normalizeAppearance({ sex: 'female', hairstyle: 'braided_ponytail', skin: 'copper', hairColor: 'silver', eyes: 'jade' });
  const gear = Object.freeze({ armor: 'medium', weapon: 'halberd', helmet: 'none' });
  const [world, battle] = await Promise.all([prepareCleanAvatar(appearance, 'world', gear), prepareCleanAvatar(appearance, 'battle', gear)]);
  assert.equal(world, battle, 'changing screens must not change the assembled identity');
  assert.equal(getCleanAvatarImage(appearance, 'world', gear), battle);
  assert.equal(getCleanAvatarImage(appearance, 'idle', gear), battle);
  assert.equal(world.width, 192); assert.equal(world.height, 160);
  const decoded = await decodePrepared(world);
  assert.equal(decoded.width, 192); assert.equal(decoded.height, 160);
  assert.deepEqual(world.pivot, [96, 152]);
  assert.ok(Object.isFrozen(world) && Object.isFrozen(world.mainhandGrip));
  await assert.rejects(prepareCleanAvatar(appearance, 'portrait', gear), /no portrait/);
  assert.throws(() => getCleanAvatarImage(appearance, 'portrait', gear), /no portrait/);
  assert.throws(() => renderCleanAvatar(appearance, 'portrait', gear), /no portrait/);
});

test('all seven weapon choices preserve assembled body pixels and attach at authored hands', async () => {
  const catalog = await preloadCleanArt();
  for (const sex of ['male', 'female']) for (const armor of armors) {
    const appearance = normalizeAppearance({ sex, hairstyle: 'shag', hairColor: 'chestnut', eyes: 'amber' });
    const source = catalog.bodies[sex][armor];
    let identityUrl;
    for (const weapon of weapons) {
      const image = await prepareCleanAvatar(appearance, 'battle', { armor, weapon });
      identityUrl ??= image.url;
      assert.equal(image.url, identityUrl, `${sex}/${armor}/${weapon} cannot bake a weapon into the body`);
      assert.deepEqual(image.mainhandGrip, source.mainhandGrip);
      assert.deepEqual(image.offhandGrip, source.offhandGrip);
      for (const pair of [image.mainhandGrip, image.offhandGrip]) assert.ok(pair.length === 2 && pair.every(Number.isFinite) && pair[0] >= 0 && pair[0] < 192 && pair[1] >= 0 && pair[1] < 160);
      assert.equal(image.weapon, weapon);
      assert.equal(image.weaponAngle, -40);
      assert.equal(image.weaponMirror, 1);
      assert.ok(image.weaponImage.url.endsWith(`/${weapon}.png`));
    }
  }
});

test('fitting the complete identity changes the head while preserving every lower body pixel', async () => {
  const catalog = await preloadCleanArt();
  for (const sex of ['male', 'female']) for (const armor of armors) for (const [index, hairstyle] of ids('hairstyle').entries()) {
    const appearance = normalizeAppearance({ sex, hairstyle, beard: ids('beard')[index % 4], skin: index % 2 ? 'ebony' : 'porcelain', hairColor: index % 2 ? 'silver' : 'chestnut', eyes: index % 2 ? 'jade' : 'amber' });
    const gear = { armor, weapon: 'sword', helmet: 'none' };
    const [current, preserved] = await Promise.all([prepareCleanAvatar(appearance, 'battle', gear), preparePreservedAvatar(appearance, 'battle', gear)]);
    const [fitted, body] = await Promise.all([decodePrepared(current), file(catalog.bodies[sex][armor].url).then(bytes => decodeAvatarPng(new Uint8Array(bytes)))]);
    assert.notEqual(current.url, preserved.url, `${sex}/${armor}/${hairstyle} receives the corrected smaller, forward head`);
    assert.deepEqual(fitted.pixels.subarray(118 * 192 * 4), body.pixels.subarray(118 * 192 * 4), `${sex}/${armor}/${hairstyle} lower body stays pixel for pixel unchanged`);
  }
  for (const sex of ['male', 'female']) for (const armor of armors) for (const helmet of helmets) {
    const appearance = normalizeAppearance({ sex, hairstyle: 'high_ponytail', beard: 'trimmed_full' });
    const gear = { armor, weapon: 'sword', helmet };
    const [current, preserved] = await Promise.all([prepareCleanAvatar(appearance, 'battle', gear), preparePreservedAvatar(appearance, 'battle', gear)]);
    const [fitted, body] = await Promise.all([decodePrepared(current), file(catalog.bodies[sex][armor].url).then(bytes => decodeAvatarPng(new Uint8Array(bytes)))]);
    assert.notEqual(current.url, preserved.url, `${sex}/${armor}/${helmet} helmet uses the same corrected head fit`);
    assert.deepEqual(fitted.pixels.subarray(118 * 192 * 4), body.pixels.subarray(118 * 192 * 4));
  }
});

test('fixed identities reach the arena unchanged and all fitted heads and helmets attach to each collar', async t => {
  const catalog = structuredClone(await preloadCleanArt());
  const emptyUrl = '/assets/clean-gladiator/v006/registration-empty.png';
  for (const sex of ['male', 'female']) for (const armor of armors) {
    catalog.bodies[sex][armor].url = emptyUrl;
    catalog.bodies[sex][armor].handsUrl = emptyUrl;
  }
  const empty = await encodeAvatarPng(192, 160, new Uint8Array(192 * 160 * 4));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/assets/clean-gladiator/v006/manifest.json') return new Response(JSON.stringify(catalog));
    if (url.pathname === emptyUrl) return new Response(empty);
    return originalFetch(input);
  };
  const isolated = await import('../src/arena-avatar.js?registration-fixture');
  const bounds = image => {
    const rect = [Infinity, Infinity, -Infinity, -Infinity];
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (rgbaAt(image, x, y)[3]) {
      rect[0] = Math.min(rect[0], x); rect[1] = Math.min(rect[1], y); rect[2] = Math.max(rect[2], x); rect[3] = Math.max(rect[3], y);
    }
    return rect;
  };
  const checkGroup = (source, fitted, label) => {
    const original = bounds(source), current = bounds(fitted), transform = catalog.identityTransform;
    const palette = new Set();
    for (let i = 0; i < source.pixels.length; i += 4) if (source.pixels[i + 3]) palette.add(source.pixels.subarray(i, i + 4).join(','));
    for (let i = 0; i < fitted.pixels.length; i += 4) if (fitted.pixels[i + 3]) assert.ok(palette.has(fitted.pixels.subarray(i, i + 4).join(',')), `${label} uses source RGBA without invented colors or alpha`);
    for (let side = 0; side < 4; side++) {
      const axis = side % 2, expected = transform.targetAnchor[axis] + (original[side] - transform.sourceAnchor[axis]) * transform.scale;
      assert.ok(Math.abs(current[side] - expected) <= 1.6, `${label} group bound ${side}: ${current[side]} follows registered scale/shift ${expected}`);
    }
    assert.ok(current[2] - current[0] < original[2] - original[0], `${label} becomes narrower`);
    assert.ok(current[3] - current[1] < original[3] - original[1], `${label} becomes shorter`);
    if (['male/shag/none', 'female/shag/none', 'closed_bascinet', 'barbute', 'greathelm'].includes(label)) t.diagnostic(`${label} source bounds [${original}] -> fitted bounds [${current}]`);
  };
  try {
    await isolated.preloadCleanArt();
    registrationRenderer = isolated;
    const realCatalog = await preloadCleanArt(), bodies = {};
    for (const sex of ['male', 'female']) for (const armor of armors) bodies[`${sex}/${armor}`] = await decodeAvatarPng(new Uint8Array(await file(realCatalog.bodies[sex][armor].url)));
    const checkCollar = (fitted, sex, label) => {
      for (const armor of armors) {
        const body = bodies[`${sex}/${armor}`];
        let contact = 0;
        for (let y = 80; y <= 90; y++) for (let x = 86; x <= 103; x++) if (rgbaAt(body, x, y)[3] >= 16 && rgbaAt(fitted, x, y)[3] >= 16) contact++;
        assert.ok(contact > 0, `${label}/${armor} fitted neck joins the armor collar`);
      }
    };
    for (const sex of ['male', 'female']) for (const hairstyle of ids('hairstyle')) for (const beard of ids('beard')) {
      const appearance = normalizeAppearance({ sex, hairstyle, beard });
      const [source, fitted] = await Promise.all([composeFixedIdentityPixels(appearance, catalog.identityTransform), isolated.prepareCleanAvatar(appearance, 'battle', { armor: 'medium', weapon: 'sword' }).then(decodePrepared)]);
      assert.deepEqual(fitted.pixels, source.pixels, `${sex}/${hairstyle}/${beard} arena preserves the final fixed-face assembly without resampling it twice`);
      checkCollar(fitted, sex, `${sex}/${hairstyle}/${beard}`);
    }
    for (const helmet of helmets) {
      const [source, fitted] = await Promise.all([file(catalog.helmets[helmet].url).then(bytes => decodeAvatarPng(new Uint8Array(bytes))), isolated.prepareCleanAvatar({}, 'battle', { armor: 'medium', weapon: 'sword', helmet }).then(decodePrepared)]);
      checkGroup(source, fitted, helmet);
      for (const sex of ['male', 'female']) checkCollar(fitted, sex, helmet);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('each closed helmet suppresses every identity setting and unequipping restores the face', async () => {
  for (const sex of ['male', 'female']) for (const helmet of helmets) {
    const base = normalizeAppearance({ sex, hairstyle: 'shag', beard: 'trimmed_full', hairColor: 'chestnut', skin: 'ivory', eyes: 'amber', eyeStyle: 'classic' });
    const gear = { armor: 'medium', weapon: 'sword', helmet };
    const helmeted = await prepareCleanAvatar(base, 'battle', gear);
    for (const field of ['hairstyle', 'beard', 'skin', 'hairColor', 'eyes', 'eyeStyle']) for (const value of ids(field)) {
      const appearance = normalizeAppearance({ ...base, [field]: value });
      const variant = await prepareCleanAvatar(appearance, 'world', gear);
      assert.equal(variant.url, helmeted.url, `${sex}/${helmet}: hidden ${field}=${value} must not leak through armor`);
      assert.equal(variant.appearance[field], appearance[field], 'appearance must remain saved underneath');
    }
    const unhelmeted = await prepareCleanAvatar(base, 'battle', { ...gear, helmet: 'none' });
    assert.notEqual(unhelmeted.url, helmeted.url);
    const restored = await prepareCleanAvatar(base, 'world', { ...gear, helmet: 'none' });
    assert.equal(restored, unhelmeted);
  }
});

test('skin, hair, eyes, and expression choices visibly affect the unhelmeted arena identity', async () => {
  for (const sex of ['male', 'female']) {
    const base = normalizeAppearance({ sex, hairstyle: 'shag', beard: 'none' });
    for (const field of ['skin', 'hairColor', 'eyes', 'eyeStyle']) {
      const values = new Set();
      for (const value of ids(field)) {
        const image = await prepareCleanAvatar({ ...base, [field]: value }, 'battle', { weapon: 'sword', armor: 'medium' });
        values.add(image.url);
      }
      assert.equal(values.size, ids(field).length, `${sex}: each ${field} choice changes actual pixels`);
    }
  }
});

test('outward weapons, every head and body fit the tighter preview frame and leave the face clear', async t => {
  const catalog = await preloadCleanArt(), bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const point = (x, y) => { bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y); };
  const include = image => { for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (rgbaAt(image, x, y)[3]) point(x, y); };
  for (const sex of ['male', 'female']) for (const hairstyle of ids('hairstyle')) include(await prepareCleanAvatar({ sex, hairstyle }, 'battle', { armor: 'medium', weapon: 'sword' }).then(decodePrepared));
  for (const sex of ['male', 'female']) for (const armor of armors) include(await prepareCleanAvatar({ sex }, 'battle', { armor, weapon: 'sword' }).then(decodePrepared));
  for (const helmet of helmets) include(await prepareCleanAvatar({}, 'battle', { armor: 'medium', weapon: 'sword', helmet }).then(decodePrepared));
  for (const sex of ['male', 'female']) for (const armor of armors) for (const weapon of weapons) {
    const appearance = normalizeAppearance({ sex, hairstyle: 'none', beard: 'none' });
    const image = await prepareCleanAvatar(appearance, 'world', { armor, weapon });
    const [equipment, head] = await Promise.all([file(image.weaponImage.url).then(bytes => decodeAvatarPng(new Uint8Array(bytes))), registrationRenderer.prepareCleanAvatar(appearance, 'battle', { armor, weapon }).then(decodePrepared)]);
    const angle = image.weaponAngle * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    let opaque = 0;
    for (let y = 0; y < equipment.height; y++) for (let x = 0; x < equipment.width; x++) {
      if (!rgbaAt(equipment, x, y)[3]) continue;
      const localX = (x - image.weaponImage.grip[0]) * image.weaponMirror, localY = y - image.weaponImage.grip[1];
      const canvasX = image.mainhandGrip[0] + cos * localX - sin * localY;
      const canvasY = image.mainhandGrip[1] + sin * localX + cos * localY;
      point(canvasX, canvasY);
      assert.ok(canvasX >= 0 && canvasX < 160 && canvasY >= 32 && canvasY < 160, `${sex}/${armor}/${weapon} visible pixel fits the tighter preview at ${canvasX},${canvasY}`);
      const hx = Math.round(canvasX), hy = Math.round(canvasY);
      assert.equal(rgbaAt(head, hx, hy)[3], 0, `${sex}/${armor}/${weapon} does not obscure the transformed bald face`);
      opaque++;
    }
    assert.ok(opaque > 50);
    const markup = renderCleanAvatar(appearance, 'world', { armor, weapon }, { alt: '\" onload=\"bad()<script>' });
    assert.ok(markup.includes('viewBox="0 32 160 128"'));
    assert.ok(markup.includes('data-art-version="arena-identity-v3"'));
    assert.ok(markup.includes('rotate(-40)'));
    assert.ok(markup.includes('&lt;script&gt;') && !markup.includes('<script>'));
    const shield = await decodeAvatarPng(new Uint8Array(await file(image.shieldImage.url)));
    for (let y = 0; y < shield.height; y++) for (let x = 0; x < shield.width; x++) if (rgbaAt(shield, x, y)[3]) point(image.offhandGrip[0] + x - image.shieldImage.grip[0], image.offhandGrip[1] + y - image.shieldImage.grip[1]);
  }
  assert.ok(bounds[0] >= 0 && bounds[1] >= 32 && bounds[2] < 160 && bounds[3] < 160, 'the preview keeps every opaque body, hairstyle, helmet, weapon, and shield pixel in frame');
  t.diagnostic(`Opaque bounds across 6 bodies, 18 hairstyles, 3 helmets, and 7 outward weapons: [${bounds.map(value => value.toFixed(3)).join(', ')}]`);
});

test('preparation caches remain bounded after the complete identity and equipment sweep', () => {
  const diagnostics = getCleanArtDiagnostics();
  assert.equal(diagnostics.pendingRenders, 0);
  assert.ok(diagnostics.renders <= 24 && diagnostics.renders > 0);
  assert.ok(diagnostics.textureBytes > 0 && diagnostics.textureBytes <= 16 * 1024 * 1024);
  assert.ok(!requests.some(url => /portrait.*\.png$/.test(url)), 'arena-only preparation never loads portrait textures');
});
