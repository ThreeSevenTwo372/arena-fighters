import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDuel } from '../src/combat.js';
import { decodeAvatarPng } from '../src/avatar.js';
import { prepareCleanAvatar, getCleanAvatarImage } from '../src/current-avatar.js';
import { renderArena } from '../src/arena.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const asset = url => fs.readFile(path.resolve(project, `.${new URL(url, 'http://127.0.0.1:4173').pathname}`));
globalThis.fetch = async input => {
  const url = new URL(input), target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== 'http://127.0.0.1:4173' || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};

const decodeEntities = value => value.replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parseSvg(html) {
  const root = { tag: 'root', attrs: {}, children: [], parent: null };
  const stack = [root];
  for (const token of html.matchAll(/<\/?[\w-]+\b[^>]*>/g)) {
    const raw = token[0];
    if (raw.startsWith('</')) { stack.pop(); continue; }
    const tag = raw.match(/^<([\w-]+)/)[1];
    const attrs = Object.fromEntries([...raw.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [name, decodeEntities(value)]));
    const parent = stack.at(-1), node = { tag, attrs, children: [], parent };
    parent.children.push(node);
    if (!raw.endsWith('/>')) stack.push(node);
  }
  return root;
}
const descendants = node => node.children.flatMap(child => [child, ...descendants(child)]);
const byClass = (node, name) => descendants(node).find(child => child.attrs.class?.split(/\s+/).includes(name));
const identity = [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
function transform(value = '') {
  let matrix = identity;
  for (const [, operation, raw] of value.matchAll(/(translate|scale|rotate)\(([^)]+)\)/g)) {
    const numbers = raw.trim().split(/[\s,]+/).map(Number);
    let next;
    if (operation === 'translate') next = [1, 0, 0, 1, numbers[0], numbers[1] ?? 0];
    else if (operation === 'scale') next = [numbers[0], 0, 0, numbers[1] ?? numbers[0], 0, 0];
    else {
      const angle = numbers[0] * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
      next = [cosine, sine, -sine, cosine, 0, 0];
      if (numbers.length === 3) next = multiply(multiply([1, 0, 0, 1, numbers[1], numbers[2]], next), [1, 0, 0, 1, -numbers[1], -numbers[2]]);
    }
    matrix = multiply(matrix, next);
  }
  return matrix;
}
function globalMatrix(node) {
  if (!node.parent) return identity;
  return multiply(globalMatrix(node.parent), transform(node.attrs.transform));
}
const point = (matrix, x, y) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
const rounded = values => values.map(value => Math.round(value * 1e9) / 1e9);

function character(sex, preset) {
  return { name: `${sex} ${preset ? 'preset' : 'legacy'}`, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
    trait: 'balanced', color: '#b45143', appearance: { sex, ...(preset ? { facePreset: 'p05' } : { hairstyle: 'braided_ponytail' }), skin: 'ivory', hairColor: 'chestnut', eyes: 'amber' } };
}

async function renderedPair(sex, armor, preset, weapon = 'sword') {
  const characters = [character(sex, preset), character(sex, preset)];
  const gear = { weapon, armor, helmet: 'none' };
  await prepareCleanAvatar(characters[0].appearance, 'battle', gear);
  const image = getCleanAvatarImage(characters[0].appearance, 'battle', gear);
  const duel = createDuel(characters.map(character => ({ character, ...gear })));
  return { image, duel, tree: parseSvg(renderArena(duel, { fit: 'meet' })) };
}

test('registered moving hand preserves every source cell at rest for both facings and all six bodies', async () => {
  for (const preset of [false, true]) for (const sex of ['male', 'female']) for (const armor of ['light', 'medium', 'heavy']) {
    const { image, tree } = await renderedPair(sex, armor, preset);
    const hands = await decodeAvatarPng(new Uint8Array(await asset(image.handsImage.url)));
    const fighters = descendants(tree).filter(node => node.attrs.class?.split(/\s+/).includes('arena-fighter'));
    assert.equal(fighters.length, 2);
    for (const fighter of fighters) {
      const body = byClass(fighter, 'fighter-body');
      const handPivot = byClass(fighter, 'fighter-front-hand-pivot');
      const weaponPivot = byClass(fighter, 'fighter-weapon-pivot');
      const handMotion = byClass(fighter, 'fighter-front-hand-motion');
      const hand = handMotion?.children.find(node => node.tag === 'image');
      assert.ok(handPivot && handMotion && hand, `${sex}/${armor} has an independently registered hand layer`);
      assert.deepEqual(transform(handPivot.attrs.transform), transform(weaponPivot.attrs.transform), 'Weapon and hand rotate about the same authored grip');
      assert.equal(hand.attrs.href, image.handsImage.url);
      assert.deepEqual([Number(hand.attrs.width), Number(hand.attrs.height)], [hands.width, hands.height]);
      const handMatrix = globalMatrix(hand), bodyMatrix = globalMatrix(body);
      let ownedCells = 0;
      for (let y = 0; y < hands.height; y++) for (let x = 0; x < hands.width; x++) {
        if (!hands.pixels[(y * hands.width + x) * 4 + 3]) continue;
        ownedCells++;
        const actual = point(handMatrix, Number(hand.attrs.x) + x, Number(hand.attrs.y) + y);
        const original = point(bodyMatrix, Number(body.attrs.x) + x, Number(body.attrs.y) + y);
        assert.deepEqual(rounded(actual), rounded(original), `${sex}/${armor}/${preset ? 'preset' : 'legacy'} cell ${x},${y} resting parity`);
      }
      assert.ok(ownedCells > 0);
      assert.equal(body.attrs.href, image.url, 'The exact prepared full identity remains the body source');
    }
  }
});

test('every hand overlay is exact duplicated source material confined to its recorded mainhand bounds', async () => {
  const catalog = JSON.parse(await fs.readFile(path.join(project, 'assets/clean-gladiator/v013/manifest.json'), 'utf8'));
  for (const sex of ['male', 'female']) for (const armor of ['light', 'medium', 'heavy']) {
    const entry = catalog.bodies[sex][armor];
    const [body, hands] = await Promise.all([entry.url, entry.handsUrl].map(async url => decodeAvatarPng(new Uint8Array(await asset(url)))));
    assert.deepEqual([hands.width, hands.height], [body.width, body.height]);
    const [left, top, right, bottom] = entry.handOverlayBounds;
    let count = 0, fractional = 0;
    for (let y = 0; y < hands.height; y++) for (let x = 0; x < hands.width; x++) {
      const offset = (y * hands.width + x) * 4, alpha = hands.pixels[offset + 3];
      if (!alpha) continue;
      count++;
      if (alpha < 255) fractional++;
      assert.ok(x >= left && x < right && y >= top && y < bottom, `${sex}/${armor} ownership cannot spread beyond the authored hand`);
      assert.deepEqual(hands.pixels.subarray(offset, offset + 4), body.pixels.subarray(offset, offset + 4));
    }
    assert.ok(count > 0 && fractional > 0, 'Fractional edge pixels require exact ownership and preserved resting double composition');
  }
});

test('ownership masks remove exactly nonzero hand alpha instead of erasing a rectangular body patch', async () => {
  const { image, tree } = await renderedPair('female', 'heavy', true);
  const hands = await decodeAvatarPng(new Uint8Array(await asset(image.handsImage.url)));
  const fighters = descendants(tree).filter(node => node.attrs.class?.split(/\s+/).includes('arena-fighter'));
  const maskIds = new Set();
  for (const fighter of fighters) {
    const body = byClass(fighter, 'fighter-body');
    const mask = descendants(fighter).find(node => node.tag === 'mask');
    const filter = descendants(fighter).find(node => node.tag === 'filter');
    const handMaskImage = mask.children.find(node => node.tag === 'image');
    const alphaFunction = descendants(filter).find(node => node.tag === 'feFuncA');
    const values = alphaFunction.attrs.tableValues.trim().split(/\s+/).map(Number);
    assert.equal(alphaFunction.attrs.type, 'discrete');
    assert.equal(handMaskImage.attrs.href, image.handsImage.url);
    assert.equal(handMaskImage.attrs['image-rendering'], 'pixelated');
    assert.equal(handMaskImage.attrs.filter, `url(#${filter.attrs.id})`);
    assert.equal(mask.attrs.maskUnits, 'userSpaceOnUse');
    assert.equal(mask.attrs['mask-type'], 'luminance');
    assert.equal(maskIds.has(mask.attrs.id), false, 'Each fighter owns its mask rather than sharing another figure’s registration');
    maskIds.add(mask.attrs.id);
    assert.ok(body.attrs.style.includes(`url(#${mask.attrs.id})`));
    assert.equal(body.attrs.mask, undefined, 'Resting SVG has no immediately applied mask');
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.equal(Number(handMaskImage.attrs[key]), Number(body.attrs[key]));
      assert.equal(Number(mask.attrs[key]), Number(body.attrs[key]));
    }
    const white = mask.children.find(node => node.tag === 'rect');
    assert.equal(white.attrs.fill, 'white', 'Body cells outside hand ownership remain visible');
    const color = descendants(filter).find(node => node.tag === 'feColorMatrix').attrs.values.trim().split(/\s+/).map(Number);
    assert.deepEqual(color, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0], 'Ownership is black with the original input alpha');
    // Evaluate the emitted discrete transfer for every possible source byte,
    // including the tiny fractional-alpha pixels around the hand outline.
    for (let alpha = 0; alpha <= 255; alpha++) {
      const owned = values[Math.min(values.length - 1, Math.floor(alpha / 255 * values.length))];
      assert.equal(owned, alpha === 0 ? 0 : 1, `Exact ownership for alpha byte ${alpha}`);
    }
    for (let offset = 3; offset < hands.pixels.length; offset += 4) {
      const alpha = hands.pixels[offset];
      const ownership = values[Math.min(values.length - 1, Math.floor(alpha / 255 * values.length))];
      assert.equal(1 - ownership, alpha ? 0 : 1, 'Only original hand cells are removed from the body at execution contact');
    }
  }
});

test('all seven weapons retain their textures and authored grip registration beside the unchanged hand', async () => {
  for (const sex of ['male', 'female']) for (const weapon of ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword']) {
    const { image, tree } = await renderedPair(sex, 'medium', true, weapon);
    const fighters = descendants(tree).filter(node => node.attrs.class?.split(/\s+/).includes('arena-fighter'));
    for (const fighter of fighters) {
      const weaponPivot = byClass(fighter, 'fighter-weapon-pivot');
      const handPivot = byClass(fighter, 'fighter-front-hand-pivot');
      const expected = [image.pivot[0] - image.mainhandGrip[0], image.mainhandGrip[1] - image.pivot[1]];
      assert.deepEqual(transform(weaponPivot.attrs.transform), [1, 0, 0, 1, ...expected]);
      assert.deepEqual(globalMatrix(weaponPivot), globalMatrix(handPivot), `${sex}/${weapon} hand and weapon share the registered pivot in either facing`);
      const art = byClass(fighter, 'fighter-weapon-art');
      assert.deepEqual(transform(art.attrs.transform), transform(`rotate(${-image.weaponAngle})`));
      const textures = descendants(art).filter(node => node.tag === 'image');
      const originals = image.weaponImage.parts ? Object.values(image.weaponImage.parts) : [image.weaponImage];
      assert.equal(textures.length, originals.length);
      for (const source of originals) {
        const texture = textures.find(node => node.attrs.href === source.url);
        assert.ok(texture, `${weapon} retains ${source.url}`);
        assert.deepEqual([Number(texture.attrs.width), Number(texture.attrs.height)], [source.width, source.height]);
      }
    }
  }
});
