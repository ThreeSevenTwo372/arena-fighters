import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAvatarPng, normalizeAppearance } from '../src/avatar.js';
import { ARMORS, HELMETS } from '../src/combat.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v003/manifest.json'), 'utf8'));
const historicalWeapons = ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword'];
let instance = 0;

function localPath(input) {
  const url = new URL(input, 'http://127.0.0.1:4173/');
  const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== 'http://127.0.0.1:4173' || !target.startsWith(`${project}${path.sep}`)) throw new Error('Test texture escaped the project.');
  return target;
}
globalThis.fetch = async input => {
  try { return new Response(await fs.readFile(localPath(input))); }
  catch { return new Response('', { status: 404 }); }
};
const freshRenderer = () => import(`../src/clean-avatar.js?dark-rig=${++instance}`);
const decoded = async image => decodeAvatarPng(new Uint8Array(Buffer.from(image.url.split(',')[1], 'base64')));
const texture = async entry => decodeAvatarPng(new Uint8Array(await fs.readFile(localPath(entry.url))));
const pixelAt = (image, [x, y]) => image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4);
function alphaBounds(image) {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (pixelAt(image, [x, y])[3]) {
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  assert.ok(right >= left && bottom >= top, 'registered art needs visible pixels');
  return { left, top, right: right + 1, bottom: bottom + 1, width: right - left + 1, height: bottom - top + 1 };
}

test('the preserved v003 dark rig supports its exact seven weapons and every armor with visible authored hand attachments', async () => {
  const renderer = await freshRenderer();
  assert.equal(manifest.styleVersion, 'dark-v1');
  // The authored shield is an offhand attachment, not a selectable weapon.
  assert.deepEqual(Object.keys(manifest.weapons).sort(), [...historicalWeapons, 'shield'].sort());
  for (const sex of ['male', 'female']) for (const armor of Object.keys(ARMORS)) {
    const body = manifest.bodies[sex][armor];
    const bodyPixels = await texture(body);
    const hands = await texture({ url: body.handsUrl });
    const appearance = normalizeAppearance({ sex, hairstyle: 'cropped', beard: 'none' });
    let bodyUrl;
    // Current additions use the separately tested equipment overlay; the
    // historical source renderer and its authored catalog remain preserved.
    for (const weapon of historicalWeapons) {
      const gear = { armor, weapon, helmet: 'none' };
      const image = await renderer.prepareCleanAvatar(appearance, 'battle', gear);
      assert.deepEqual([image.width, image.height], [192, 160]);
      assert.equal(image.weapon, weapon);
      assert.equal(image.armor, armor);
      assert.equal(image.helmet, 'none');
      assert.equal(image.sourceFacing, 'W');
      assert.equal(image.nativeWeapon, false);
      assert.deepEqual(image.mainhandGrip, body.mainhandGrip);
      assert.deepEqual(image.offhandGrip, body.offhandGrip);
      assert.deepEqual(image.weaponImage.grip, manifest.weapons[weapon].grip);
      assert.ok(image.weaponImage.url.endsWith(manifest.weapons[weapon].url));
      assert.equal(renderer.getCleanAvatarImage(appearance, 'battle', gear), image);
      if (bodyUrl) assert.equal(image.url, bodyUrl, 'changing weapon must not bake equipment into face/body pixels');
      bodyUrl = image.url;
      const weaponPixels = await texture(manifest.weapons[weapon]);
      assert.ok(pixelAt(weaponPixels, image.weaponImage.grip)[3] > 0, `${weapon} grip must hold a visible handle`);
    }
    const [x, y] = body.mainhandGrip;
    const [left, top, right, bottom] = body.handOverlayBounds;
    assert.ok(x >= left && x < right && y >= top && y < bottom, `${sex}/${armor} grip must lie inside its glove overlay`);
    assert.ok(pixelAt(bodyPixels, body.mainhandGrip)[3] > 0, `${sex}/${armor} mainhand must lie on the drawn body`);
    assert.ok(pixelAt(bodyPixels, body.offhandGrip)[3] > 0, `${sex}/${armor} offhand must lie on the drawn body`);
    assert.ok(pixelAt(hands, body.mainhandGrip)[3] > 0, `${sex}/${armor} glove must cover the weapon handle`);
    for (let offset = 0; offset < hands.pixels.length; offset += 4) if (hands.pixels[offset + 3]) {
      assert.deepEqual(hands.pixels.subarray(offset, offset + 4), bodyPixels.pixels.subarray(offset, offset + 4), `${sex}/${armor} glove must retain exact body pixels`);
    }
  }
});

test('world skulls and helmets stay proportional to armor and attach continuously at the collar', async () => {
  const renderer = await freshRenderer();
  const identities = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v003/identity.json'), 'utf8'));
  const [neckX, neckY] = manifest.neckCenter;
  const helmets = await Promise.all(Object.entries(manifest.helmets).map(async ([id, entry]) => ({ id, pixels: await texture(entry.world) })));
  for (const sex of ['male', 'female']) {
    // Bald, unbearded heads measure the skull rather than a ponytail or beard silhouette.
    const head = await texture(identities.identities[sex].none.chibi);
    const headBounds = alphaBounds(head);
    assert.ok(headBounds.bottom >= neckY - 1 && headBounds.bottom <= neckY + 1, `${sex} chin must reach its authored neck`);
    for (const armor of Object.keys(ARMORS)) {
      const body = await texture(manifest.bodies[sex][armor]);
      const bodyBounds = alphaBounds(body);
      assert.ok(bodyBounds.height >= 64 && bodyBounds.height <= 76, `${sex}/${armor} torso and legs must keep their intended scale`);
      assert.ok(headBounds.height <= bodyBounds.height * 0.5, `${sex}/${armor} skull ${headBounds.height}px exceeds half of its ${bodyBounds.height}px armor body`);
      assert.ok(headBounds.width <= bodyBounds.height * 0.5, `${sex}/${armor} skull must not become excessively wide`);
      assert.ok(bodyBounds.top < neckY && headBounds.bottom > bodyBounds.top, `${sex}/${armor} head must overlap the collar vertically`);
      const appearance = { sex, hairstyle: 'none', beard: 'none' };
      const bare = await decoded(await renderer.prepareCleanAvatar(appearance, 'world', { weapon: 'sword', armor, helmet: 'none' }));
      const aboveCollar = [neckX, bodyBounds.top - 1];
      assert.ok(pixelAt(head, aboveCollar)[3] > 0, `${sex} chin must be visible immediately above its collar`);
      assert.equal(pixelAt(bare, aboveCollar)[3], pixelAt(head, aboveCollar)[3], `${sex}/${armor} assembled head must retain its neck registration`);
      for (let y = bodyBounds.top; y < headBounds.bottom; y++) {
        assert.ok(pixelAt(head, [neckX, y])[3] > 0 && pixelAt(body, [neckX, y])[3] > 0, `${sex}/${armor} collar must contact the head at row ${y}`);
      }
      for (let y = bodyBounds.top - 1; y <= neckY + 2; y++) assert.ok(pixelAt(bare, [neckX, y])[3] > 0, `${sex}/${armor} must have no transparent neck gap at row ${y}`);
      for (const { id, pixels: helmet } of helmets) {
        const bounds = alphaBounds(helmet);
        assert.ok(bounds.height <= bodyBounds.height * 0.52, `${id} ${bounds.height}px exceeds its ${bodyBounds.height}px armor body's helmet allowance`);
        assert.ok(bounds.width <= bodyBounds.height * 0.52, `${id} must keep a proportional width`);
        assert.ok(bounds.top < bodyBounds.top && bounds.bottom > bodyBounds.top, `${id} must reach the collar`);
        const covered = await decoded(await renderer.prepareCleanAvatar(appearance, 'world', { weapon: 'sword', armor, helmet: id }));
        assert.equal(pixelAt(covered, aboveCollar)[3], pixelAt(helmet, aboveCollar)[3]);
        for (let y = bodyBounds.top - 1; y <= neckY + 2; y++) assert.ok(pixelAt(covered, [neckX, y])[3] > 0, `${sex}/${armor}/${id} must have no transparent collar gap at row ${y}`);
      }
    }
  }
});

test('closed helmets replace the whole identity in both views and removing them restores saved choices', async () => {
  for (const sex of ['male', 'female']) for (const kind of ['world', 'portrait']) {
    const renderer = await freshRenderer();
    const initial = normalizeAppearance({ sex, hairstyle: 'shag', skin: 'porcelain', hairColor: 'raven', eyes: 'amber', eyeStyle: 'classic', beard: 'none' });
    const alternate = normalizeAppearance({ sex, hairstyle: 'shoulder_length_loose', skin: 'ebony', hairColor: 'silver', eyes: 'violet', eyeStyle: 'sharp', beard: 'trimmed_full' });
    const gear = { weapon: 'flail', armor: 'heavy', helmet: 'none' };
    const unhelmeted = await renderer.prepareCleanAvatar(initial, kind, gear);
    const alternateVisible = await renderer.prepareCleanAvatar(alternate, kind, gear);
    assert.notEqual(unhelmeted.url, alternateVisible.url, `${sex}/${kind} saved appearance choices must affect the visible head`);
    assert.deepEqual([unhelmeted.width, unhelmeted.height], kind === 'portrait' ? [512, 640] : [192, 160]);
    const helmetUrls = new Set();
    for (const helmet of Object.keys(HELMETS).filter(id => id !== 'none')) {
      const selected = { ...gear, helmet };
      const covered = await renderer.prepareCleanAvatar(initial, kind, selected);
      const alternateCovered = await renderer.prepareCleanAvatar(alternate, kind, selected);
      assert.equal(covered.url, alternateCovered.url, `${sex}/${kind}/${helmet} must conceal all differing hair, face, iris, expression, and beard pixels`);
      assert.notEqual(covered.url, unhelmeted.url);
      assert.equal(covered.helmet, helmet);
      assert.deepEqual(covered.appearance, initial);
      assert.deepEqual(alternateCovered.appearance, alternate);
      assert.equal(renderer.getCleanAvatarImage(initial, kind, selected), covered);
      assert.equal(renderer.getCleanAvatarImage(initial, kind, gear), unhelmeted, 'helmet cache must not replace the uncovered identity');
      helmetUrls.add(covered.url);
    }
    assert.equal(helmetUrls.size, 3, 'all enclosed helmets must have distinct artwork');
    const restored = await renderer.prepareCleanAvatar(initial, kind, gear);
    assert.equal(restored, unhelmeted);
    assert.deepEqual(restored.appearance, initial);
    const markup = renderer.renderCleanAvatar(initial, kind, gear);
    assert.ok(kind === 'portrait' ? markup.startsWith('<img ') : markup.startsWith('<svg '));
    assert.ok(!markup.includes('Preparing character art'));
  }
});

test('flail part pixels and resting joints reconstruct the shipped weapon without overlap', async () => {
  const renderer = await freshRenderer();
  const prepared = await renderer.prepareCleanAvatar({}, 'battle', { weapon: 'flail', armor: 'medium', helmet: 'none' });
  const weapon = prepared.weaponImage;
  const original = await texture(weapon);
  assert.deepEqual(Object.keys(weapon.parts).sort(), ['chain', 'handle', 'head']);
  const assembled = new Uint8Array(original.pixels.length);
  const occupied = new Uint8Array(original.width * original.height);
  for (const [name, entry] of Object.entries(weapon.parts)) {
    const image = await texture(entry);
    assert.deepEqual([image.width, image.height], [weapon.width, weapon.height]);
    assert.deepEqual(entry.origin, [0, 0]);
    assert.deepEqual(entry.grip, weapon.grip);
    assert.deepEqual(entry.pivot, name === 'handle' ? weapon.grip : name === 'chain' ? weapon.chainPivot : weapon.headPivot);
    let visible = 0;
    for (let offset = 0; offset < image.pixels.length; offset += 4) if (image.pixels[offset + 3]) {
      assert.equal(occupied[offset / 4], 0, `${name} must not double another part's alpha`);
      occupied[offset / 4] = 1;
      assembled.set(image.pixels.subarray(offset, offset + 4), offset);
      visible++;
    }
    assert.ok(visible > 0, `${name} needs visible art to animate`);
  }
  for (let offset = 0; offset < original.pixels.length; offset += 4) {
    assert.equal(assembled[offset + 3], original.pixels[offset + 3], `flail alpha ${offset / 4}`);
    if (original.pixels[offset + 3]) assert.deepEqual(assembled.subarray(offset, offset + 4), original.pixels.subarray(offset, offset + 4), `flail visible RGBA ${offset / 4}`);
  }
  assert.deepEqual(weapon.headPivot, weapon.chainEnd, 'head must attach at the chain endpoint');
  for (const point of [weapon.chainPivot, weapon.headPivot, weapon.headCenter]) {
    assert.ok(point[0] >= 0 && point[0] < weapon.width && point[1] >= 0 && point[1] < weapon.height, 'flail joint must stay in its authored frame');
  }
  // At rest, nested chain/head pivots must cancel to the same hand offset as the handle.
  const chainOffset = weapon.chainPivot.map((value, axis) => value - weapon.grip[axis] - weapon.chainPivot[axis]);
  const headOffset = weapon.chainPivot.map((value, axis) => value - weapon.grip[axis] + weapon.headPivot[axis] - value - weapon.headPivot[axis]);
  assert.deepEqual(chainOffset, weapon.grip.map(value => -value));
  assert.deepEqual(headOffset, chainOffset);
  assert.throws(() => { weapon.parts.chain.pivot[0] = 0; }, TypeError);
  const image = await decoded(prepared);
  assert.deepEqual([image.width, image.height], [192, 160]);
});
