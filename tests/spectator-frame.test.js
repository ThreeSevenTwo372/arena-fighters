import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { audioBindings } from './fixtures/audio-stub.js';
import * as combat from '../src/combat.js';
import { normalizeAppearance } from '../src/avatar.js';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { renderArena } from '../src/arena.js';
import { buildAnimationSteps } from '../src/battle-animation.js';
import { renderSpectatorFrame } from '../src/spectator-frame.js';
import { createSpectatorSample, renderSpectatorPreview } from '../src/spectator-preview.js';

test('the decorative frame preserves the supplied battlefield and separates its status displays', () => {
  const duel = createSpectatorSample();
  const battlefield = renderArena(duel);
  const stage = `<div class="arena-stage">${battlefield}</div>`;
  const hud = '<section>Public fighter status</section>';
  const output = renderSpectatorFrame(stage, { hud });
  assert.equal(output.split(stage).length, 2, 'The same stage occurs exactly once.');
  assert.ok(output.indexOf(hud) < output.indexOf('<div class="spectator-frame">'));
  assert.match(battlefield, /viewBox="0 0 920 440"/);
  assert.match(battlefield, /data-fighter-index="0"[^>]*transform="translate\(320 378\)"/);
  assert.match(battlefield, /data-fighter-index="1"[^>]*transform="translate\(600 378\) scale\(-1 1\)"/);
  assert.ok(output.indexOf('<img class="spectator-frame-art"') > output.indexOf(stage) + stage.length);
  assert.match(output, /alt="" aria-hidden="true" draggable="false"/);
  assert.doesNotMatch(renderSpectatorFrame(stage), /spectator-battle-hud/);
});

test('sample playback uses an ordinary immutable duel and exposes only preview controls', () => {
  const before = createSpectatorSample();
  const snapshot = structuredClone(before);
  const after = combat.resolveRound(before, ['strike', 'technique']);
  const steps = buildAnimationSteps(before, after);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(before.fighters.map(fighter => fighter.character.name), ['Cassian', 'Mira']);
  assert.deepEqual(steps.filter(step => step.type === 'attack').map(step => step.actor), [1, 0]);
  const preview = renderSpectatorPreview(before);
  assert.match(preview, /Local preview/);
  assert.match(preview, /same framing as live tournament spectator seats/);
  assert.match(preview, /data-preview-action="replay"/);
  assert.match(preview, /data-preview-action="skip" disabled/);
  assert.doesNotMatch(preview, /data-action=|commit-status|Your move|Execute|Ready for another duel/);
});

test('the stands camera preserves complete fighter assemblies and leaves the ordinary camera intact', () => {
  const duel = createSpectatorSample();
  const ordinary = renderArena(duel);
  const stands = renderArena(duel, { perspective: 'stands' });
  assert.match(ordinary, /viewBox="0 0 920 440"/);
  assert.match(ordinary, /arena-fighter" data-fighter-index="0"[^>]*transform="translate\(320 378\)"/);
  assert.match(ordinary, /arena-fighter" data-fighter-index="1"[^>]*transform="translate\(600 378\) scale\(-1 1\)"/);
  assert.match(stands, /viewBox="0 0 920 580"/);
  assert.match(stands, /dark-arena-v001\.png" width="920" height="580"/);
  assert.match(stands, /arena-fighter" data-fighter-index="0"[^>]*transform="translate\(340 365\) scale\(\.5\)"/);
  assert.match(stands, /arena-fighter" data-fighter-index="1"[^>]*transform="translate\(580 365\) scale\(-\.5 \.5\)"/);
  // Only the outer camera transforms may differ: head, clothing and equipment stay registered together.
  const fighterAssemblies = svg => [...svg.matchAll(/<g\b[^>]*\bclass="[^"]*\barena-fighter\b[^"]*"[^>]*>/g)].map(opening => {
    const groups = /<\/?g\b[^>]*>/g;
    groups.lastIndex = opening.index;
    let depth = 0;
    let tag;
    while ((tag = groups.exec(svg))) {
      if (tag[0].startsWith('</g')) depth -= 1;
      else if (!tag[0].endsWith('/>')) depth += 1;
      if (depth === 0) return svg.slice(opening.index, groups.lastIndex).replace(/\btransform="[^"]*"/, 'transform="CAMERA"');
    }
    assert.fail('The complete fighter group must have a closing tag.');
  });
  assert.equal(fighterAssemblies(stands).length, 2);
  assert.deepEqual(fighterAssemblies(stands), fighterAssemblies(ordinary));
  assert.match(renderSpectatorPreview(duel), /viewBox="0 0 920 580"/);
});

function playbackFixture() {
  const handlers = new Map();
  const calls = [];
  let stage;
  const app = {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; stage = {}; },
    addEventListener(kind, handler) { handlers.set(kind, handler); },
    querySelector(selector) { return selector === '.arena-stage' ? stage : { focus() {} }; },
  };
  const context = vm.createContext({
    ...combat, normalizeAppearance, renderArena, buildAnimationSteps, renderSpectatorFrame,
    AbortController, preloadCleanArt: async () => {}, prepareCleanAvatar: async () => {},
    playBattleAnimation: (container, steps, { signal }) => new Promise(resolve => calls.push({ container, steps, signal, resolve })),
  });
  const source = readFileSync(new URL('../src/spectator-preview.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source + '\nglobalThis.mount = mountSpectatorPreview;', context);
  return {
    app, calls, mount: () => context.mount(app),
    click: action => handlers.get('click')({ target: { closest: () => ({ disabled: false, dataset: { previewAction: action } }) } }),
  };
}

test('Skip shows the resolved result and a stale playback cannot overwrite a subsequent replay', async () => {
  const fixture = playbackFixture();
  await fixture.mount();
  const firstReplay = fixture.click('replay');
  assert.equal(fixture.calls.length, 1);
  assert.match(fixture.app.innerHTML, /data-preview-action="replay" disabled/);
  await fixture.click('skip');
  assert.equal(fixture.calls[0].signal.aborted, true);
  assert.match(fixture.app.innerHTML, /Sample round complete/);
  const expected = combat.resolveRound(createSpectatorSample(), ['strike', 'technique']);
  for (const fighter of expected.fighters) {
    assert.ok(fixture.app.innerHTML.includes(`${fighter.hp} / ${fighter.maxHp}`));
    assert.ok(fixture.app.innerHTML.includes(`${fighter.stamina} / ${fighter.maxStamina}`));
  }
  const secondReplay = fixture.click('replay');
  assert.equal(fixture.calls.length, 2);
  fixture.calls[0].resolve(false);
  await firstReplay;
  assert.match(fixture.app.innerHTML, /data-preview-action="replay" disabled/);
  fixture.calls[1].resolve(true);
  await secondReplay;
  assert.match(fixture.app.innerHTML, /Sample round complete/);
});

test('the preview startup does not construct a guest client, recover a room, or start polling', async () => {
  const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace("await import('./spectator-preview.js')", '({ mountSpectatorPreview: mountPreviewFixture })');
  let mounted = 0;
  let polls = 0;
  const app = { addEventListener() {}, innerHTML: '' };
  const context = vm.createContext({
    ...audioBindings,
    ...combat, normalizeAppearance, normalizePresetAppearance, URLSearchParams,
    document: { querySelector: () => app, addEventListener() {} }, location: { search: '?spectator-frame-review=1' },
    OnlineClient: class { constructor() { throw new Error('The preview accessed guest state.'); } },
    mountPreviewFixture: async received => { assert.equal(received, app); mounted += 1; },
    setInterval() { polls += 1; },
  });
  await vm.runInContext(`(async () => { ${source}\n })()`, context);
  assert.equal(mounted, 1);
  assert.equal(polls, 0);
});
