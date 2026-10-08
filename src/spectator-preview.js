import { createDuel, resolveRound, WEAPONS, ARMORS } from './combat.js';
import { normalizeAppearance } from './avatar.js';
import { preloadCleanArt, prepareCleanAvatar } from './current-avatar.js';
import { renderArena } from './arena.js';
import { buildAnimationSteps, playBattleAnimation } from './battle-animation.js';
import { renderSpectatorFrame } from './spectator-frame.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/** Disposable local figures; neither character is registered with the duel service. */
export function createSpectatorSample() {
  const character = (name, appearance) => ({
    name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
    trait: 'balanced', appearance: normalizeAppearance(appearance),
  });
  return createDuel([
    { character: character('Cassian', { sex: 'male', facePreset: 'p01', hairstyle: 'shag', hairColor: 'chestnut', eyes: 'amber' }), weapon: 'sword', armor: 'medium', helmet: 'none' },
    { character: character('Mira', { sex: 'female', facePreset: 'p06', hairstyle: 'high_ponytail', hairColor: 'chestnut', eyes: 'jade' }), weapon: 'spear', armor: 'light', helmet: 'none' },
  ]);
}

function spectatorStatus(fighter, index) {
  return `<section class="spectator-status" aria-label="${escape(fighter.character.name)} status"><div class="spectator-status-heading"><h2>${escape(fighter.character.name)}</h2><span>${index === 0 ? 'West gate' : 'East gate'}</span></div><p>${escape(WEAPONS[fighter.weapon].name)} · ${escape(ARMORS[fighter.armor].name)}</p><div class="meter-label"><span>Health</span><strong>${fighter.hp} / ${fighter.maxHp}</strong></div><progress class="meter health" max="${fighter.maxHp}" value="${fighter.hp}" aria-label="${escape(fighter.character.name)} health"></progress><div class="meter-label"><span>Stamina</span><strong>${fighter.stamina} / ${fighter.maxStamina}</strong></div><progress class="meter stamina" max="${fighter.maxStamina}" value="${fighter.stamina}" aria-label="${escape(fighter.character.name)} stamina"></progress></section>`;
}

export function renderSpectatorPreview(duel, { playing = false, message = 'A seat in the stands. Replay the sample round to watch both fighters move.' } = {}) {
  const stage = `<div class="arena-stage">${renderArena({ ...duel, round: 1 }, { perspective: 'stands' })}</div>`;
  return `<main class="app-shell spectator-preview"><header class="masthead"><a class="brand" href="/" aria-label="Arena Fighters home"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13 27C2 23 3 9 11 4m8 23C30 23 29 9 21 4M12 27h8"/><path d="M7 9C1 7 1 14 6 15m0-2c-5 0-4 7 2 7m0-3c-4 2-2 7 4 7M25 9c6-2 6 5 1 6m0-2c5 0 4 7-2 7m0-3c4 2 2 7-4 7"/><path d="m16 9 3 6-3 6-3-6Z"/></svg></span> ARENA FIGHTERS</a><span class="badge">Local preview</span></header><section class="spectator-preview-heading"><span class="eyebrow">View from the stands</span><h1>Spectator seat preview</h1><p>The arena fills your view beyond three rows of spectators. This local sample uses the same framing as live tournament spectator seats.</p></section>${renderSpectatorFrame(stage, { hud: duel.fighters.map(spectatorStatus).join('') })}<div class="spectator-preview-controls" aria-label="Preview playback"><button class="button primary" data-preview-action="replay" ${playing ? 'disabled' : ''}>Replay round</button><button class="button secondary" data-preview-action="skip" ${playing ? '' : 'disabled'}>Skip animation</button><a class="button ghost" href="/">Back to game</a></div><p class="spectator-preview-message" role="status">${escape(message)}</p><footer class="page-footer">ARENA FIGHTERS <span>Static spectator frame · local preview</span></footer></main>`;
}

/** Mount a read-only art preview. Playback never starts a session or polls a room. */
export async function mountSpectatorPreview(app) {
  await preloadCleanArt();
  const before = createSpectatorSample();
  await Promise.all(before.fighters.map(fighter => prepareCleanAvatar(fighter.character.appearance, 'battle', { weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet })));
  const after = resolveRound(before, ['strike', 'technique']);
  const steps = buildAnimationSteps(before, after);
  let playback = null;

  const draw = (duel, options) => { app.innerHTML = renderSpectatorPreview(duel, options); };
  const finish = () => draw(after, { message: 'Sample round complete. Replay it to review the framing and weapon motion.' });
  draw(before);

  app.addEventListener('click', async event => {
    const button = event.target.closest('button[data-preview-action]');
    if (!button || button.disabled) return;
    if (button.dataset.previewAction === 'skip') {
      if (!playback) return;
      playback.abort();
      playback = null;
      finish();
      app.querySelector('[data-preview-action="replay"]')?.focus({ preventScroll: true });
      return;
    }
    if (button.dataset.previewAction !== 'replay' || playback) return;
    const controller = new AbortController();
    playback = controller;
    draw(before, { playing: true, message: 'Sample round 1: Mira uses Quick Thrust, then Cassian strikes.' });
    app.querySelector('[data-preview-action="skip"]')?.focus({ preventScroll: true });
    try {
      await playBattleAnimation(app.querySelector('.arena-stage'), steps, { signal: controller.signal });
      if (playback !== controller) return;
      playback = null;
      finish();
      app.querySelector('[data-preview-action="replay"]')?.focus({ preventScroll: true });
    } catch (error) {
      if (playback !== controller) return;
      playback = null;
      draw(after, { message: `The sample round resolved. Its animation could not finish: ${error.message}` });
    }
  });
  globalThis.addEventListener?.('pagehide', () => { playback?.abort(); }, { once: true });
}
