import { playBattleAnimation } from './battle-animation.js';
import { preparedFirstPersonFrameClip, applyFirstPersonFrame } from './first-person-frames.js';
import { createPixelBloodEffect } from './pixel-blood.js';

/** First-person playback consumes the same resolved public steps as the stands view. */
const INDICES = new Set([0, 1]);
const WEAPONS = new Set(['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident']);

function saveAttributes(node, names) {
  const saved = names.map(name => [name, node.hasAttribute(name), node.getAttribute(name)]);
  return () => {
    for (const [name, present, value] of saved) {
      if (present) node.setAttribute(name, value);
      else node.removeAttribute(name);
    }
  };
}

function firstPersonRig(container) {
  if (!container?.isConnected) return null;
  const local = container.querySelector('.fp-viewmodel');
  const opponent = container.querySelector('.fp-opponent');
  const localIndex = Number(local?.dataset.fighterIndex);
  const opponentIndex = Number(opponent?.dataset.fighterIndex);
  if (!local || !opponent || !INDICES.has(localIndex) || opponentIndex !== 1 - localIndex) return null;
  return { local, opponent, localIndex };
}

/** Reuse authoritative event order, captions, contact frames, sound and abort handling. */
export async function playFirstPersonBattleAnimation(container, steps, options = {}) {
  const rig = firstPersonRig(container);
  if (!rig || options.signal?.aborted || !Array.isArray(steps)) return false;
  const names = ['data-animation', 'data-combat-action', 'data-guarding', 'data-riposting', 'data-defeated', 'data-weapon', 'data-frame-pose'];
  const restore = [rig.local, rig.opponent].map(node => saveAttributes(node, names));
  const image = rig.local.querySelector('.fp-authored-frame');
  if (image) restore.push(saveAttributes(image, ['href']));
  const clip = image && preparedFirstPersonFrameClip({ weapon: rig.local.dataset.weapon, armor: rig.local.dataset.armor,
    skin: rig.local.dataset.skin, artVersion: rig.local.dataset.frameVersion });
  const onAttackFrame = frame => {
    if (frame.step.actor === rig.localIndex && clip && !options.signal?.aborted) {
      if (frame.elapsedMs === 665) {
        rig.local.removeAttribute('data-frame-pose');
        image.removeAttribute('href');
      } else applyFirstPersonFrame(rig.local, clip, frame.elapsedMs, frame.step.action);
    }
    return options.onAttackFrame?.(frame);
  };
  try {
    return await playBattleAnimation(container, steps, { ...options, ...(clip ? { onAttackFrame } : {}) });
  } finally {
    // Existing identity/equipment nodes remain mounted through the entire round.
    for (const reset of restore) reset();
  }
}

function pause(duration, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = completed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(completed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), duration);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) finish(false);
  });
}

/** Disposable visual layer shared by accepted playback and the local art inspector. */
export function mountFirstPersonExecutionBlood(container, loser, { reducedMotion = false, seed = 0 } = {}) {
  const rig = firstPersonRig(container);
  if (!rig || !INDICES.has(loser)) return null;
  const localHit = loser === rig.localIndex;
  const anchor = localHit ? container.querySelector('.fp-impact') : rig.opponent.querySelector('.gladiator');
  if (!anchor) return null;
  const blood = createPixelBloodEffect(container.ownerDocument || globalThis.document,
    { execution: true, reducedMotion, seed, view: localHit ? 'screen' : 'fighter' });
  blood.setAttribute('transform', localHit ? 'translate(460 270)' : 'translate(0 -65)');
  anchor.append(blood);
  return blood;
}

/** Show an already-authorized execution in the player's existing arena; never resolve it. */
export async function playFirstPersonExecutionAnimation(container, event, { signal, reducedMotion, onCue } = {}) {
  const rig = firstPersonRig(container);
  if (!rig || signal?.aborted || !INDICES.has(event?.winner) || event.loser !== 1 - event.winner
    || !WEAPONS.has(event.weapon)) return false;
  const camera = container.querySelector('.fp-camera');
  const hand = rig.local.querySelector('.fp-mainhand-motion');
  const motion = rig.opponent.querySelector('.fighter-motion');
  if (!camera || !hand || !motion) return false;

  const document = container.ownerDocument || globalThis.document;
  const reduce = reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const restore = [saveAttributes(container, ['class', 'data-fp-execution-phase', 'data-fp-execution-view']),
    ...[rig.local, rig.opponent].map(node => saveAttributes(node,
      ['data-animation', 'data-combat-action', 'data-guarding', 'data-riposting', 'data-defeated', 'data-fp-execution-role', 'data-weapon']))];
  const gladiator = rig.opponent.querySelector('.gladiator');
  if (gladiator) restore.push(saveAttributes(gladiator, ['class']));
  let caption;
  let shade;
  let blood;
  const attached = () => !signal?.aborted && container.isConnected && camera.isConnected
    && rig.local.isConnected && rig.opponent.isConnected;
  const wait = async duration => await pause(duration, signal) && attached();
  const impactCue = () => {
    if (typeof onCue !== 'function' || !attached()) return;
    try { onCue(Object.freeze({ type: 'execution', weapon: event.weapon }))?.catch?.(() => {}); }
    catch { /* A failed sound cannot change the accepted verdict. */ }
  };

  try {
    container.classList.add('fp-execution-playback');
    if (reduce) container.classList.add('fp-execution-reduced');
    container.dataset.fpExecutionView = event.winner === rig.localIndex ? 'victor' : 'defeated';
    for (const fighter of [rig.local, rig.opponent]) {
      for (const name of ['data-animation', 'data-combat-action', 'data-guarding', 'data-riposting', 'data-defeated']) fighter.removeAttribute(name);
      fighter.dataset.fpExecutionRole = Number(fighter.dataset.fighterIndex) === event.winner ? 'victor' : 'defeated';
    }
    const victor = event.winner === rig.localIndex ? rig.local : rig.opponent;
    victor.dataset.weapon = event.weapon;
    gladiator?.classList.remove('defeated');
    caption = document.createElement('div');
    caption.className = 'execution-caption fp-execution-caption';
    caption.setAttribute('role', 'status');
    caption.setAttribute('aria-live', 'polite');
    caption.textContent = event.text;
    container.append(caption);
    shade = document.createElement('div');
    shade.className = 'fp-execution-shade';
    shade.setAttribute('aria-hidden', 'true');
    container.append(shade);

    if (reduce) {
      container.dataset.fpExecutionPhase = 'impact';
      impactCue();
      blood = mountFirstPersonExecutionBlood(container, event.loser, { reducedMotion: reduce, seed: event.winner });
      return await wait(650);
    }
    container.dataset.fpExecutionPhase = 'windup';
    if (!await wait(500)) return false;
    container.dataset.fpExecutionPhase = 'strike';
    if (!await wait(220)) return false;
    container.dataset.fpExecutionPhase = 'impact';
    impactCue();
    blood = mountFirstPersonExecutionBlood(container, event.loser, { seed: event.winner });
    if (!await wait(900)) return false;
    container.dataset.fpExecutionPhase = 'settle';
    if (!await wait(330)) return false;
    return attached();
  } finally {
    blood?.remove();
    caption?.remove();
    shade?.remove();
    for (const reset of restore.reverse()) reset();
  }
}
