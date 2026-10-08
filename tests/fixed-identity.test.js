import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { avatarChoices, decodeAvatarPng } from '../src/avatar.js';
import { composeFixedIdentityPixels } from '../src/fixed-identity.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rig = Object.freeze({ scale: .84, sourceAnchor: [96, 86], targetAnchor: [93, 86] });
const sexes = ['male', 'female'];
const ids = field => avatarChoices[field].map(option => option.id);
const baseAppearance = { skin: 'ivory', hairColor: 'chestnut', eyes: 'amber', beard: 'none', eyeStyle: 'classic' };
const originalCatalog = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v003/identity.json'), 'utf8'));
globalThis.fetch = async input => {
  const url = new URL(input);
  const target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== 'http://127.0.0.1:4173' || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};

const fixtures = new Map();
async function image(appearance) {
  const selected = { ...baseAppearance, ...appearance }, key = JSON.stringify(selected);
  if (!fixtures.has(key)) fixtures.set(key, composeFixedIdentityPixels(selected, rig));
  return fixtures.get(key);
}
const rgbaAt = (value, point) => value.pixels.subarray((point[1] * value.width + point[0]) * 4, (point[1] * value.width + point[0]) * 4 + 4);
const changedPixels = (left, right) => {
  const result = [];
  for (let i = 0; i < left.width * left.height; i++) {
    const p = i * 4;
    if (left.pixels[p] !== right.pixels[p] || left.pixels[p + 1] !== right.pixels[p + 1]
      || left.pixels[p + 2] !== right.pixels[p + 2] || left.pixels[p + 3] !== right.pixels[p + 3]) result.push(i);
  }
  return result;
};

function alphaComponents(value) {
  const seen = new Uint8Array(value.width * value.height), components = [];
  for (let initial = 0; initial < seen.length; initial++) {
    if (seen[initial] || !value.pixels[initial * 4 + 3]) continue;
    const queue = [initial], bounds = [value.width, value.height, -1, -1];
    seen[initial] = 1;
    let size = 0;
    while (queue.length) {
      const p = queue.pop(), x = p % value.width, y = Math.floor(p / value.width);
      size++;
      bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
      bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(value.height - 1, y + 1); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(value.width - 1, x + 1); xx++) {
          const next = yy * value.width + xx;
          if (seen[next] || !value.pixels[next * 4 + 3]) continue;
          seen[next] = 1; queue.push(next);
        }
      }
    }
    components.push({ size, bounds });
  }
  return components.sort((left, right) => right.size - left.size);
}

const maleFeatureRegions = Object.freeze({ brow: [86, 69, 97, 73], nose: [81, 72, 88, 79], jaw: [86, 80, 100, 85] });
const within = (x, y, bounds) => x >= bounds[0] && x < bounds[2] && y >= bounds[1] && y < bounds[3];

// Derive the face region from the preserved, explicitly selected source and
// documented rig, independently of the new compositor's protected mask. The
// recovered male face uses Tousled facial artwork under the retained bald scalp.
async function independentFace(sex) {
  const entry = originalCatalog.identities[sex][sex === 'male' ? 'shag' : 'none'].chibi;
  const scalp = originalCatalog.identities[sex].none.chibi;
  const faceStart = sex === 'male' ? 68 : entry.eyeBounds[1];
  const original = await decodeAvatarPng(new Uint8Array(await fs.readFile(path.join(project, `.${entry.url}`))));
  const cells = [];
  let browRow = 160;
  for (let y = 0; y < 160; y++) for (let x = 0; x < 192; x++) {
    const sourceX = Math.floor(96 + (x + .5 - 93) / .84), sourceY = Math.floor(86 + (y + .5 - 86) / .84);
    if (sourceX < 0 || sourceX >= 192 || sourceY < faceStart || sourceY >= 160) continue;
    const rgba = original.pixels.subarray((sourceY * 192 + sourceX) * 4, (sourceY * 192 + sourceX) * 4 + 4);
    if (rgba[3] < 80) continue;
    if (sex === 'male') {
      const [r, g, b] = rgba, peak = Math.max(r, g, b);
      const skin = r > g + 8 && g >= b + 5 && peak > 65;
      const iris = within(sourceX, sourceY, entry.irisBounds) && g > r + 12 && b > r + 6 && g > b;
      const facialInk = peak <= 48 && Object.values(maleFeatureRegions).some(bounds => within(sourceX, sourceY, bounds));
      if (!skin && !iris && !facialInk) continue;
    }
    cells.push(y * 192 + x); browRow = Math.min(browRow, y);
  }
  return { entry, scalp, faceStart, original, cells, browRow };
}

// Skin in an open forehead/part is legitimate. Skin completely enclosed by
// opaque hair and its ink above the brow is an unwanted cap pinhole.
function enclosedCapMaterials(value, browRow) {
  const seen = new Uint8Array(192 * 160), queue = [];
  const blocked = p => Math.floor(p / 192) < browRow && value.pixels[p * 4 + 3] > 0 && [0, 2].includes(value.materials[p]);
  const visit = p => { if (!seen[p] && !blocked(p)) { seen[p] = 1; queue.push(p); } };
  for (let x = 0; x < 192; x++) { visit(x); visit(159 * 192 + x); }
  for (let y = 0; y < 160; y++) { visit(y * 192); visit(y * 192 + 191); }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const p = queue[cursor], x = p % 192, y = Math.floor(p / 192);
    if (x > 0) visit(p - 1); if (x < 191) visit(p + 1);
    if (y > 0) visit(p - 192); if (y < 159) visit(p + 192);
  }
  const leaks = [];
  for (let p = 0; p < seen.length; p++) if (!seen[p] && [1, 3].includes(value.materials[p])) leaks.push([p % 192, Math.floor(p / 192)]);
  return leaks;
}

test('final fixed heads keep facial geometry and all protected pixels across every hairstyle and expression', async () => {
  for (const sex of sexes) for (const eyeStyle of ids('eyeStyle')) for (const beard of ids('beard')) {
    const control = await image({ sex, hairstyle: 'none', eyeStyle, beard });
    assert.equal(control.width, 192); assert.equal(control.height, 160);
    assert.deepEqual(control.registration.scale, .84);
    assert.deepEqual(control.registration.sourceAnchor, [96, 86]);
    assert.deepEqual(control.registration.targetAnchor, [93, 86]);
    assert.equal(control.protectedFaceMask.length, 192 * 160);
    assert.equal(control.materials.length, 192 * 160);
    assert.ok(control.protectedFaceMask.reduce((count, pixel) => count + Boolean(pixel), 0) > 100, `${sex}/${eyeStyle}/${beard} must protect the face, not only an eye pixel`);
    for (const hairstyle of ids('hairstyle')) {
      const current = await image({ sex, hairstyle, eyeStyle, beard }), label = `${sex}/${hairstyle}/${eyeStyle}/${beard}`;
      assert.deepEqual(current.protectedFaceMask, control.protectedFaceMask, `${label} hair must not redefine the protected facial geometry`);
      assert.deepEqual(current.irisLandmarks, control.irisLandmarks, `${label} hair must not move the eyes`);
      for (let i = 0; i < control.protectedFaceMask.length; i++) if (control.protectedFaceMask[i]) {
        assert.deepEqual(current.pixels.subarray(i * 4, i * 4 + 4), control.pixels.subarray(i * 4, i * 4 + 4), `${label} changed a fixed facial pixel at ${i % 192},${Math.floor(i / 192)}`);
      }
    }
  }
});

test('all nine preserved hairstyle choices remain visibly distinct around the same fixed face', async () => {
  for (const sex of sexes) {
    const variants = [];
    for (const hairstyle of ids('hairstyle')) {
      const current = await image({ sex, hairstyle });
      variants.push(createHash('sha256').update(current.pixels).digest('hex'));
    }
    assert.equal(new Set(variants).size, ids('hairstyle').length, `${sex} hair fitting must not erase or duplicate selectable hairstyles`);
  }
});

test('canonical source brow, ear, jaw and neck pixels stay fixed independently of renderer mask metadata', async () => {
  for (const sex of sexes) {
    const expected = await independentFace(sex);
    assert.ok(expected.cells.length > 100);
    for (const eyeStyle of ids('eyeStyle')) for (const beard of ids('beard')) {
      const control = await image({ sex, hairstyle: 'none', eyeStyle, beard });
      assert.equal(control.canonicalFace.sourceUrl, expected.entry.url);
      assert.equal(control.canonicalFace.scalpSourceUrl, expected.scalp.url);
      assert.equal(control.canonicalFace.browTop, expected.faceStart);
      assert.equal(control.canonicalFace.faceStart, expected.faceStart);
      for (const hairstyle of ids('hairstyle')) {
        const current = await image({ sex, hairstyle, eyeStyle, beard }), label = `${sex}/${hairstyle}/${eyeStyle}/${beard}`;
        for (const p of expected.cells) {
          assert.deepEqual(current.pixels.subarray(p * 4, p * 4 + 4), control.pixels.subarray(p * 4, p * 4 + 4), `${label} changed an independently registered face cell at ${p % 192},${Math.floor(p / 192)}`);
          assert.ok(current.protectedFaceMask[p], `${label} omitted canonical brow/ear/jaw/neck cell from protection at ${p % 192},${Math.floor(p / 192)}`);
        }
      }
    }
  }
});

test('the recovered male brow, nose and jaw retain literal facial linework from the preserved reference source', async () => {
  const expected = await independentFace('male');
  for (const [feature, bounds] of Object.entries(maleFeatureRegions)) {
    const samples = [];
    for (let y = 0; y < 160; y++) for (let x = 0; x < 192; x++) {
      const sourceX = Math.floor(96 + (x + .5 - 93) / .84), sourceY = Math.floor(86 + (y + .5 - 86) / .84);
      if (!within(sourceX, sourceY, bounds)) continue;
      const rgba = expected.original.pixels.subarray((sourceY * 192 + sourceX) * 4, (sourceY * 192 + sourceX) * 4 + 4);
      if (rgba[3] >= 80 && Math.max(...rgba.subarray(0, 3)) <= 48) samples.push({ at: [x, y], rgba });
    }
    assert.ok(samples.length > 0, `${feature} requires a visible preserved-source feature fixture`);
    for (const hairstyle of ids('hairstyle')) {
      const current = await image({ sex: 'male', hairstyle, beard: 'none', eyeStyle: 'classic' });
      for (const sample of samples) assert.deepEqual(rgbaAt(current, sample.at), sample.rgba, `${hairstyle} lost authored ${feature} ink at ${sample.at}`);
    }
  }
});

const eyeFeatureFixtures = Object.freeze({
  male: { whites: [{ source: [93, 72], target: [91, 74] }], lid: { source: [94, 71], target: [91, 73] } },
  female: { whites: [{ source: [94, 70], target: [91, 72] }, { source: [93, 71], target: [91, 73] }], lid: { source: [95, 69], target: [92, 72] } },
});
const luminance = rgba => rgba[0] * .2126 + rgba[1] * .7152 + rgba[2] * .0722;

test('both fixed faces retain literal eye whites, dark lids and distinct adjacent irises at final size', async () => {
  for (const sex of sexes) {
    const { original } = await independentFace(sex), fixture = eyeFeatureFixtures[sex];
    for (const hairstyle of ids('hairstyle')) for (const eyeStyle of ids('eyeStyle')) for (const eyes of ids('eyes')) {
      const current = await image({ sex, hairstyle, eyeStyle, eyes }), label = `${sex}/${hairstyle}/${eyeStyle}/${eyes}`;
      assert.deepEqual(current.canonicalFace.eyeWhites, fixture.whites, `${label} changed the authored final eye-white registration`);
      const lid = rgbaAt(current, fixture.lid.target);
      assert.ok(lid[3] > 0 && luminance(lid) < 50, `${label} eyelid is absent or blends into skin`);
      if (eyeStyle === 'classic') assert.deepEqual(lid, rgbaAt(original, fixture.lid.source), `${label} lost preserved eyelid linework`);
      for (const white of fixture.whites) {
        const expected = rgbaAt(original, white.source), actual = rgbaAt(current, white.target), p = white.target[1] * 192 + white.target[0];
        assert.ok(luminance(expected) > 200, 'the local feature fixture must represent actual preserved eye-white artwork');
        assert.deepEqual(actual, expected, `${label} erased or recolored an authored eye-white cell at ${white.target}`);
        assert.equal(current.materials[p], 0, `${label} eye white was assigned to skin, hair or iris`);
        assert.ok(current.protectedFaceMask[p], `${label} eye white is exposed to hairstyle replacement`);
        assert.ok(luminance(actual) - luminance(lid) > 180, `${label} eye white and lid lack readable local contrast`);
        const neighboringIris = current.irisLandmarks.filter(at => Math.max(Math.abs(at[0] - white.target[0]), Math.abs(at[1] - white.target[1])) <= 2);
        assert.ok(neighboringIris.length > 0, `${label} white and iris were separated outside their eye cluster`);
        assert.ok(neighboringIris.some(at => luminance(actual) - luminance(rgbaAt(current, at)) > 25), `${label} iris blends into the eye white`);
      }
    }
  }
});

const frontMouthFixtures = Object.freeze({
  male: [{ source: [85, 80], target: [84, 81] }, { source: [85, 80], target: [85, 81] }],
  female: [{ source: [86, 80], target: [85, 81] }, { source: [86, 80], target: [86, 81] }],
});

test('the actual front lips form a visible closed mouth above the chin on light, middle and dark skin', async () => {
  for (const sex of sexes) {
    const { original } = await independentFace(sex), fixture = frontMouthFixtures[sex];
    assert.equal(fixture[0].target[1], fixture[1].target[1]);
    assert.equal(fixture[1].target[0] - fixture[0].target[0], 1);
    for (const hairstyle of ids('hairstyle')) for (const eyeStyle of ids('eyeStyle')) for (const skin of ['ivory', 'copper', 'ebony']) {
      const current = await image({ sex, hairstyle, eyeStyle, skin, beard: 'none' }), label = `${sex}/${hairstyle}/${eyeStyle}/${skin}`;
      assert.deepEqual(current.canonicalFace.frontMouth, fixture, `${label} changed the authored front-lip registration`);
      for (const mark of fixture) {
        const expected = rgbaAt(original, mark.source), actual = rgbaAt(current, mark.target), p = mark.target[1] * 192 + mark.target[0];
        assert.deepEqual(actual, expected, `${label} lost the actual profile lip ink at ${mark.target}`);
        assert.equal(current.materials[p], 0, `${label} lip ink was recolored as skin or hair`);
        assert.ok(current.protectedFaceMask[p], `${label} front lip can be overwritten by hair`);
      }
      const skinAroundMouth = [];
      for (let y = fixture[0].target[1] - 1; y <= fixture[0].target[1] + 1; y++) {
        for (let x = fixture[0].target[0] - 1; x <= fixture[1].target[0] + 2; x++) {
          if (current.materials[y * 192 + x] === 1) skinAroundMouth.push(luminance(rgbaAt(current, [x, y])));
        }
      }
      assert.ok(skinAroundMouth.length > 0, `${label} mouth line is detached from facial skin`);
      const darkestLip = Math.min(...fixture.map(mark => luminance(rgbaAt(current, mark.target))));
      assert.ok(Math.max(...skinAroundMouth) - darkestLip > 20, `${label} the closed front mouth blends into the surrounding skin`);
    }
  }
});

test('hair caps contain no enclosed skin or iris pinholes while open hairlines remain permitted', async () => {
  for (const sex of sexes) {
    const { browRow } = await independentFace(sex);
    for (const hairstyle of ids('hairstyle').filter(id => id !== 'none')) {
      const current = await image({ sex, hairstyle });
      assert.deepEqual(enclosedCapMaterials(current, browRow), [], `${sex}/${hairstyle} has skin/iris trapped inside its hair cap`);
    }
  }
});

test('every hairstyle retains visible fixed iris pixels and eight readable eye palettes after the smaller head fit', async () => {
  for (const sex of sexes) for (const hairstyle of ids('hairstyle')) for (const eyeStyle of ids('eyeStyle')) {
    const variants = [];
    for (const eyes of ids('eyes')) {
      const current = await image({ sex, hairstyle, eyeStyle, eyes }), label = `${sex}/${hairstyle}/${eyeStyle}/${eyes}`;
      assert.ok(Array.isArray(current.irisLandmarks) && current.irisLandmarks.length > 0, `${label} has no surviving iris landmarks`);
      const actualIris = [];
      for (let i = 0; i < current.materials.length; i++) if (current.materials[i] === 3) actualIris.push([i % 192, Math.floor(i / 192)]);
      assert.deepEqual([...current.irisLandmarks].sort((a, b) => a[1] - b[1] || a[0] - b[0]), actualIris, `${label} iris landmarks must describe actual final iris material pixels`);
      for (const point of current.irisLandmarks) {
        assert.ok(point[0] >= 80 && point[0] <= 100 && point[1] >= 69 && point[1] <= 78, `${label} eye is outside the compact face at ${point}`);
        assert.ok(rgbaAt(current, point)[3] > 0, `${label} iris has been erased during fitting`);
        assert.ok(current.protectedFaceMask[point[1] * 192 + point[0]], `${label} eye is not protected from hair`);
      }
      variants.push(current);
    }
    const irisColors = variants.map(current => current.irisLandmarks.map(point => rgbaAt(current, point).join(',')).join('|'));
    assert.equal(new Set(irisColors).size, ids('eyes').length, `${sex}/${hairstyle}/${eyeStyle} eye colors collapse after sampling`);
    for (const current of variants.slice(1)) {
      const changed = changedPixels(variants[0], current);
      assert.ok(changed.length > 0);
      assert.ok(changed.every(i => variants[0].materials[i] === 3 && current.materials[i] === 3), `${sex}/${hairstyle}/${eyeStyle} eye color changed pixels outside the eyes`);
    }
  }
});

test('all hairstyles, expressions and facial hair have one connected final silhouette without floating pixels', async () => {
  for (const sex of sexes) for (const hairstyle of ids('hairstyle')) for (const eyeStyle of ids('eyeStyle')) for (const beard of ids('beard')) {
    const current = await image({ sex, hairstyle, eyeStyle, beard }), parts = alphaComponents(current), label = `${sex}/${hairstyle}/${eyeStyle}/${beard}`;
    assert.equal(parts.length, 1, `${label} has disconnected visible pieces: ${JSON.stringify(parts)}`);
    assert.ok(parts[0].size >= 350, `${label} cleanup must preserve a complete head`);
    assert.ok(parts[0].bounds[0] >= 65 && parts[0].bounds[2] <= 125 && parts[0].bounds[1] >= 50 && parts[0].bounds[3] <= 89, `${label} final identity is outside its registered head region`);
  }
});

test('skin and hair choices affect only their semantic materials while alpha and fixed facial ink stay stable', async () => {
  for (const sex of sexes) for (const hairstyle of ids('hairstyle')) {
    const control = await image({ sex, hairstyle, beard: 'trimmed_full' });
    assert.ok(control.materials.every(code => [0, 1, 2, 3].includes(code)));
    for (const [field, code] of [['skin', 1], ['hairColor', 2]]) {
      const distinct = new Set();
      for (const selection of ids(field)) {
        const current = await image({ sex, hairstyle, beard: 'trimmed_full', [field]: selection });
        assert.deepEqual(current.materials, control.materials, `${sex}/${hairstyle}/${field} palette must not change ownership`);
        const changes = changedPixels(control, current);
        assert.ok(changes.every(i => control.materials[i] === code), `${sex}/${hairstyle}/${field} recolored another material`);
        for (let i = 3; i < current.pixels.length; i += 4) assert.equal(current.pixels[i], control.pixels[i], `${sex}/${hairstyle}/${field} palette changed alpha`);
        distinct.add(createHash('sha256').update(current.pixels).digest('hex'));
      }
      // Female bald controls correctly have no visible customizable hair.
      const visibleMaterial = control.materials.some(material => material === code);
      assert.equal(distinct.size, visibleMaterial ? ids(field).length : 1, `${sex}/${hairstyle}/${field} choices should differ exactly when that material is visible`);
    }
  }
});

test('expression changes stay on the fixed face and never change iris color or saved female facial-hair choices', async () => {
  for (const sex of sexes) for (const hairstyle of ids('hairstyle')) {
    const classic = await image({ sex, hairstyle, eyeStyle: 'classic' });
    const sharp = await image({ sex, hairstyle, eyeStyle: 'sharp' });
    const changed = changedPixels(classic, sharp);
    assert.ok(changed.length > 0, `${sex}/${hairstyle} expression choices must remain visible`);
    assert.ok(changed.every(i => i % 192 >= 80 && i % 192 <= 100 && Math.floor(i / 192) >= 69 && Math.floor(i / 192) <= 79), `${sex}/${hairstyle} expression changed pixels outside the fixed eye region`);
    assert.deepEqual(classic.materials, sharp.materials);
    assert.deepEqual(classic.irisLandmarks, sharp.irisLandmarks);
    for (const point of classic.irisLandmarks) assert.deepEqual(rgbaAt(classic, point), rgbaAt(sharp, point), `${sex}/${hairstyle} expression erased or recolored an iris`);
    if (sex === 'female') for (const beard of ids('beard')) {
      const preserved = await image({ sex, hairstyle, beard });
      assert.deepEqual(preserved.pixels, classic.pixels, `${hairstyle} female rendering must hide saved beard=${beard}`);
    }
  }
});
