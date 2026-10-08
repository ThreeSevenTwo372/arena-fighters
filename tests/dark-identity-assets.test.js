import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { avatarChoices } from '../src/avatar.js';
import { composeDarkIdentityPixels, preloadDarkIdentity } from '../src/dark-identity.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.fetch = async input => {
  const target = path.resolve(project, `.${decodeURIComponent(new URL(input).pathname)}`);
  if (!target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
const hash = image => createHash('sha256').update(image.pixels).digest('hex');

test('all newly authored head and beard textures have a closed hash roster', async () => {
  const catalog = await preloadDarkIdentity();
  const entries = [...Object.values(catalog.identities).flatMap(styles => Object.values(styles).flatMap(phases => Object.values(phases))), ...Object.values(catalog.beards).flatMap(phases => Object.values(phases))];
  assert.equal(entries.length, 42);
  const names = entries.map(entry => path.basename(entry.url)).sort();
  assert.deepEqual((await fs.readdir(path.join(project, 'assets/clean-gladiator/v003/identities'))).filter(name => name.endsWith('.png')).sort(), names);
  for (const entry of entries) {
    const bytes = await fs.readFile(path.join(project, `.${entry.url}`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.url);
  }
});

test('every new hairstyle joins the same neck anchor in portrait and arena views', async () => {
  for (const sex of ['male', 'female']) for (const { id } of avatarChoices.hairstyle) for (const phase of ['portrait', 'chibi']) {
    const image = await composeDarkIdentityPixels({ sex, hairstyle: id }, phase);
    const [x, y] = image.anchor;
    assert.deepEqual(image.anchor, phase === 'portrait' ? [256, 420] : [96, 86], `${sex}/${id}/${phase}`);
    assert.deepEqual([image.width, image.height], phase === 'portrait' ? [512, 640] : [192, 160]);
    let alpha = 0;
    for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) alpha += image.pixels[(yy * image.width + xx) * 4 + 3];
    assert.ok(alpha > 500, `${sex}/${id}/${phase} has no neck at its registered body join`);
  }
});

test('arena skulls keep the smaller body-fitting proportions', async () => {
  for (const sex of ['male', 'female']) {
    const image = await composeDarkIdentityPixels({ sex, hairstyle: 'none' }, 'chibi');
    let left = image.width, top = image.height, right = 0, bottom = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] < 80) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
    assert.ok(right - left + 1 >= 27 && right - left + 1 <= 31, `${sex} skull must remain about 28-30 pixels wide`);
    assert.ok(bottom - top + 1 >= 30 && bottom - top + 1 <= 36, `${sex} head and neck must fit the arena body`);
    assert.ok(bottom >= 84 && bottom <= 87, `${sex} neck must keep its body join`);
  }
});

test('all selectable skin, hair and eye palettes remain distinct on the new faces', async () => {
  for (const [field, selected] of [['skin', 'skin'], ['hairColor', 'hairColor'], ['eyes', 'eyes']]) {
    const rendered = [];
    for (const { id } of avatarChoices[field]) rendered.push(hash(await composeDarkIdentityPixels({ sex: 'male', hairstyle: 'shag', [selected]: id }, 'chibi')));
    assert.equal(new Set(rendered).size, avatarChoices[field].length, `${field} choices must not collapse to identical images`);
  }
  assert.notEqual(hash(await composeDarkIdentityPixels({ eyeStyle: 'classic' })), hash(await composeDarkIdentityPixels({ eyeStyle: 'sharp' })));
});

test('redesigned facial-hair choices remain visible for men and hidden for women', async () => {
  const male = [], female = [];
  for (const { id } of avatarChoices.beard) {
    const man = await composeDarkIdentityPixels({ sex: 'male', beard: id }, 'chibi');
    assert.equal(man.facialHairAvailable, true);
    male.push(hash(man));
    female.push(hash(await composeDarkIdentityPixels({ sex: 'female', beard: id }, 'chibi')));
  }
  assert.equal(new Set(male).size, 4);
  assert.equal(new Set(female).size, 1);
});
