import { createDuel, resolveRound, WEAPONS, ARMORS } from './combat.js';
import { avatarChoices } from './avatar.js';
import { normalizePresetAppearance } from './face-presets.js';
import { preloadCleanArt, prepareCleanAvatar } from './current-avatar.js';
import { renderFirstPersonArena } from './first-person-arena.js';
import { buildAnimationSteps } from './battle-animation.js';
import { playFirstPersonBattleAnimation } from './first-person-animation.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cues = new Set(['strike', 'technique', 'guard', 'focus']);

/** Disposable art controls. They never read or create a service-owned fighter. */
export function createFirstPersonSample({ weapon = 'sword', armor = 'medium', skin = 'ivory' } = {}) {
  const character = (name, sex, facePreset) => ({ name,
    stats: { strength: 5, dexterity: 5, defense: 5, intelligence: 5 }, trait: 'balanced',
    appearance: normalizePresetAppearance({ sex, facePreset, skin, hairColor: 'chestnut' }),
  });
  const gear = { weapon: Object.hasOwn(WEAPONS, weapon) ? weapon : 'sword', armor: Object.hasOwn(ARMORS, armor) ? armor : 'medium', helmet: 'none' };
  return createDuel([
    { character: character('Cassian', 'male', 'p10'), ...gear },
    { character: character('Mira', 'female', 'p10'), ...gear },
  ]);
}

export function renderFirstPersonPreview(duel, { viewerIndex = 0, playing = false, message = 'Inspect the hands and weapon, then replay a short combat cue.' } = {}) {
  const local = duel.fighters[viewerIndex];
  const choices = (entries, selected) => entries.map(([id, label]) => `<option value="${escape(id)}"${id === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
  return `<main class="app-shell battle-shell fp-art-preview"><header class="masthead"><a class="brand" href="/">ARENA FIGHTERS</a><span class="badge">Local art preview</span></header><section class="fp-art-preview-heading"><span class="eyebrow">First-person combat</span><h1>Pixel combat art</h1></section><div class="fp-art-preview-options"><label for="fp-art-weapon">Weapon<select id="fp-art-weapon" data-fp-art="weapon"${playing ? ' disabled' : ''}>${choices(Object.entries(WEAPONS).map(([id, item]) => [id, item.name]), local.weapon)}</select></label><label for="fp-art-armor">Armor<select id="fp-art-armor" data-fp-art="armor"${playing ? ' disabled' : ''}>${choices(Object.entries(ARMORS).map(([id, item]) => [id, item.name]), local.armor)}</select></label><label for="fp-art-skin">Skin tone<select id="fp-art-skin" data-fp-art="skin"${playing ? ' disabled' : ''}>${choices(avatarChoices.skin.map(item => [item.id, item.label]), local.character.appearance.skin)}</select></label><label for="fp-art-viewer">View<select id="fp-art-viewer" data-fp-art="viewer"${playing ? ' disabled' : ''}>${choices([['0', 'Cassian'], ['1', 'Mira']], String(viewerIndex))}</select></label></div><div class="classic-battle"><section class="arena-panel"><div class="arena-stage first-person-stage">${renderFirstPersonArena(duel, { viewerIndex })}</div></section></div><div class="fp-art-preview-controls" aria-label="Combat art playback">${[...cues].map(cue => `<button class="button ${cue === 'strike' ? 'primary' : 'secondary'}" data-fp-art-cue="${cue}"${playing ? ' disabled' : ''}>${cue[0].toUpperCase() + cue.slice(1)}</button>`).join('')}<a class="button ghost" href="/">Back to game</a></div><p class="fp-art-preview-message" role="status">${escape(message)}</p><footer class="page-footer">ARENA FIGHTERS <span>Disposable art controls</span></footer></main>`;
}

/** The real renderer and animation consume only a disposable resolved round. */
export async function mountFirstPersonPreview(app) {
  await preloadCleanArt();
  let settings = { weapon: 'sword', armor: 'medium', skin: 'ivory' };
  let viewerIndex = 0;
  let before;
  let playback;
  let revision = 0;
  const draw = options => { app.innerHTML = renderFirstPersonPreview(before, { viewerIndex, ...options }); };
  const prepare = async () => {
    const current = ++revision;
    const sample = createFirstPersonSample(settings);
    await Promise.all(sample.fighters.map(fighter => prepareCleanAvatar(fighter.character.appearance, 'battle', {
      weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet,
    })));
    if (current !== revision) return;
    before = sample;
    draw();
  };
  await prepare();
  app.addEventListener('change', async event => {
    const control = event.target.closest('select[data-fp-art]');
    if (!control || playback) return;
    const key = control.dataset.fpArt;
    if (key === 'viewer') viewerIndex = control.value === '1' ? 1 : 0;
    else if (['weapon', 'armor', 'skin'].includes(key)) settings = { ...settings, [key]: control.value };
    else return;
    try { await prepare(); }
    catch (error) { draw({ message: `This art sample could not load: ${error.message}` }); }
  });
  app.addEventListener('click', async event => {
    const button = event.target.closest('button[data-fp-art-cue]');
    if (!button || button.disabled || playback || !cues.has(button.dataset.fpArtCue)) return;
    const cue = button.dataset.fpArtCue;
    const actions = ['guard', 'guard'];
    actions[viewerIndex] = cue;
    actions[1 - viewerIndex] = cue === 'guard' || cue === 'focus' ? 'strike' : 'guard';
    const after = resolveRound(before, actions, { choiceElapsedMs: [0, 0] });
    const steps = buildAnimationSteps(before, after);
    const controller = new AbortController();
    playback = controller;
    draw({ playing: true, message: 'Playing a resolved sample round.' });
    try {
      await playFirstPersonBattleAnimation(app.querySelector('.arena-stage'), steps, { signal: controller.signal });
      if (playback !== controller) return;
      playback = null;
      draw({ message: 'Sample cue complete. The disposable fighters have been reset.' });
      app.querySelector(`[data-fp-art-cue="${cue}"]`)?.focus({ preventScroll: true });
    } catch (error) {
      if (playback !== controller) return;
      playback = null;
      draw({ message: `The sample animation could not finish: ${error.message}` });
    }
  });
  globalThis.addEventListener?.('pagehide', () => { revision += 1; playback?.abort(); }, { once: true });
}
