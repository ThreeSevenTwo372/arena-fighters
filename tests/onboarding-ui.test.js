import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { audioBindings } from './fixtures/audio-stub.js';
import * as combat from '../src/combat.js';
import * as presentation from '../src/battle-presentation.js';
import { avatarChoices, normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices, normalizePresetAppearance } from '../src/face-presets.js';
import { buildExecutionEvent } from '../src/execution-animation.js';
import { renderMercyPanel } from '../src/mercy-presentation.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const startup = appSource.indexOf('\napp.innerHTML = \'<main class="app-shell"><section class="panel loading-screen"');
assert.ok(startup > 0, 'The app startup boundary must be found.');
const definitions = appSource.slice(0, startup).replace(/^import .*;\r?\n/gm, '');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const character = (name, id) => ({
  ...(id ? { id } : {}), name,
  stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b45143', appearance: normalizeAppearance(),
});

// Use the actual screen builders and handlers. Only the DOM, network, and art
// renderer are replaced, so navigation tests exercise the real draft lifecycle.
function fixture(search = '') {
  const handlers = new Map();
  let result;
  const nameButton = { disabled: false, click: () => !nameButton.disabled && result.click('name-next') };
  const app = {
    addEventListener: (kind, handler) => handlers.set(kind, handler),
    querySelectorAll: () => [], querySelector: selector => selector === '[data-action="name-next"]' ? nameButton : null, setAttribute() {},
  };
  const context = vm.createContext({
    ...audioBindings,
    ...combat, ...presentation, avatarChoices, normalizeAppearance, facePresetChoices, normalizePresetAppearance,
    structuredClone, URLSearchParams, AbortController, setTimeout, clearTimeout, console,
    location: { search }, window: { scrollTo() {} }, navigator: {},
    document: { querySelector: () => app, addEventListener() {}, activeElement: null },
    OnlineClient: class {},
    prepareCleanAvatar: async () => {}, renderCleanAvatar: () => '<svg class="fixture-avatar"></svg>',
    renderArena: () => '', buildAnimationSteps: () => [], playBattleAnimation: async () => {},
    buildExecutionEvent, playExecutionAnimation: async () => {},
    renderMercyPanel, playLoserOutcome: async () => {},
  });
  vm.runInContext(definitions + `
    render = async () => {};
    globalThis.fixture = {
      state, client: onlineClient, useOnlineSession, applyOnlineView,
      get html() { return creator(); },
      get view() { return onlineView; }, set view(value) { onlineView = value; },
      get session() { return onlineSession; },
    };
  `, context, { filename: 'src/app.js' });
  result = context.fixture;
  result.click = (action, data = {}) => handlers.get('click')({
    target: { closest: () => ({ disabled: false, dataset: { action, ...(action === 'name-next' ? { index: String(result.state.nameIndex) } : {}), ...data } }) },
  });
  result.inputName = (index, value) => handlers.get('input')({
    target: { hasAttribute: () => false, dataset: { name: String(index) }, value },
  });
  result.change = (dataset, value) => handlers.get('change')({ target: { dataset, value } });
  result.submitName = () => handlers.get('submit')({ target: { matches: selector => selector === '.name-form' }, preventDefault() {} });
  return result;
}

test('a fresh fighter sees only naming first; Continue rejects empty or overlong names and trims a valid name', async () => {
  const ui = fixture();
  assert.equal(ui.state.drafts[0].name, '');
  assert.equal(ui.state.creatorStep, 'name');
  assert.match(ui.html, /NAME YOUR FIGHTER\./);
  assert.doesNotMatch(ui.html, /data-stat=|data-appearance=|data-trait=/);

  ui.inputName(0, '   ');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'name');
  ui.inputName(0, 'x'.repeat(25));
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'name');
  ui.inputName(0, '  Aster  ');
  await ui.click('name-next');
  assert.equal(ui.state.drafts[0].name, 'Aster');
  assert.equal(ui.state.creatorStep, 'customize');
});

test('the compact creator renders one fighter, four value pickers, and one trait picker without attribute presets or explanations', async () => {
  const ui = fixture();
  ui.inputName(0, 'Aster');
  await ui.click('name-next');
  const html = ui.html;
  assert.equal((html.match(/data-appearance="sex"/g) || []).length, 1);
  for (const attribute of Object.keys(combat.ATTRIBUTE_LABELS)) {
    assert.equal((html.match(new RegExp(`data-stat="${attribute}"`, 'g')) || []).length, 2);
    assert.ok(!html.includes(combat.ATTRIBUTE_HELP[attribute]));
  }
  assert.doesNotMatch(html, /data-action="preset"|quick-presets|Attributes and combat rules/);
  assert.equal((html.match(/data-trait=/g) || []).length, 1);
  for (const id of Object.keys(combat.TRAITS).filter(id => id !== 'fleetfoot')) assert.ok(html.includes(`value="${id}"`), `Trait ${id} must be selectable.`);
  assert.doesNotMatch(html, /data-stat="speed"|value="fleetfoot"/);
  assert.deepEqual(Object.keys(ui.state.drafts[0].stats), ['strength', 'dexterity', 'defense', 'intelligence']);
  assert.ok(html.includes(combat.TRAITS[ui.state.drafts[0].trait].description));
});

test('normal creation defaults both sexes to 05 and places two accessible preset arrows around one identity preview', async () => {
  const ui = fixture();
  assert.deepEqual(plain(ui.state.drafts.map(draft => draft.appearance.facePreset)), ['p05', 'p05']);
  ui.inputName(0, 'Aster');
  await ui.click('name-next');
  assert.equal((ui.html.match(/data-action="face-cycle"/g) || []).length, 2);
  assert.match(ui.html, /aria-label="Previous preset for Aster"/);
  assert.match(ui.html, /aria-label="Next preset for Aster"/);
  assert.match(ui.html, /data-delta="-1"/);
  assert.match(ui.html, /data-delta="1"/);
  assert.match(ui.html, /role="status"[^>]*>05<|aria-label="[^"]*05[^"]*"/);
  assert.equal((ui.html.match(/class="fixture-avatar"/g) || []).length, 1);
  assert.doesNotMatch(ui.html, /data-action="face-preset"|face-preset-grid|<legend>Face<|data-appearance="(?:hairstyle|eyeStyle|beard|eyes)"|Eye color|preset-selection|appearance-note|Appearance preset review/);
  for (const preset of facePresetChoices()) assert.ok(!ui.html.includes(preset.description));
});

test('preset arrows cycle through all ten identities in both directions while retaining the rest of the fighter', async () => {
  const ui = fixture();
  ui.inputName(0, 'Aster');
  await ui.click('name-next');
  await ui.click('stat', { index: '0', stat: 'strength', delta: '-1' });
  await ui.click('stat', { index: '0', stat: 'intelligence', delta: '1' });
  await ui.click('color', { index: '0', value: '#7b8b57' });
  ui.change({ trait: '0' }, Object.keys(combat.TRAITS).find(id => id !== 'balanced'));
  ui.change({ appearance: 'skin', index: '0' }, 'bronze');
  ui.change({ appearance: 'hairColor', index: '0' }, 'raven');
  ui.state.drafts[0].appearance.eyes = 'jade';
  ui.change({ appearance: 'eyes', index: '0' }, 'ruby');
  assert.equal(ui.state.drafts[0].appearance.eyes, 'jade', 'A hidden preset eye field must not change an existing saved palette value.');
  ui.change({ appearance: 'sex', index: '0' }, 'female');
  assert.equal(ui.state.drafts[0].appearance.facePreset, 'p05');
  assert.equal(ui.state.drafts[0].appearance.sex, 'female');
  const original = plain(ui.state.drafts[0]);
  const forward = [];
  for (let step = 0; step < 10; step += 1) {
    await ui.click('face-cycle', { index: '0', delta: '1' });
    forward.push(ui.state.drafts[0].appearance.facePreset);
    assert.deepEqual(plain(ui.state.drafts[0]), { ...original, appearance: { ...original.appearance, facePreset: forward.at(-1) } });
  }
  assert.deepEqual(forward, ['p06', 'p07', 'p08', 'p09', 'p10', 'p01', 'p02', 'p03', 'p04', 'p05']);
  const backward = [];
  for (let step = 0; step < 10; step += 1) {
    await ui.click('face-cycle', { index: '0', delta: '-1' });
    backward.push(ui.state.drafts[0].appearance.facePreset);
  }
  assert.deepEqual(backward, ['p04', 'p03', 'p02', 'p01', 'p10', 'p09', 'p08', 'p07', 'p06', 'p05']);
  assert.deepEqual(plain(ui.state.drafts[0]), original);
  for (const delta of ['0', '2', '-2', '0.5', 'bad', '']) {
    await ui.click('face-cycle', { index: '0', delta });
    assert.deepEqual(plain(ui.state.drafts[0]), original, `Invalid delta ${JSON.stringify(delta)} must not change the fighter.`);
  }
  for (const index of ['-1', '2', 'bad']) {
    await ui.click('face-cycle', { index, delta: '1' });
    assert.deepEqual(plain(ui.state.drafts[0]), original);
  }
});

test('a saved preset survivor retains its exact face and palettes and cannot select a different identity', async () => {
  const ui = fixture();
  const survivor = { ...character('Veteran', 'saved-v013'), appearance: normalizePresetAppearance({ sex: 'female', facePreset: 'p10', skin: 'bronze', eyes: 'jade' }) };
  const original = plain(survivor);
  ui.useOnlineSession({ character: survivor, alive: true, duelWins: 3, activeRoom: null });
  assert.equal(ui.state.locked[0], true);
  await ui.click('face-cycle', { index: '0', delta: '1' });
  await ui.click('face-cycle', { index: '0', delta: '-1' });
  ui.change({ appearance: 'sex', index: '0' }, 'male');
  assert.deepEqual(plain(ui.state.drafts[0]), original);
  const arrows = ui.html.match(/<button\b[^>]*data-action="face-cycle"[^>]*>/g) || [];
  for (const arrow of arrows) assert.match(arrow, /\bdisabled\b/);
  assert.doesNotMatch(ui.html, /data-action="face-preset"|face-preset-grid/);
});

test('an unlocked legacy recipe has no preset arrows and arrow actions retain its saved appearance', async () => {
  const ui = fixture();
  ui.inputName(0, 'Legacy');
  await ui.click('name-next');
  ui.state.drafts[0].appearance = normalizeAppearance({ sex: 'male', hairstyle: 'shag', hairColor: 'raven', eyes: 'jade' });
  const original = plain(ui.state.drafts[0]);
  assert.doesNotMatch(ui.html, /data-action="face-cycle"|data-action="face-preset"|face-preset-grid/);
  assert.match(ui.html, /data-appearance="eyes"/);
  await ui.click('face-cycle', { index: '0', delta: '1' });
  await ui.click('face-cycle', { index: '0', delta: '-1' });
  assert.deepEqual(plain(ui.state.drafts[0]), original);
});

test('submitting the name form follows the same validation and progression as Continue', async () => {
  const ui = fixture();
  ui.inputName(0, '   ');
  await ui.submitName();
  assert.equal(ui.state.creatorStep, 'name');
  ui.inputName(0, '  Enter name  ');
  await ui.submitName();
  assert.equal(ui.state.drafts[0].name, 'Enter name');
  assert.equal(ui.state.creatorStep, 'customize');
});

test('renaming a fighter keeps their chosen appearance, attributes, banner, and trait', async () => {
  const ui = fixture();
  ui.inputName(0, 'Aster');
  await ui.click('name-next');
  await ui.click('stat', { index: '0', stat: 'strength', delta: '-1' });
  await ui.click('stat', { index: '0', stat: 'intelligence', delta: '1' });
  await ui.click('color', { index: '0', value: '#7b8b57' });
  ui.change({ appearance: 'eyes', index: '0' }, 'jade');
  const trait = Object.keys(combat.TRAITS).find(id => id !== 'balanced');
  ui.change({ trait: '0' }, trait);
  const draft = plain(ui.state.drafts[0]);
  assert.equal(draft.trait, trait);

  await ui.click('rename', { index: '0' });
  assert.equal(ui.state.creatorStep, 'name');
  ui.inputName(0, 'Aster the Second');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.deepEqual(plain(ui.state.drafts[0]), { ...draft, name: 'Aster the Second' });
});

test('Pass & play names both fighters in sequence and switches the compact editor without losing either draft', async () => {
  const ui = fixture();
  await ui.click('mode', { value: 'hotseat' });
  ui.inputName(0, 'West');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.state.nameIndex, 1);
  assert.equal(ui.state.drafts[0].name, 'West');
  ui.inputName(1, 'East');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal((ui.html.match(/data-appearance="sex"/g) || []).length, 1);
  await ui.click('creator-player', { index: '0' });
  await ui.click('stat', { index: '0', stat: 'strength', delta: '-1' });
  await ui.click('stat', { index: '0', stat: 'intelligence', delta: '1' });
  const firstDraft = plain(ui.state.drafts[0]);

  await ui.click('creator-player', { index: '1' });
  assert.equal(ui.state.creatorIndex, 1);
  ui.change({ appearance: 'hairColor', index: '1' }, 'raven');
  const secondDraft = plain(ui.state.drafts[1]);
  await ui.click('creator-player', { index: '0' });
  assert.equal(ui.state.creatorIndex, 0);
  assert.deepEqual(plain(ui.state.drafts[0]), firstDraft);
  assert.deepEqual(plain(ui.state.drafts[1]), secondDraft);
});

test('Practice requires only the player name and keeps a valid default rival', async () => {
  const ui = fixture();
  await ui.click('mode', { value: 'cpu' });
  ui.inputName(0, 'Aster');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal(ui.state.drafts[1].name, 'Mira');
  assert.equal(combat.validateCharacter(ui.state.drafts[1]).valid, true);
  await ui.click('create');
  assert.equal(ui.state.screen, 'loadout');
  assert.deepEqual(plain(ui.state.profiles.map(profile => profile.character.name)), ['Aster', 'Mira']);
});

test('Back from the second Pass & play name preserves the first name and still requires the second', async () => {
  const ui = fixture();
  await ui.click('mode', { value: 'hotseat' });
  ui.inputName(0, 'West');
  await ui.click('name-next');
  assert.equal(ui.state.nameIndex, 1);
  await ui.click('name-back');
  assert.equal(ui.state.nameIndex, 0);
  assert.equal(ui.state.drafts[0].name, 'West');
  assert.equal(ui.state.drafts[1].name, '');
  await ui.click('name-next');
  assert.equal(ui.state.nameIndex, 1);
  assert.equal(ui.state.creatorStep, 'name');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'name');
});

test('an online survivor bypasses naming and cannot change their saved identity or trait', async () => {
  const ui = fixture();
  const survivor = character('Laurel', 'saved-survivor');
  const original = plain(survivor);
  ui.useOnlineSession({ character: survivor, alive: true, duelWins: 7, activeRoom: null });
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal(ui.state.locked[0], true);
  assert.doesNotMatch(ui.html, /NAME YOUR FIGHTER\.|data-action="rename"/);
  ui.inputName(0, 'Changed');
  await ui.click('stat', { index: '0', stat: 'strength', delta: '-1' });
  await ui.click('rename', { index: '0' });
  ui.change({ appearance: 'eyes', index: '0' }, 'ruby');
  ui.change({ trait: '0' }, Object.keys(combat.TRAITS).find(id => id !== survivor.trait));
  await ui.click('face-cycle', { index: '0', delta: '1' });
  assert.deepEqual(plain(ui.state.drafts[0]), original);
  assert.doesNotMatch(ui.html, /data-action="face-cycle"|data-action="face-preset"|face-preset-grid/);
  assert.equal(ui.state.creatorStep, 'customize');
  assert.deepEqual(plain(ui.session.character), original);
});

test('retiring a saved fighter sends their replacement through naming and keeps the final record intact', async () => {
  const ui = fixture();
  const retired = character('Laurel', 'retired-identity');
  ui.useOnlineSession({ character: retired, alive: true, duelWins: 7, activeRoom: null });
  ui.useOnlineSession({ character: retired, alive: false, duelWins: 7, activeRoom: null });
  assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.state.locked[0], false);
  assert.equal(Object.hasOwn(ui.state.drafts[0], 'id'), false);
  assert.match(ui.html, /NAME YOUR FIGHTER\./);
  ui.inputName(0, 'Successor');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal(ui.state.drafts[0].name, 'Successor');
  assert.equal(ui.session.character.id, 'retired-identity');
  assert.equal(ui.session.character.name, 'Laurel');
  assert.equal(ui.session.duelWins, 7);
  await ui.click('stat', { index: '0', stat: 'strength', delta: '-1' });
  await ui.click('stat', { index: '0', stat: 'intelligence', delta: '1' });
  const replacement = plain(ui.state.drafts[0]);
  ui.useOnlineSession({ character: retired, alive: false, duelWins: 7, activeRoom: null });
  assert.equal(ui.state.creatorStep, 'customize', 'Polling the final record must not interrupt replacement editing.');
  assert.deepEqual(plain(ui.state.drafts[0]), replacement);
});

test('surviving local fighters rematch directly to equipment with their existing identities and records', async () => {
  const ui = fixture();
  ui.state.mode = 'hotseat';
  ui.state.screen = 'battle';
  ui.state.profiles = [
    { character: character('West', 'west-id'), alive: true, duelWins: 4 },
    { character: character('East', 'east-id'), alive: true, duelWins: 2 },
  ];
  ui.state.duel = combat.createDuel(ui.state.profiles.map(profile => ({ character: profile.character, weapon: 'sword', armor: 'medium' })));
  const profiles = plain(ui.state.profiles);
  await ui.click('rematch');
  assert.equal(ui.state.screen, 'loadout');
  assert.deepEqual(plain(ui.state.profiles), profiles);
});

test('a retired Pass & play rival enters replacement naming while the survivor stays locked', async () => {
  const ui = fixture();
  ui.state.mode = 'hotseat';
  ui.state.screen = 'battle';
  ui.state.profiles = [
    { character: character('West', 'west-id'), alive: true, duelWins: 4 },
    { character: character('East', 'east-id'), alive: false, duelWins: 2 },
  ];
  ui.state.duel = combat.createDuel(ui.state.profiles.map(profile => ({ character: profile.character, weapon: 'sword', armor: 'medium' })));
  await ui.click('rematch');
  assert.equal(ui.state.screen, 'creator');
  assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.state.nameIndex, 1);
  assert.deepEqual(plain(ui.state.locked), [true, false]);
  assert.equal(ui.state.drafts[0].id, 'west-id');
  assert.equal(Object.hasOwn(ui.state.drafts[1], 'id'), false);
  ui.inputName(1, 'East reborn');
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.equal(ui.state.creatorIndex, 1);
  await ui.click('create');
  assert.equal(ui.state.screen, 'loadout');
  assert.equal(ui.state.profiles[0].character.id, 'west-id');
  assert.equal(ui.state.profiles[0].duelWins, 4);
  assert.equal(ui.state.profiles[1].character.name, 'East reborn');
  assert.equal(ui.state.profiles[1].duelWins, 0);
});

test('the face preset review keeps two complete figures with four arrows and skips normal naming', () => {
  const ui = fixture('?face-presets-review=1');
  assert.equal(ui.state.mode, 'cpu');
  assert.equal(ui.state.creatorStep, 'customize');
  assert.doesNotMatch(ui.html, /NAME YOUR FIGHTER\./);
  assert.equal((ui.html.match(/data-appearance="sex"/g) || []).length, 2);
  assert.equal((ui.html.match(/class="fixture-avatar"/g) || []).length, 2);
  assert.equal((ui.html.match(/data-action="face-cycle"/g) || []).length, 4);
  const arrows = ui.html.match(/<button\b[^>]*data-action="face-cycle"[^>]*>/g) || [];
  assert.equal(arrows.filter(arrow => /data-delta="-1"/.test(arrow)).length, 2);
  assert.equal(arrows.filter(arrow => /data-delta="1"/.test(arrow)).length, 2);
  assert.doesNotMatch(ui.html, /data-action="face-preset"|face-preset-grid|<legend>Face</);
});

test('a delayed Online session cannot bypass naming or lock the draft after switching back to Practice', async () => {
  const ui = fixture();
  const response = deferred();
  let roomRequests = 0;
  ui.client.session = () => response.promise;
  ui.client.room = async () => { roomRequests += 1; throw new Error('Late room lookup'); };
  const switching = ui.click('mode', { value: 'online' });
  await ui.click('mode', { value: 'cpu' });
  ui.inputName(0, 'Practice name');
  response.resolve({ character: character('Old identity', 'saved-1'), alive: true, activeRoom: 'ABC234' });
  await switching;
  assert.equal(ui.state.mode, 'cpu');
  assert.equal(ui.state.creatorStep, 'name');
  assert.equal(ui.state.drafts[0].name, 'Practice name');
  assert.equal(ui.state.locked[0], false);
  assert.equal(roomRequests, 0);
  await ui.click('name-next');
  assert.equal(ui.state.creatorStep, 'customize');
});
