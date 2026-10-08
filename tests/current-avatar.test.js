import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAppearance } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { createDuel } from '../src/combat.js';
import { preloadCleanArt, prepareCleanAvatar, getCleanAvatarImage, renderCleanAvatar } from '../src/current-avatar.js';
import { renderArmory } from '../src/armory.js';
import { renderArena } from '../src/arena.js';
import { renderTournamentLobby, renderTournamentSpectator } from '../src/tournament-view.js';
import { createSpectatorSample } from '../src/spectator-preview.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:4173';
const requests = [];
globalThis.fetch = async input => {
  const url = new URL(input), target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  requests.push(url.pathname);
  if (url.origin !== origin || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
const historical = await import('../src/arena-avatar.js?current-test-v006-control');
const latest = await import('../src/arena-avatar.js?current-test-v013-control');
await historical.preloadCleanArt({ manifestUrl: '/assets/clean-gladiator/v006/manifest.json' });
await latest.preloadCleanArt({ manifestUrl: '/assets/clean-gladiator/v013/manifest.json' });
const gear = { weapon: 'sword', armor: 'medium', helmet: 'none' };
const character = (name, appearance) => ({ name, appearance, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });

test('the ordinary current catalog loads v013 without a review flag', async () => {
  const catalog = await preloadCleanArt();
  assert.equal(catalog.identityMode, 'preset-faces-v1');
  assert.deepEqual(catalog.identityOffsetBySex, { male: [0, 3], female: [0, 3] });
  assert.deepEqual(catalog.helmetTransformBySex.female.scale, .756);
  assert.ok(requests.includes('/assets/clean-gladiator/v013/manifest.json'));
});

test('mixed legacy and preset recipes retain exact historical and latest assembled pixels', async () => {
  for (const sex of ['male', 'female']) {
    const legacy = normalizeAppearance({ sex, hairstyle: 'braided_ponytail', eyeStyle: 'sharp', beard: 'trimmed_full', skin: 'copper', hairColor: 'silver', eyes: 'jade' });
    const current = normalizePresetAppearance({ ...legacy, facePreset: 'p10' });
    const snapshot = structuredClone({ legacy, current });
    const [oldControl, newControl] = await Promise.all([
      historical.prepareCleanAvatar(legacy, 'battle', gear), latest.prepareCleanAvatar(current, 'battle', gear),
    ]);
    const oldImage = await prepareCleanAvatar(legacy, 'world', gear);
    const newImage = await prepareCleanAvatar(current, 'world', gear);
    assert.equal(oldImage.url, oldControl.url, `${sex}: survivor artwork is byte-identical to v006`);
    assert.equal(newImage.url, newControl.url, `${sex}: new identity is byte-identical to v013`);
    assert.deepEqual(oldImage.appearance, legacy);
    assert.deepEqual(newImage.appearance, current);
    assert.deepEqual(oldImage.assembledIdentityAnchor, [93, 86]);
    assert.deepEqual(newImage.assembledIdentityAnchor, [93, 89]);
    assert.notEqual(newImage.url, oldImage.url);
    assert.equal(getCleanAvatarImage(legacy, 'battle', gear), oldImage);
    assert.equal(getCleanAvatarImage(current, 'battle', gear), newImage);
    assert.equal(await prepareCleanAvatar(legacy, 'battle', gear), oldImage, 'preset preparation does not replace the survivor cache');
    assert.deepEqual({ legacy, current }, snapshot, 'rendering does not migrate or rewrite either saved recipe');
  }
});

test('current helmets replace preset identities while legacy helmet pixels remain unchanged', async () => {
  for (const sex of ['male', 'female']) for (const helmet of ['closed_bascinet', 'barbute', 'greathelm']) {
    const legacy = normalizeAppearance({ sex, hairstyle: 'high_ponytail', beard: 'trimmed_full' });
    const first = normalizePresetAppearance({ ...legacy, facePreset: 'p01' });
    const last = normalizePresetAppearance({ ...legacy, facePreset: 'p10' });
    const coveredGear = { ...gear, helmet };
    const [oldImage, oldControl, covered, another] = await Promise.all([
      prepareCleanAvatar(legacy, 'battle', coveredGear), historical.prepareCleanAvatar(legacy, 'battle', coveredGear),
      prepareCleanAvatar(first, 'battle', coveredGear), prepareCleanAvatar(last, 'battle', coveredGear),
    ]);
    assert.equal(oldImage.url, oldControl.url, `${sex}/${helmet}: original survivor helmet fit survives`);
    assert.equal(covered.url, another.url, `${sex}/${helmet}: preset face and hair are completely hidden`);
    assert.equal(covered.appearance.facePreset, 'p01'); assert.equal(another.appearance.facePreset, 'p10');
    assert.equal(covered.helmetTransform.scale, sex === 'female' ? .756 : .84);
    assert.deepEqual(covered.identityOffset, [0, 3]); assert.deepEqual(oldImage.identityOffset, [0, 0]);
    const uncovered = await prepareCleanAvatar(last, 'battle', gear);
    assert.equal(uncovered.url, (await latest.prepareCleanAvatar(last, 'battle', gear)).url);
    assert.equal(uncovered.appearance.facePreset, 'p10');
    assert.notEqual(uncovered.url, another.url);
  }
});

test('armory, arena, waiting roster and live spectators share the current mixed renderer cache', async () => {
  const recipes = [
    normalizeAppearance({ sex: 'male', hairstyle: 'cropped' }),
    normalizePresetAppearance({ sex: 'female', facePreset: 'p05' }),
  ];
  const characters = recipes.map((appearance, index) => character(index ? 'New preset' : 'Surviving fighter', appearance));
  const images = await Promise.all(recipes.map(appearance => prepareCleanAvatar(appearance, 'battle', gear)));
  for (let index = 0; index < images.length; index++) {
    const output = renderArmory({ character: characters[index], gear });
    assert.ok(output.includes(images[index].url));
    assert.ok(output.includes(`data-art-version="${images[index].styleVersion}"`));
    assert.ok(renderCleanAvatar(recipes[index], 'world', gear).includes(images[index].url));
  }
  const duel = createDuel(characters.map(character => ({ character, ...gear })));
  const view = { code: 'ABC234', phase: 'battle', you: 2, currentMatchIndex: 0, bracket: [], players: characters.map(character => ({ character, alive: true })), match: { slots: [0, 1], duel, ready: [true, true], pending: [false, false] } };
  const arena = renderArena(duel), lobby = renderTournamentLobby({ ...view, phase: 'waiting', match: null });
  const spectator = renderTournamentSpectator(view);
  for (const image of images) for (const [label, output] of [['arena', arena], ['roster', lobby], ['spectator', spectator]]) assert.ok(output.includes(image.url), `${label} displays the prepared identity`);
  assert.match(spectator, /spectator-rows-v004\.png/);
  assert.match(spectator, /viewBox="0 0 920 580"/);
});

test('disposable spectator samples use current preset IDs, and unknown IDs cannot rewrite a legacy recipe', async () => {
  const sample = createSpectatorSample();
  assert.deepEqual(sample.fighters.map(fighter => fighter.character.appearance.facePreset), ['p01', 'p06']);
  const invalid = { sex: 'female', hairstyle: 'braided_ponytail', facePreset: 'p99' };
  const snapshot = structuredClone(invalid);
  const image = await prepareCleanAvatar(invalid, 'battle', gear);
  assert.equal(image.url, (await historical.prepareCleanAvatar(invalid, 'battle', gear)).url);
  assert.equal(image.styleVersion, 'arena-identity-v3');
  assert.deepEqual(invalid, snapshot);
});
