import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { normalizeAppearance, avatarChoices } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { prepareCleanAvatar } from '../src/current-avatar.js';
import { renderFighterArt } from '../src/arena.js';
import { renderFirstPersonArena } from '../src/first-person-arena.js';
import { FIRST_PERSON_PIXEL_CATALOG as pixelCatalog } from '../src/first-person-pixel-catalog.js';
import { FIRST_PERSON_WHOLE_CATALOG as wholeCatalog } from '../src/first-person-whole-catalog.js';
import { FIRST_PERSON_AXE_CATALOG as axeCatalog } from '../src/first-person-axe-catalog.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
globalThis.fetch = async input => {
  const url = new URL(input), target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== origin || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
const appearance = (sex, preset = true) => preset
  ? normalizePresetAppearance({ sex, facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' })
  : normalizeAppearance({ sex, hairstyle: 'shag', skin: 'ivory', hairColor: 'chestnut' });
const fighter = (sex, preset = true, loadout = {}) => ({ character: { name: sex, appearance: appearance(sex, preset) },
  hp: 20, loadout: { armor: 'medium', weapon: 'sword', helmet: 'none', ...loadout } });
const normalizedArt = html => html.replaceAll(/arena-mainhand-\d+/g, 'arena-mainhand-registered');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('both owned views preserve the exact current or legacy opponent and its helmet/equipment assembly', async () => {
  const controls = [
    fighter('male', true, { armor: 'light', helmet: 'none', weapon: 'spear' }),
    fighter('female', true, { armor: 'heavy', helmet: 'barbute', weapon: 'trident' }),
    fighter('male', false, { armor: 'heavy', helmet: 'greathelm', weapon: 'flail' }),
    fighter('female', false, { armor: 'medium', helmet: 'none', weapon: 'dagger' }),
  ];
  for (let index = 0; index < controls.length; index++) {
    const fighters = [controls[index], controls[(index + 1) % controls.length]];
    const prepared = await Promise.all(fighters.map(item => prepareCleanAvatar(item.character.appearance, 'battle', item.loadout)));
    const duel = freeze({ fighters: structuredClone(fighters), round: 3 });
    const original = structuredClone(duel);
    for (const viewerIndex of [0, 1]) {
      const opponentIndex = 1 - viewerIndex, opponent = fighters[opponentIndex], image = prepared[opponentIndex];
      const svg = renderFirstPersonArena(duel, { viewerIndex });
      const existingAssembly = renderFighterArt(opponent.character, opponent.loadout, '#436f70', false);
      assert.ok(normalizedArt(svg).includes(normalizedArt(existingAssembly)), 'The complete existing opponent assembly is inserted without changing identity or grips.');
      assert.ok(svg.includes(`href="${image.url}"`));
      assert.equal((svg.match(/class="pixel-sprite fighter-body"/g) ?? []).length, 1, 'The local player is represented by hands, and only the opponent uses a whole body.');
      assert.match(svg, new RegExp(`class="arena-fighter fp-opponent fp-effects-mirrored" data-fighter-index="${opponentIndex}"`));
      assert.match(svg, new RegExp(`class="arena-fighter fp-viewmodel" data-fighter-index="${viewerIndex}"`));
      const [px, py] = image.pivot, [gx, gy] = image.mainhandGrip;
      assert.ok(svg.includes(`class="fighter-weapon-pivot" transform="translate(${px - gx} ${gy - py})"`));
      assert.deepEqual(duel, original, 'Camera selection never changes saved identity, equipment, health, or round state.');
    }
  }
});

test('unowned and invalid first-person requests retain the public arena with two complete fighters', () => {
  const duel = { fighters: [fighter('male'), fighter('female')] };
  for (const viewerIndex of [undefined, null, -1, 2, '0', true, NaN]) {
    const svg = renderFirstPersonArena(duel, { viewerIndex });
    assert.doesNotMatch(svg, /first-person-arena|fp-viewmodel/);
    assert.match(svg, /data-fighter-index="0"/); assert.match(svg, /data-fighter-index="1"/);
  }
  assert.doesNotMatch(renderFirstPersonArena({ fighters: [] }, { viewerIndex: 0 }), /first-person-arena/);
});

test('preserved v001 fallback keeps all nine wrapped grips, net, and two-handed motion assemblies', () => {
  const silhouettes = new Set();
  for (const weapon of ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident']) {
    const duel = { fighters: [fighter('male', true, { weapon: { id: weapon } }), fighter('female')] };
    const svg = renderFirstPersonArena(duel, { viewerIndex: 0, artVersion: 'v001' });
    const dominant = svg.slice(svg.indexOf('<g class="fp-mainhand">'), svg.indexOf('<g class="fighter-effects" transform="translate(460 330)"'));
    assert.match(dominant, new RegExp(`class="fp-weapon" data-weapon-art="${weapon}"`));
    assert.ok(dominant.indexOf('class="fp-weapon"') < dominant.indexOf('class="fp-gripping-hand"'), 'Fingers visibly wrap in front of the handle.');
    assert.match(dominant, /M-4 (?:21|59) H4 V-22 H-4 Z|M-3 (?:25|59) V-\d+ H3 V(?:25|59) Z/, 'Each authored handle crosses the fixed hand grip at [0,0].');
    assert.match(svg, /fp-mainhand-motion/);
    const twoHanded = weapon === 'halberd' || weapon === 'greatsword';
    assert.ok(svg.includes(`translate(685 ${twoHanded ? 334 : 354}) scale(2)`));
    if (twoHanded) {
      assert.match(dominant, /class="fp-supporting-hand" data-grip="0 36"/);
      assert.match(dominant, /transform="translate\(0 36\) scale\(-1 1\)"/);
      assert.doesNotMatch(svg, /fp-offhand-motion/);
      assert.equal((dominant.match(/class="fp-gripping-hand"/g) ?? []).length, 2, 'Both grips share the same articulated weapon assembly.');
    } else {
      assert.match(svg, /translate\(235 356\) scale\(2\)/);
      assert.match(svg, /fp-offhand-motion/);
    }
    assert.equal(svg.includes('class="fp-net"'), weapon === 'trident');
    assert.equal(svg.includes('class="fp-shield"'), weapon !== 'trident' && !twoHanded);
    silhouettes.add(dominant);
  }
  assert.equal(silhouettes.size, 9, 'Each equipment choice has its own readable silhouette.');
});

test('preserved v002 hands follow saved skin and armor choices while labels remain safe SVG text', () => {
  for (const skin of avatarChoices.skin) {
    const player = fighter('female', true, { armor: { id: 'plate' } });
    player.character.appearance.skin = skin.id;
    player.character.name = '<script>alert("bad")</script> & \'fighter\'';
    const svg = renderFirstPersonArena({ fighters: [player, fighter('male')] }, { viewerIndex: 0, fit: 'slice', artVersion: 'v002' });
    assert.match(svg, /data-armor="heavy"/);
    assert.ok(svg.includes(`href="${pixelCatalog.parts.hand.variants[skin.id]}"`));
    assert.ok(svg.includes(`href="${pixelCatalog.parts.fingers.variants[skin.id]}"`));
    assert.ok(svg.includes(`href="${pixelCatalog.parts.bracer.variants.heavy}"`));
    assert.doesNotMatch(svg, /<script>/);
    assert.match(svg, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt; &amp; &#39;fighter&#39;/);
    assert.match(svg, /preserveAspectRatio="xMidYMid slice"/);
  }
});

test('pixel catalog and every registered raster retain full native frames and sealed weapon hashes', async () => {
  const json = JSON.parse(await fs.readFile(path.join(project, 'assets/first-person/v002/manifest.json'), 'utf8'));
  assert.deepEqual(pixelCatalog, json, 'Browser-compatible metadata exactly matches the preparation manifest.');
  assert.equal(pixelCatalog.nativeDisplayScale, 2);
  assert.equal(pixelCatalog.alphaThreshold, 128);
  assert.deepEqual(Object.keys(pixelCatalog.weapons).sort(), ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident'].sort());
  assert.deepEqual(Object.keys(pixelCatalog.parts.hand.variants), avatarChoices.skin.map(item => item.id));
  assert.deepEqual(Object.keys(pixelCatalog.parts.bracer.variants), ['light', 'medium', 'heavy']);
  for (const part of [...Object.values(pixelCatalog.parts), ...Object.values(pixelCatalog.weapons), ...Object.values(pixelCatalog.offhands)]) {
    assert.ok(part.grip.every((value, index) => Number.isInteger(value) && value >= 0 && value < [part.width, part.height][index]));
    for (const url of part.variants ? Object.values(part.variants) : [part.url]) {
      assert.match(url, /^\/assets\/first-person\/v002\/[a-z-]+\.png$/);
      const bytes = await fs.readFile(path.join(project, url.slice(1)));
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      assert.equal(bytes.readUInt32BE(16), part.width);
      assert.equal(bytes.readUInt32BE(20), part.height);
      if (part.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256);
    }
  }
});

test('preserved v002 weapons keep skin, cuff and wrapped fingers on their shared moving grips', () => {
  for (const [weapon, part] of Object.entries(pixelCatalog.weapons)) {
    for (const skin of avatarChoices.skin) for (const armor of ['light', 'medium', 'heavy']) {
      const player = fighter('male', true, { weapon, armor });
      player.character.appearance.skin = skin.id;
      const duel = freeze({ fighters: [player, fighter('female')], round: 1 });
      for (const viewerIndex of [0, 1]) {
        const local = viewerIndex ? freeze({ fighters: [duel.fighters[1], player], round: 1 }) : duel;
        const svg = renderFirstPersonArena(local, { viewerIndex, artVersion: 'v002' });
        assert.match(svg, /data-viewmodel-version="v002"/);
        const dominant = svg.slice(svg.indexOf('<g class="fp-mainhand">'), svg.indexOf('<g class="fighter-effects" transform="translate(460 330)"'));
        assert.ok(dominant.includes(`href="${part.url}" x="${-part.grip[0]}" y="${-part.grip[1]}" width="${part.width}" height="${part.height}"`));
        assert.ok(dominant.indexOf('data-pixel-layer="skin-arm"') < dominant.indexOf('data-pixel-layer="weapon"'));
        assert.ok(dominant.indexOf('data-pixel-layer="weapon"') < dominant.indexOf('class="fp-gripping-hand"'));
        assert.ok(dominant.includes(pixelCatalog.parts.hand.variants[skin.id]));
        assert.ok(dominant.includes(pixelCatalog.parts.bracer.variants[armor]));
        assert.ok(dominant.includes(pixelCatalog.parts.fingers.variants[skin.id]));
        assert.doesNotMatch(dominant, /rotate\(14\)/, 'Idle pixels remain unrotated; source art owns its perspective.');
        if (part.secondGrip) {
          const delta = part.secondGrip.map((value, index) => value - part.grip[index]);
          assert.ok(dominant.includes(`data-grip="${delta.join(' ')}" transform="translate(${delta.join(' ')}) scale(-.75 .75)"`));
          assert.match(dominant, /class="fp-weapon-depth"><g class="fp-weapon"[\s\S]+class="fp-supporting-hand"[\s\S]+<\/g><\/g><g class="fp-gripping-hand">/, 'Projection keeps the far hand inside the weapon depth group and the near hand on its fixed grip.');
          assert.equal((dominant.match(/class="fp-gripping-hand"/g) ?? []).length, 2);
          assert.doesNotMatch(svg, /fp-offhand-motion/);
          assert.ok(svg.includes(`translate(${weapon === 'halberd' ? '650 340' : '600 340'}) scale(2)`));
        } else {
          assert.match(svg, /fp-offhand-motion/);
          assert.ok(svg.includes(pixelCatalog.offhands[weapon === 'trident' ? 'net' : 'shield'].url));
          if (weapon === 'flail') assert.ok(svg.includes('translate(755 354) scale(2)'));
        }
      }
    }
  }
});

test('complete hold catalog retains full source frames and exact prepared skin/armor image hashes', async () => {
  const json = JSON.parse(await fs.readFile(path.join(project, 'assets/first-person/v003/manifest.json'), 'utf8'));
  assert.deepEqual(wholeCatalog, json);
  assert.equal(wholeCatalog.nativeDisplayScale, 2);
  assert.deepEqual(Object.keys(wholeCatalog.holds).sort(), ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident'].sort());
  for (const [weapon, armors] of Object.entries(wholeCatalog.holds)) {
    assert.deepEqual(Object.keys(armors), ['light', 'medium', 'heavy']);
    for (const hold of Object.values(armors)) {
      assert.equal(hold.mode, weapon === 'greatsword' || weapon === 'halberd' ? 'both' : 'paired');
      assert.equal(Boolean(hold.off), hold.mode === 'paired');
      const offset = hold.cameraOffset ?? [0, 0];
      assert.equal(offset.length, 2);
      assert.ok(offset.every(Number.isFinite));
      for (const part of hold.mode === 'paired' ? [hold.main, hold.off] : [hold.main]) {
        assert.equal(part.width, 460);
        assert.equal(part.height, 220);
        assert.deepEqual(part.frameOrigin, [0, 0]);
        assert.ok(part.pivot.every((value, index) => Number.isInteger(value) && value >= 0 && value < [part.width, part.height][index]));
        assert.deepEqual(Object.keys(part.variants), avatarChoices.skin.map(item => item.id));
        for (const skin of avatarChoices.skin) {
          const url = part.variants[skin.id];
          assert.match(url, /^\/assets\/first-person\/v003\/[a-z-]+\.png$/);
          const bytes = await fs.readFile(path.join(project, url.slice(1)));
          assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
          assert.equal(bytes.readUInt32BE(16), part.width);
          assert.equal(bytes.readUInt32BE(20), part.height);
          assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256s[skin.id]);
        }
      }
    }
  }
});

test('preserved v003 complete holds retain authored idle composition without separate hands, cuffs, weapons or fitting', () => {
  for (const [weapon, armors] of Object.entries(wholeCatalog.holds)) for (const [armor, hold] of Object.entries(armors)) {
    for (const skin of avatarChoices.skin) for (const viewerIndex of [0, 1]) {
      const player = fighter('female', true, { weapon, armor });
      player.character.appearance.skin = skin.id;
      const fighters = viewerIndex ? [fighter('male'), player] : [player, fighter('male')];
      const duel = freeze({ fighters, round: 2 });
      const svg = renderFirstPersonArena(duel, { viewerIndex, artVersion: 'v003' });
      const local = svg.slice(svg.indexOf('<g class="arena-fighter fp-viewmodel"'), svg.indexOf('<g class="fighter-effects" transform="translate(460 330)"'));
      assert.match(svg, /data-viewmodel-version="v003"/);
      assert.doesNotMatch(local, /fp-forearm|fp-gripping-hand|fp-supporting-hand|fp-weapon-depth|fp-pixel-part|rotate\(|scale\(-/);
      assert.equal((local.match(/class="pixel-sprite fp-whole-hold"/g) ?? []).length, hold.mode === 'paired' ? 2 : 1);
      assert.match(local, /class="fp-mainhand-motion"/);
      assert.equal(local.includes('class="fp-offhand-motion"'), hold.mode === 'paired');
      const offset = hold.cameraOffset ?? [0, 0];
      for (const [side, part] of hold.mode === 'paired' ? [['main', hold.main], ['off', hold.off]] : [['main', hold.main]]) {
        const [x, y] = part.pivot;
        assert.ok(local.includes(`transform="translate(${x * 2 + offset[0]} ${y * 2 + offset[1]}) scale(2)"`));
        assert.ok(local.includes(`data-pixel-layer="whole-${side}" href="${part.variants[skin.id]}" x="${-x}" y="${-y}" width="460" height="220"`));
        assert.equal(x * 2 + offset[0] + 2 * -x, offset[0], 'Idle horizontal image placement cancels the animation pivot.');
        assert.equal(y * 2 + offset[1] + 2 * -y, offset[1], 'Idle vertical image placement cancels the animation pivot.');
      }
    }
  }
});

test('axe correction overlay retains all armor and skin frames, exact prepared hashes and original offhands', async () => {
  const json = JSON.parse(await fs.readFile(path.join(project, 'assets/first-person/v004/manifest.json'), 'utf8'));
  assert.deepEqual(axeCatalog, json);
  assert.equal(axeCatalog.schema, 1);
  assert.equal(axeCatalog.version, 'v004');
  assert.equal(axeCatalog.nativeDisplayScale, 2);
  assert.deepEqual(Object.keys(axeCatalog.holds), ['axe']);
  assert.deepEqual(Object.keys(axeCatalog.holds.axe), ['light', 'medium', 'heavy']);
  for (const [armor, hold] of Object.entries(axeCatalog.holds.axe)) {
    const original = wholeCatalog.holds.axe[armor];
    assert.equal(hold.mode, original.mode);
    assert.equal(hold.mode, 'paired');
    assert.deepEqual(hold.cameraOffset, original.cameraOffset);
    assert.deepEqual(hold.off, original.off, 'The complete shield, hand and sleeve remain the exact original source.');
    for (const key of ['width', 'height', 'pivot', 'frameOrigin']) {
      assert.deepEqual(hold.main[key], original.main[key], `Correction keeps the original ${key} registration.`);
    }
    assert.deepEqual(Object.keys(hold.main.variants), avatarChoices.skin.map(item => item.id));
    for (const skin of avatarChoices.skin) {
      const url = hold.main.variants[skin.id];
      assert.match(url, /^\/assets\/first-person\/v004\/axe-[a-z-]+\.png$/);
      const bytes = await fs.readFile(path.join(project, url.slice(1)));
      assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
      assert.equal(bytes.readUInt32BE(16), 460);
      assert.equal(bytes.readUInt32BE(20), 220);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hold.main.sha256s[skin.id]);
      assert.notEqual(hold.main.sha256s[skin.id], original.main.sha256s[skin.id], 'Each skin variant includes the corrected head.');
    }
  }
});

test('default axe uses corrected complete holds in both seats while explicit v003 and other weapons remain exact', () => {
  const stableSvg = svg => normalizedArt(svg).replaceAll(/first-person-\d+/g, 'first-person-registered');
  for (const [weapon, armors] of Object.entries(wholeCatalog.holds)) for (const armor of Object.keys(armors)) {
    for (const skin of avatarChoices.skin) for (const viewerIndex of [0, 1]) {
      const player = fighter('female', true, { weapon, armor });
      player.character.appearance.skin = skin.id;
      const fighters = viewerIndex ? [fighter('male'), player] : [player, fighter('male')];
      const duel = freeze({ fighters, round: 2 }), before = structuredClone(duel);
      const svg = renderFirstPersonArena(duel, { viewerIndex });
      const original = renderFirstPersonArena(duel, { viewerIndex, artVersion: 'v003' });
      if (weapon !== 'axe') {
        assert.equal(stableSvg(svg), stableSvg(original), 'Unchanged weapons use their exact existing composition.');
      } else {
        const hold = axeCatalog.holds.axe[armor], oldHold = wholeCatalog.holds.axe[armor];
        const local = svg.slice(svg.indexOf('<g class="arena-fighter fp-viewmodel"'), svg.indexOf('<g class="fighter-effects" transform="translate(460 330)"'));
        assert.match(svg, /data-viewmodel-version="v004"/);
        assert.equal(stableSvg(svg), stableSvg(renderFirstPersonArena(duel, { viewerIndex, artVersion: 'v004' })));
        assert.match(original, /data-viewmodel-version="v003"/);
        assert.ok(original.includes(`href="${oldHold.main.variants[skin.id]}"`));
        assert.doesNotMatch(original, /\/assets\/first-person\/v004\//);
        assert.doesNotMatch(local, /fp-forearm|fp-gripping-hand|fp-supporting-hand|fp-weapon-depth|fp-pixel-part|rotate\(|scale\(-/);
        assert.equal((local.match(/class="pixel-sprite fp-whole-hold"/g) ?? []).length, 2);
        assert.match(local, /class="fp-mainhand-motion"/);
        assert.match(local, /class="fp-offhand-motion"/);
        assert.ok(local.includes(`href="${hold.main.variants[skin.id]}"`));
        assert.ok(local.includes(`href="${oldHold.off.variants[skin.id]}"`));
        assert.ok(!local.includes(`href="${oldHold.main.variants[skin.id]}"`));
        const offset = hold.cameraOffset ?? [0, 0];
        for (const [side, part] of [['main', hold.main], ['off', hold.off]]) {
          const [x, y] = part.pivot;
          assert.ok(local.includes(`transform="translate(${x * 2 + offset[0]} ${y * 2 + offset[1]}) scale(2)"`));
          assert.ok(local.includes(`data-pixel-layer="whole-${side}" href="${part.variants[skin.id]}" x="${-x}" y="${-y}" width="460" height="220"`));
        }
      }
      assert.deepEqual(duel, before, 'Selecting presentation never changes fighters, equipment, health or rules.');
    }
  }
});
