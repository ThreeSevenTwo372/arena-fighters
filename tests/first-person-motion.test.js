import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeAvatarPng } from '../src/avatar.js';
import { renderFirstPersonArena } from '../src/first-person-arena.js';
import { createFirstPersonSample, renderFirstPersonPreview } from '../src/first-person-preview.js';
import { FIRST_PERSON_WHOLE_CATALOG as whole } from '../src/first-person-whole-catalog.js';
import { FIRST_PERSON_AXE_CATALOG as axe } from '../src/first-person-axe-catalog.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(project, relative), 'utf8');
const weapons = ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident'];
const armors = ['light', 'medium', 'heavy'];
const skins = ['porcelain', 'ivory', 'sand', 'copper', 'umber', 'ebony'];
const attackProfile = { sword: 'cut', spear: 'long-thrust', axe: 'chop', flail: 'flail', halberd: 'polearm',
  mace: 'chop', greatsword: 'heavy', dagger: 'thrust', trident: 'long-thrust' };

// Inspect the actual generated SVG ancestry; the same source image must sit
// beneath both the sleeve-root translation and its matching countertranslation.
function imageNodes(svg) {
  const stack = [], images = [];
  for (const match of svg.matchAll(/<(\/?)(g|image)\b([^>]*?)(\/?)>/g)) {
    if (match[1]) { if (match[2] === 'g') stack.pop(); continue; }
    const attrs = Object.fromEntries([...match[3].matchAll(/([\w-]+)="([^"]*)"/g)].map(item => [item[1], item[2]]));
    const node = { attrs, parent: stack.at(-1) };
    if (match[2] === 'g') stack.push(node);
    else if (attrs.class?.split(' ').includes('fp-whole-hold')) images.push(node);
  }
  return images;
}

function translation(value) {
  const match = value.match(/^translate\(([-\d.]+) ([-\d.]+)\)(?: scale\(([-\d.]+)\))?$/);
  assert.ok(match, `Recognized exact SVG translation: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 1)];
}

function motionRoot(image, part, cameraOffset) {
  const held = image.parent, inverse = held.parent, motion = inverse.parent;
  const root = motion.parent, idle = root.parent, outer = idle.parent;
  assert.match(motion.attrs.class, /^fp-(?:mainhand|offhand)-motion$/);
  assert.equal(root.attrs.class, 'fp-motion-root');
  assert.match(idle.attrs.class, /^fp-(?:mainhand|offhand)$/);
  const [rx, ry] = root.attrs['data-motion-root'].split(' ').map(Number);
  const [px, py] = part.pivot, [ix, iy] = translation(inverse.attrs.transform);
  const [tx, ty] = translation(root.attrs.transform), [ox, oy, scale] = translation(outer.attrs.transform);
  assert.deepEqual([tx, ty], [rx - px, ry - py]);
  assert.deepEqual([ix, iy], [px - rx, py - ry]);
  assert.equal(scale, 2);
  assert.deepEqual([ox, oy], [2 * px + cameraOffset[0], 2 * py + cameraOffset[1]]);
  assert.deepEqual([ox + scale * (tx + ix + Number(image.attrs.x)),
    oy + scale * (ty + iy + Number(image.attrs.y))], cameraOffset,
  'Moving the animation origin leaves original full-frame registration unchanged.');
  return [rx, ry];
}

test('complete arms keep source frames and grip registration beneath camera-side motion roots in either seat', () => {
  for (const weapon of weapons) for (const armor of armors) for (const skin of skins) for (const viewerIndex of [0, 1]) {
    const duel = createFirstPersonSample({ weapon, armor, skin }), before = structuredClone(duel);
    const hold = weapon === 'axe' ? axe.holds.axe[armor] : whole.holds[weapon][armor];
    const svg = renderFirstPersonArena(duel, { viewerIndex }), images = imageNodes(svg);
    assert.equal(images.length, hold.mode === 'both' ? 1 : 2);
    for (const image of images) {
      const side = image.attrs['data-pixel-layer'].slice('whole-'.length), part = hold[side];
      assert.equal(image.attrs.href, part.variants[skin]);
      assert.deepEqual([Number(image.attrs.x), Number(image.attrs.y)], part.frameOrigin.map((v, i) => v - part.pivot[i]));
      assert.deepEqual([Number(image.attrs.width), Number(image.attrs.height)], [460, 220]);
      motionRoot(image, part, hold.cameraOffset ?? [0, 0]);
    }
    assert.doesNotMatch(svg, /\sstyle=|fp-whole-hold[^>]+(?:rotate|skew)/);
    assert.deepEqual(duel, before, 'Rendering a motion origin never changes combat, equipment or identity data.');
  }
});

// Continuous linear interpolation is intentional: checking only the authored
// keyframes misses a crop edge that rotates briefly into the middle of the view.
function expression(value, rest) {
  const expression = value.replaceAll('var(--fp-rest-x)', String(rest)).replaceAll('px', '').replaceAll('calc(', '').replaceAll(')', '').trim();
  assert.match(expression, /^[-+\d. ]+$/);
  return [...expression.matchAll(/[+-]?\s*\d+(?:\.\d+)?/g)].reduce((sum, term) => sum + Number(term[0].replaceAll(' ', '')), 0);
}

function pose(value, rest, variables = {}) {
  value = value.replaceAll(/var\((--[\w-]+)(?:,\s*([^)]*))?\)/g, (match, name, fallback) => variables[name] ?? fallback ?? match);
  const translate = value.match(/translate\((.+?),\s*([^)]*)\)/);
  assert.ok(translate, value);
  return [expression(translate[1], rest), expression(translate[2], rest),
    Number(value.match(/rotate\(([-\d.]+)(?:deg)?\)/)?.[1] ?? 0), Number(value.match(/scale\(([-\d.]+)\)/)?.[1] ?? 1)];
}

function keyframes(css, name, rest, variables) {
  const block = css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(block, name);
  const frames = [];
  for (const match of block[1].matchAll(/([\d%, ]+)\{([^}]+)\}/g)) {
    const transform = match[2].match(/transform:\s*([^;]+)/);
    assert.ok(transform, name);
    for (const percent of match[1].split(',')) frames.push([Number(percent.trim().replace('%', '')) / 100, ...pose(transform[1], rest, variables)]);
  }
  frames.sort((a, b) => a[0] - b[0]);
  assert.equal(frames[0][0], 0); assert.equal(frames.at(-1)[0], 1);
  return frames;
}

function declarations(css, selector) {
  const literal = selector.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${literal}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `The actual held-only selector exists: ${selector}`);
  return match[1];
}

function attackAnimation(css, weapon, mode, action) {
  const attributes = { 'data-weapon': weapon, 'data-hold-mode': mode,
    'data-animation': 'attack', 'data-combat-action': action };
  let selected, specificity = -1;
  // Resolve the matching attack rules, including comma-separated selectors,
  // so geometry checks cover the profile the runtime actually selects.
  const source = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const animation = rule[2].match(/animation(?:-name)?:\s*([\w-]+)/)?.[1];
    if (!animation) continue;
    for (const selector of rule[1].split(',')) {
      if (!selector.trim().endsWith('.fp-mainhand-motion') || !selector.includes('.fp-viewmodel[data-animation="attack"]')
        && !selector.includes('[data-animation="attack"]')) continue;
      const conditions = [...selector.matchAll(/\[([\w-]+)(?:="([^"]+)")?\]/g)];
      if (!conditions.every(([, name, value]) => Object.hasOwn(attributes, name) && (value === undefined || attributes[name] === value))) continue;
      const weight = (selector.match(/\.[\w-]+|\[/g) ?? []).length;
      if (weight >= specificity) { selected = animation; specificity = weight; }
    }
  }
  assert.ok(selected, `${weapon}/${mode}/${action} has a matching attack animation.`);
  return selected;
}

function interpolate(frames, time) {
  const index = frames.findIndex((frame, i) => i + 1 < frames.length && frame[0] <= time && frames[i + 1][0] >= time);
  if (index < 0) return frames.at(-1).slice(1);
  const a = frames[index], b = frames[index + 1], fraction = (time - a[0]) / (b[0] - a[0]);
  return a.slice(1).map((value, i) => value + fraction * (b[i + 1] - value));
}

function cutEdges(image, side, both) {
  const alpha = (x, y) => image.pixels[(y * image.width + x) * 4 + 3];
  let left = image.width, right = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (alpha(x, y)) {
    left = Math.min(left, x); right = Math.max(right, x);
  }
  const points = new Map(), add = (x, y) => points.set(`${x},${y}`, [x, y]);
  // Authored cropped sleeves terminate at the outer opaque source columns in
  // the lower forearm band, and at the image's bottom row. Weapon silhouettes
  // above that band are not shoulder cutoffs and may remain in the arena.
  for (let y = 130; y < image.height; y++) {
    if (side === 'main' && alpha(right, y)) add(right, y);
    if ((side === 'off' || both && left <= 21) && alpha(left, y)) add(left, y);
  }
  for (let x = 0; x < image.width; x++) if (alpha(x, image.height - 1)) add(x, image.height - 1);
  assert.ok(points.size, 'The preserved complete-arm source has a measurable camera cutoff.');
  return [...points.values()];
}

test('authored arm cutoffs remain beyond the frame through every complete-hold attack, guard, focus, recoil, finisher and fall', async () => {
  const css = await read('src/first-person-animation.css');
  for (const weapon of weapons) for (const armor of armors) {
    const hold = weapon === 'axe' ? axe.holds.axe[armor] : whole.holds[weapon][armor];
    for (const action of ['strike', 'technique']) assert.equal(attackAnimation(css, weapon, hold.mode, action),
      `fp-held-${weapon === 'sword' && action === 'technique' ? 'feint' : attackProfile[weapon]}`,
      'The sampled motion profile is the attack selected by the actual runtime CSS.');
    const nodes = imageNodes(renderFirstPersonArena(createFirstPersonSample({ weapon, armor }), { viewerIndex: 0 }));
    for (const imageNode of nodes) {
      const side = imageNode.attrs['data-pixel-layer'].slice('whole-'.length), part = hold[side];
      const bytes = await fs.readFile(path.join(project, part.variants.ivory.slice(1)));
      const image = await decodeAvatarPng(new Uint8Array(bytes));
      const points = cutEdges(image, side, hold.mode === 'both'), root = motionRoot(imageNode, part, hold.cameraOffset ?? [0, 0]);
      const rest = hold.mode === 'both' ? 0 : side === 'main' ? 24 : -24;
      const names = side === 'main' ? [`fp-held-${attackProfile[weapon]}`, 'fp-held-focus', 'fp-held-recoil', 'fp-held-fall'] : ['fp-held-brace', 'fp-held-focus', 'fp-held-fall'];
      if (side === 'main' && weapon === 'sword') names.push('fp-held-feint');
      if (side === 'off' && weapon === 'trident') names.push('fp-held-net');
      const profiles = names.map(name => [name, keyframes(css, name, rest)]);
      const guardSelector = side === 'off'
        ? '.first-person-stage .fp-viewmodel[data-hold-mode="paired"][data-guarding="true"] .fp-offhand-motion'
        : `.first-person-stage .fp-viewmodel[data-hold-mode="${hold.mode}"][data-riposting="true"] .fp-mainhand-motion`;
      const guard = declarations(css, guardSelector).match(/transform:\s*([^;]+)/);
      assert.ok(guard);
      profiles.push(['guard', [[0, rest, 12, 0, 1], [1, ...pose(guard[1], rest)]]]);
      if (side === 'main') {
        const selectors = [`.fp-execution-playback .fp-viewmodel[data-hold-mode="${hold.mode}"]`];
        if (weapon === 'halberd') selectors.push('.fp-execution-playback .fp-viewmodel[data-hold-mode="both"][data-weapon="halberd"]');
        const variables = Object.assign({}, ...selectors.map(selector => Object.fromEntries(
          [...declarations(css, selector).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]))));
        for (const name of ['fp-finisher-ready', 'fp-finisher-strike', 'fp-finisher-settle']) profiles.push([name, keyframes(css, name, rest, variables)]);
      }
      for (const [name, frames] of profiles) {
        for (let tick = 0; tick <= 1000; tick++) {
          const [tx, ty, angle, scale] = interpolate(frames, tick / 1000), radians = angle * Math.PI / 180;
          const cosine = Math.cos(radians), sine = Math.sin(radians);
          for (const [px, py] of points) {
            const dx = px - root[0], dy = py - root[1], offset = hold.cameraOffset ?? [0, 0];
            const x = root[0] + (dx * cosine - dy * sine) * scale + tx + offset[0] / 2;
            const y = root[1] + (dx * sine + dy * cosine) * scale + ty + offset[1] / 2;
            if (x > 0 && x < 460 && y > 0 && y < 220) assert.fail(
              `${weapon}/${armor}/${side} ${name} at ${tick / 10}% exposes source cutoff [${px},${py}] at [${x.toFixed(3)},${y.toFixed(3)}].`);
          }
        }
      }
    }
  }
});

test('complete-hold movement retains resolved attack contact timing and smooth recovery while legacy routes keep their rigs', async () => {
  const css = await read('src/first-person-animation.css'), playback = await read('src/battle-animation.js');
  assert.match(css, /animation:\s*fp-held-cut 665ms linear both/);
  assert.match(css, /animation:\s*fp-held-heavy 665ms linear both/);
  assert.match(playback, /pause\(reduce \? 90 : 285, signal\)/);
  for (const profile of new Set(Object.values(attackProfile).concat(['feint']))) {
    assert.ok(keyframes(css, `fp-held-${profile}`, 24).some(frame => frame[0] === .43), `The ${profile} contact frame stays aligned with resolved damage.`);
  }
  for (const artVersion of ['v001', 'v002']) for (const weapon of weapons) for (const armor of armors) for (const viewerIndex of [0, 1]) {
    const svg = renderFirstPersonArena(createFirstPersonSample({ weapon, armor }), { viewerIndex, artVersion });
    assert.match(svg, new RegExp(`data-viewmodel-version="${artVersion}"`));
    assert.doesNotMatch(svg, /fp-motion-root|data-hold-mode|fp-whole-hold/);
  }
});

test('attack frame inspection remains optional disposable presentation with the existing external-style CSP', async () => {
  const duel = createFirstPersonSample(), before = structuredClone(duel);
  const standard = renderFirstPersonPreview(duel), inspected = renderFirstPersonPreview(duel, { inspect: true, frame: 67 });
  assert.match(standard, /id="fp-art-inspect" type="checkbox">/);
  assert.match(standard, /id="fp-art-frame"[^>]* disabled/);
  assert.match(inspected, /id="fp-art-inspect" type="checkbox" checked/);
  assert.match(inspected, /id="fp-art-frame"[^>]*value="67"/);
  assert.match(inspected, /Disposable art controls/);
  assert.deepEqual(duel, before);
  const preview = await read('src/first-person-preview.js'), server = await read('server.mjs');
  assert.match(preview, /if \(inspect && \(cue === 'strike' \|\| cue === 'technique'\)\)/);
  assert.match(preview, /frame = Math\.max\(0, Math\.min\(100,/);
  assert.doesNotMatch(preview, /fetch\(|sessionStorage|localStorage|online\/|\.local-data/);
  assert.match(server, /script-src 'self'; style-src 'self'; img-src 'self' data:/);
  assert.doesNotMatch(server, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(inspected, /\sstyle=/);
});
