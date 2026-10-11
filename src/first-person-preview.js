import { createDuel, resolveRound, WEAPONS, ARMORS } from './combat.js';
import { avatarChoices } from './avatar.js';
import { normalizePresetAppearance } from './face-presets.js';
import { preloadCleanArt, prepareCleanAvatar } from './current-avatar.js';
import { renderFirstPersonArena } from './first-person-arena.js';
import { buildAnimationSteps, presentAttackBlood } from './battle-animation.js';
import { buildExecutionEvent } from './execution-animation.js';
import { playFirstPersonBattleAnimation, playFirstPersonExecutionAnimation, mountFirstPersonExecutionBlood } from './first-person-animation.js';
import { preparedFirstPersonFrameClip, preloadFirstPersonFrames, applyFirstPersonFrame } from './first-person-frames.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cues = new Set(['strike', 'technique', 'guard', 'focus', 'execution']);

/** A Kill cue in this disposable scene never visits the service or a fighter save. */
export function createFirstPersonExecutionSample(duel) {
  if (!Array.isArray(duel?.fighters) || duel.fighters.length !== 2) return null;
  const completed = structuredClone(duel);
  completed.status = 'complete';
  completed.result = { winner: 0, reason: 'knockout' };
  completed.fighters[1].hp = 0;
  return buildExecutionEvent(completed, { decision: 'execute', winner: 0, loser: 1 });
}

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

export function renderFirstPersonPreview(duel, { viewerIndex = 0, artVersion = 'v008', playing = false, inspect = false, frame = 43, message = 'Inspect the hands and weapon, then replay a short combat cue.' } = {}) {
  const local = duel.fighters[viewerIndex];
  const choices = (entries, selected) => entries.map(([id, label]) => `<option value="${escape(id)}"${id === selected ? ' selected' : ''}>${escape(label)}</option>`).join('');
  return `<main class="app-shell battle-shell fp-art-preview"><header class="masthead"><a class="brand" href="/">ARENA FIGHTERS</a><span class="badge">Local art preview</span></header><section class="fp-art-preview-heading"><span class="eyebrow">First-person combat</span><h1>Pixel combat art</h1></section><div class="fp-art-preview-options"><label for="fp-art-weapon">Weapon<select id="fp-art-weapon" data-fp-art="weapon"${playing ? ' disabled' : ''}>${choices(Object.entries(WEAPONS).map(([id, item]) => [id, item.name]), local.weapon)}</select></label><label for="fp-art-armor">Armor<select id="fp-art-armor" data-fp-art="armor"${playing ? ' disabled' : ''}>${choices(Object.entries(ARMORS).map(([id, item]) => [id, item.name]), local.armor)}</select></label><label for="fp-art-skin">Skin tone<select id="fp-art-skin" data-fp-art="skin"${playing ? ' disabled' : ''}>${choices(avatarChoices.skin.map(item => [item.id, item.label]), local.character.appearance.skin)}</select></label><label for="fp-art-viewer">View<select id="fp-art-viewer" data-fp-art="viewer"${playing ? ' disabled' : ''}>${choices([['0', 'Cassian'], ['1', 'Mira']], String(viewerIndex))}</select></label></div><div class="classic-battle"><section class="arena-panel"><div class="arena-stage first-person-stage">${renderFirstPersonArena(duel, { viewerIndex, artVersion })}</div></section></div><div class="fp-art-preview-controls" aria-label="Combat art playback">${[...cues].map(cue => `<button class="button ${cue === 'strike' ? 'primary' : 'secondary'}" data-fp-art-cue="${cue}"${playing ? ' disabled' : ''}>${cue[0].toUpperCase() + cue.slice(1)}</button>`).join('')}<a class="button ghost" href="/">Back to game</a></div><div class="fp-art-motion-controls"><label><input id="fp-art-inspect" type="checkbox"${inspect ? ' checked' : ''}${playing ? ' disabled' : ''}> Inspect attack frames</label><label for="fp-art-frame">Swing frame <output id="fp-art-frame-value">${frame}%</output></label><input id="fp-art-frame" type="range" min="0" max="100" step="1" value="${frame}"${!inspect || playing ? ' disabled' : ''} aria-label="Swing frame"></div><p class="fp-art-preview-message" role="status">${escape(message)}</p><footer class="page-footer">ARENA FIGHTERS <span>Disposable art controls</span></footer></main>`;
}

/** The real renderer and animation consume only a disposable resolved round. */
export async function mountFirstPersonPreview(app) {
  await preloadCleanArt();
  const requestedVersion = new URLSearchParams(globalThis.location?.search ?? '').get('first-person-art-version');
  const artVersion = ['v005', 'v006', 'v007', 'v008'].includes(requestedVersion) ? requestedVersion : 'v008';
  let settings = { weapon: 'sword', armor: 'medium', skin: 'ivory', artVersion };
  let viewerIndex = 0;
  let inspect = false, frame = 43, inspectedCue = 'strike';
  let before;
  let playback;
  let revision = 0;
  const inspectScene = () => {
    const stage = app.querySelector('.arena-stage');
    const local = stage.querySelector('.fp-viewmodel');
    stage.querySelectorAll('.pixel-blood-combat, .pixel-blood-effect').forEach(node => node.remove());
    if (inspectedCue === 'execution') {
      stage.classList.add('fp-execution-playback', 'fp-execution-inspection');
      stage.dataset.fpExecutionPhase = 'impact';
      stage.dataset.fpExecutionView = viewerIndex === 0 ? 'victor' : 'defeated';
      stage.style.setProperty('--blood-inspect-delay', `${-frame * 7.6}ms`);
      stage.style.setProperty('--fp-inspect-delay', `${-frame * 9}ms`);
      mountFirstPersonExecutionBlood(stage, 1);
      return;
    }
    stage.classList.add('battle-playback', 'fp-motion-inspection');
    const elapsed = frame * 6.65;
    stage.style.setProperty('--fp-inspect-delay', `${-elapsed}ms`);
    stage.style.setProperty('--blood-inspect-delay', `${-Math.max(0, elapsed - 285)}ms`);
    const actions = ['guard', 'guard'];
    actions[viewerIndex] = inspectedCue;
    const resolved = resolveRound(before, actions, { choiceElapsedMs: [0, 0] });
    const attack = buildAnimationSteps(before, resolved).find(step => step.actor === viewerIndex && step.type === 'attack');
    if (attack) {
      local.dataset.animation = 'attack';
      local.dataset.combatAction = attack.action;
      applyFirstPersonFrame(local, preparedFirstPersonFrameClip(settings), elapsed, attack.action);
      if (elapsed >= 285) presentAttackBlood(stage,
        stage.querySelector(`.arena-fighter[data-fighter-index="${attack.target}"]`), attack);
    }
  };
  const draw = options => {
    app.innerHTML = renderFirstPersonPreview(before, { viewerIndex, artVersion, inspect, frame, ...options });
    if (inspect) inspectScene();
  };
  const prepare = async () => {
    const current = ++revision;
    const sample = createFirstPersonSample(settings);
    await Promise.all(sample.fighters.map(fighter => prepareCleanAvatar(fighter.character.appearance, 'battle', {
      weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet,
    })));
    await preloadFirstPersonFrames(settings);
    if (current !== revision) return;
    before = sample;
    draw();
  };
  await prepare();
  app.addEventListener('change', async event => {
    if (event.target.id === 'fp-art-inspect' && !playback) {
      inspect = event.target.checked;
      draw({ message: inspect ? 'Choose Strike, Technique or Execution, then inspect the effect with the frame control.' : 'Inspect the hands and weapon, then replay a short combat cue.' });
      return;
    }
    const control = event.target.closest('select[data-fp-art]');
    if (!control || playback) return;
    const key = control.dataset.fpArt;
    if (key === 'viewer') viewerIndex = control.value === '1' ? 1 : 0;
    else if (['weapon', 'armor', 'skin'].includes(key)) settings = { ...settings, [key]: control.value };
    else return;
    try { await prepare(); }
    catch (error) { draw({ message: `This art sample could not load: ${error.message}` }); }
  });
  app.addEventListener('input', event => {
    if (event.target.id !== 'fp-art-frame' || !inspect || playback) return;
    frame = Math.max(0, Math.min(100, Number(event.target.value) || 0));
    inspectScene();
    app.querySelector('#fp-art-frame-value').textContent = `${frame}%`;
  });
  app.addEventListener('click', async event => {
    const button = event.target.closest('button[data-fp-art-cue]');
    if (!button || button.disabled || playback || !cues.has(button.dataset.fpArtCue)) return;
    const cue = button.dataset.fpArtCue;
    if (inspect && (cue === 'strike' || cue === 'technique' || cue === 'execution')) {
      inspectedCue = cue;
      draw({ message: cue === 'execution' ? 'Paused execution impact. Cassian is the victor; switch View to inspect Mira’s perspective.' : 'Paused attack sample. Drag the frame control to inspect the complete arms and blood at contact.' });
      return;
    }
    if (inspect) { inspect = false; }
    const actions = ['guard', 'guard'];
    actions[viewerIndex] = cue;
    actions[1 - viewerIndex] = cue === 'guard' || cue === 'focus' ? 'strike' : 'guard';
    const steps = cue === 'execution' ? [] : buildAnimationSteps(before,
      resolveRound(before, actions, { choiceElapsedMs: [0, 0] }));
    const controller = new AbortController();
    playback = controller;
    draw({ playing: true, message: 'Playing a resolved sample round.' });
    try {
      if (cue === 'execution') await playFirstPersonExecutionAnimation(app.querySelector('.arena-stage'),
        createFirstPersonExecutionSample(before), { signal: controller.signal });
      else await playFirstPersonBattleAnimation(app.querySelector('.arena-stage'), steps, { signal: controller.signal });
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

