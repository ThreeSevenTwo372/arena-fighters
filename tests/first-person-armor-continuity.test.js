import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeAvatarPng } from '../src/avatar.js';
import { FIRST_PERSON_FRAME_CATALOG as frames } from '../src/first-person-frame-catalog.js';
import { FIRST_PERSON_AXIS_CATALOG as axes } from '../src/first-person-axis-catalog.js';
import { FIRST_PERSON_ARMOR_FRAME_CATALOG as garments } from '../src/first-person-armor-frame-catalog.js';
import { getFirstPersonFrameClip, firstPersonFrameAt } from '../src/first-person-frames.js';
import { WEAPONS, ARMORS } from '../src/combat.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poses = ['windup', 'contact', 'follow', 'recovery'];
const skins = ['porcelain', 'ivory', 'sand', 'copper', 'umber', 'ebony'];
const armors = ['heavy', 'light', 'medium'];
const admitted = getFirstPersonFrameClip({ weapon: 'greatsword', armor: 'medium' })?.artVersion === 'v008'
  || armors.every(armor => Object.hasOwn(garments.overrides.greatsword ?? {}, armor));
const admission = { skip: admitted ? false : 'The full three-armor v008 greatsword set has not been admitted.' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = relative => fs.readFile(path.join(project, relative.replace(/^\//, '')));
const image = async relative => decodeAvatarPng(new Uint8Array(await read(relative)));
const baseline = (armor, pose) => pose === 'windup' ? axes.overrides.greatsword[armor].windup
  : frames.clips.greatsword[armor].frames.find(frame => frame.pose === pose);

function binaryMask(mask, label) {
  assert.deepEqual([mask.width, mask.height], [460, 220], label);
  let owned = 0, violations = 0;
  for (let at = 0; at < mask.pixels.length; at += 4) {
    const owner = mask.pixels[at];
    if (![0, 255].includes(owner) || mask.pixels[at + 1] !== owner
      || mask.pixels[at + 2] !== owner || mask.pixels[at + 3] !== 255) violations++;
    if (owner) owned++;
  }
  assert.equal(violations, 0, `${label} is an opaque binary ownership mask.`);
  assert.ok(owned > 0, `${label} declares a nonempty garment surface.`);
}

test('v008 admits only 72 greatsword frames and twelve garment masks, retaining exact hands, weapons, contours and alpha', admission, async () => {
  const manifest = JSON.parse(await read('assets/first-person/v008/manifest.json'));
  assert.deepEqual(garments, manifest, 'Runtime metadata must match the sealed public manifest.');
  assert.equal(garments.schema, 1); assert.equal(garments.version, 'v008'); assert.equal(garments.baseVersion, 'v007');
  assert.deepEqual(Object.keys(garments.overrides), ['greatsword']);
  assert.deepEqual(Object.keys(garments.overrides.greatsword).sort(), armors);
  const expectedFiles = ['manifest.json'];
  for (const armor of armors) {
    const replacements = garments.overrides.greatsword[armor];
    assert.deepEqual(Object.keys(replacements).sort(), [...poses].sort());
    for (const pose of poses) {
      const frame = replacements[pose], original = baseline(armor, pose), label = `${armor}/${pose}`;
      assert.equal(frame.pose, pose); assert.deepEqual([frame.width, frame.height], [460, 220]);
      assert.deepEqual(Object.keys(frame.variants).sort(), [...skins].sort());
      assert.equal(frame.maskUrl, original.maskUrl, 'Existing hand material ownership stays registered.');
      const handBytes = await read(frame.maskUrl), hand = await decodeAvatarPng(new Uint8Array(handBytes));
      assert.equal(hash(handBytes), original.maskSha256 ?? frames.clips.greatsword[armor].frames.find(f => f.pose === pose).maskSha256);
      assert.equal(frame.garmentMaskUrl, `/assets/first-person/v008/greatsword-${armor}-${pose}-garment-mask.png`);
      const maskBytes = await read(frame.garmentMaskUrl), mask = await decodeAvatarPng(new Uint8Array(maskBytes));
      assert.equal(hash(maskBytes), frame.garmentMaskSha256); binaryMask(mask, label);
      expectedFiles.push(path.basename(frame.garmentMaskUrl));
      const ivory = await image(frame.variants.ivory), originalIvory = await image(original.variants.ivory);
      let ownerViolations = 0;
      for (let cell = 0; cell < 460 * 220; cell++) if (mask.pixels[cell * 4]) {
        const at = cell * 4, x = cell % 460, y = Math.floor(cell / 460);
        if (hand.pixels[at] || !originalIvory.pixels[at + 3]) ownerViolations++;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          if (x + dx >= 0 && x + dx < 460 && y + dy >= 0 && y + dy < 220
            && !originalIvory.pixels[((y + dy) * 460 + x + dx) * 4 + 3]) ownerViolations++;
        }
      }
      assert.equal(ownerViolations, 0, `${label} garment ownership excludes hands, transparency and the silhouette edge.`);
      let changedCells;
      for (const skin of skins) {
        const url = `/assets/first-person/v008/greatsword-${armor}-${pose}-${skin}.png`;
        assert.equal(frame.variants[skin], url); expectedFiles.push(path.basename(url));
        const encoded = await read(url); assert.equal(hash(encoded), frame.sha256s[skin]);
        const candidate = await decodeAvatarPng(new Uint8Array(encoded)), before = await image(original.variants[skin]);
        assert.deepEqual([candidate.width, candidate.height], [460, 220]);
        const changed = []; let alphaViolations = 0, exteriorViolations = 0, paletteViolations = 0, handViolations = 0;
        for (let cell = 0; cell < 460 * 220; cell++) {
          const at = cell * 4;
          if (candidate.pixels[at + 3] !== before.pixels[at + 3]) alphaViolations++;
          const different = candidate.pixels.subarray(at, at + 4).some((value, channel) => value !== before.pixels[at + channel]);
          if (different) { changed.push(cell); if (!mask.pixels[at]) exteriorViolations++; }
          if (hand.pixels[at] && different) handViolations++;
          if (!hand.pixels[at] && candidate.pixels.subarray(at, at + 4).some((value, channel) => value !== ivory.pixels[at + channel])) paletteViolations++;
        }
        assert.equal(alphaViolations, 0, `${label}/${skin} preserves every authored alpha byte.`);
        assert.equal(exteriorViolations, 0, `${label}/${skin} preserves every RGBA byte outside the audited garment mask, including equipment.`);
        assert.equal(handViolations, 0, `${label}/${skin} preserves exact hand pixels.`);
        assert.equal(paletteViolations, 0, `${label}/${skin} changes palettes only on the existing hands.`);
        assert.ok(changed.length > 0, `${label} contains an actual garment continuity edit.`);
        if (changedCells) assert.deepEqual(changed, changedCells, 'Garment edits own identical cells across all six hand palettes.');
        else changedCells = changed;
      }
    }
  }
  assert.equal(expectedFiles.length, 85);
  assert.deepEqual((await fs.readdir(path.join(project, 'assets/first-person/v008'))).sort(), expectedFiles.sort(),
    'No additional weapon, ready, mask or diagnostic file is admitted into the bounded public overlay.');
});

test('v008 inherits every other weapon and net cast exactly while historical greatswords and ready endpoints remain selectable', admission, () => {
  for (const weapon of Object.keys(WEAPONS)) for (const armor of Object.keys(ARMORS)) for (const skin of skins) {
    const gear = { weapon, armor, skin }, previous = getFirstPersonFrameClip({ ...gear, artVersion: 'v007' });
    const current = getFirstPersonFrameClip({ ...gear, artVersion: 'v008' });
    assert.ok(previous); assert.ok(current); assert.equal(current.artVersion, 'v008');
    assert.deepEqual(getFirstPersonFrameClip(gear), current, 'Normal battles select the admitted v008 overlay.');
    for (const pose of poses) assert.equal(current.frames[pose], weapon === 'greatsword'
      ? garments.overrides.greatsword[armor][pose].variants[skin] : previous.frames[pose]);
    assert.deepEqual(current.techniqueFrames, previous.techniqueFrames, 'The complete Entangle sequence remains exact.');
    assert.deepEqual(firstPersonFrameAt(current, 0), { pose: 'idle', url: null });
    assert.deepEqual(firstPersonFrameAt(current, 665), { pose: 'idle', url: null });
    for (const version of ['v005', 'v006', 'v007']) {
      const historical = getFirstPersonFrameClip({ ...gear, artVersion: version });
      assert.ok(historical); assert.equal(historical.artVersion, version);
      assert.ok([...Object.values(historical.frames), ...Object.values(historical.techniqueFrames ?? {})].every(url => !url.includes('/v008/')));
      for (const pose of poses.filter(pose => weapon !== 'greatsword' || pose !== 'windup')) {
        assert.equal(historical.frames[pose], previous.frames[pose]);
      }
    }
  }
});
