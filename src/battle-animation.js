/** Playback uses resolved public events. It never resolves combat or reads a secret choice. */
const FIGHTER_INDICES = new Set([0, 1]);
const WEAPON_IDS = new Set(['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** Derive visible actions from this round's authoritative events, including canceled moves. */
export function buildAnimationSteps(before, after, _pending) {
  const round = after?.lastRound;
  if (!Array.isArray(before?.fighters) || !Array.isArray(after?.fighters)
    || before.fighters.length !== 2 || after.fighters.length !== 2
    || !Array.isArray(round?.events) || round.round !== before.round) return [];

  const health = before.fighters.map(fighter => fighter.hp);
  const guarding = [false, false];
  const defeated = new Set();
  const steps = [];
  for (const event of round.events) {
    if (event.type === 'reveal') {
      steps.push({ type: 'reveal', actor: null, round: round.round, text: event.text });
      continue;
    }
    if (!FIGHTER_INDICES.has(event.actor)) continue;
    const actor = event.actor;
    const weapon = WEAPON_IDS.has(before.fighters[actor].weapon) ? before.fighters[actor].weapon : 'sword';
    const common = { actor, weapon, round: round.round, text: event.text };
    if (event.type === 'guard') {
      guarding[actor] = true;
      steps.push({ ...common, type: 'guard' });
    } else if (event.type === 'riposte' || event.type === 'riposte-miss') {
      steps.push({ ...common, type: event.type });
    } else if (event.type === 'recover') {
      steps.push({ ...common, type: 'recover', restored: event.restored });
    } else if (event.type === 'attack' && FIGHTER_INDICES.has(event.target) && health[actor] > 0) {
      const target = event.target;
      health[target] = Math.max(0, health[target] - event.damage);
      steps.push({
        ...common, type: 'attack', target, action: event.action,
        damage: event.damage, guarded: guarding[target], bypassedGuard: !!event.bypassedGuard,
        ...(event.parried ? { parried: true } : {}), ...(event.counter ? { counter: true } : {}),
        targetHp: health[target],
      });
      if (health[target] === 0 && !defeated.has(target)) {
        defeated.add(target);
        steps.push({ type: 'defeat', actor: target, round: round.round, text: `${before.fighters[target].character.name} is defeated.` });
      }
    }
    // Initiative and result are explanatory events. A skipped action has no animation.
  }
  return Object.freeze(steps.map(step => Object.freeze(step)));
}

function pause(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = completed => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function effect(fighter, label, kind) {
  if (!fighter) return;
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.classList.add('fighter-combat-effect', `combat-effect-${kind}`);
  group.setAttribute('aria-hidden', 'true');
  const labelNode = document.createElementNS(SVG_NAMESPACE, 'text');
  labelNode.textContent = label;
  labelNode.setAttribute('x', '0');
  labelNode.setAttribute('y', '-25');
  labelNode.setAttribute('text-anchor', 'middle');
  // The east fighter is mirrored to face inward; keep floating labels readable.
  if (fighter.dataset.fighterIndex === '1') labelNode.setAttribute('transform', 'scale(-1 1)');
  group.append(labelNode);
  if (kind === 'hit' || kind === 'blocked' || kind === 'break') {
    const spark = document.createElementNS(SVG_NAMESPACE, 'path');
    spark.classList.add('combat-impact-spark');
    spark.setAttribute('d', 'M-5 -13 L-5 -6 L-12 -6 L-12 1 L-5 1 L-5 8 L2 8 L2 1 L9 1 L9 -6 L2 -6 L2 -13 Z');
    group.append(spark);
  }
  let layer = fighter.querySelector('.fighter-effects');
  if (!layer) {
    // Fallback for SVG renderers without an explicit effects anchor.
    layer = document.createElementNS(SVG_NAMESPACE, 'g');
    layer.classList.add('fighter-effects', 'animation-generated-anchor');
    layer.setAttribute('transform', 'translate(0 -80)');
    fighter.append(layer);
  }
  layer.append(group);
}

function clearEffects(container) {
  container.querySelectorAll('.fighter-combat-effect').forEach(node => node.remove());
}

/**
 * Play already-resolved events, returning false when interrupted and true when complete.
 * The caller blocks the surrounding action controls until this promise completes.
 * Abort on screen changes, then render the final combat state after successful playback.
 */
export async function playBattleAnimation(container, steps, { signal, reducedMotion } = {}) {
  if (!container || signal?.aborted) return false;
  const reduce = reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const fighters = [0, 1].map(index => container.querySelector(`.arena-fighter[data-fighter-index="${index}"]`));
  const caption = document.createElement('div');
  caption.className = 'battle-animation-caption';
  caption.setAttribute('role', 'status');
  caption.setAttribute('aria-live', 'polite');
  container.classList.add('battle-playback');
  if (reduce) container.classList.add('battle-playback-reduced');
  container.append(caption);
  try {
    for (const step of steps) {
      if (signal?.aborted || !container.isConnected) return false;
      clearEffects(container);
      caption.textContent = step.text;
      if (step.type === 'reveal') {
        if (!await pause(reduce ? 160 : 360, signal)) return false;
        continue;
      }
      const fighter = fighters[step.actor];
      if (!fighter) continue;
      fighter.dataset.animation = step.type;
      if (step.weapon) fighter.dataset.weapon = step.weapon;
      if (step.action) fighter.dataset.combatAction = step.action;
      if (step.type === 'attack') {
        // The hand-mounted weapon moves first; the target reacts at the contact frame.
        if (!await pause(reduce ? 90 : 285, signal)) return false;
        const target = fighters[step.target];
        if (target) {
          target.dataset.animation = step.parried || (step.guarded && !step.bypassedGuard) ? 'blocked' : 'hit';
          effect(target, `${step.parried ? 'PARRY ' : ''}−${step.damage}`, step.parried ? 'blocked' : step.bypassedGuard ? 'break' : step.guarded ? 'blocked' : 'hit');
        }
        if (!await pause(reduce ? 150 : 380, signal)) return false;
        if (target) delete target.dataset.animation;
      } else if (step.type === 'guard') {
        fighter.dataset.guarding = 'true';
        effect(fighter, 'GUARD', 'guard');
        if (!await pause(reduce ? 180 : 420, signal)) return false;
      } else if (step.type === 'riposte') {
        fighter.dataset.riposting = 'true';
        effect(fighter, 'RIPOSTE', 'guard');
        if (!await pause(reduce ? 180 : 420, signal)) return false;
      } else if (step.type === 'riposte-miss') {
        delete fighter.dataset.riposting;
        effect(fighter, 'NO COUNTER', 'guard');
        if (!await pause(reduce ? 140 : 320, signal)) return false;
      } else if (step.type === 'recover') {
        effect(fighter, `+${step.restored} SP`, 'recover');
        if (!await pause(reduce ? 180 : 510, signal)) return false;
      } else if (step.type === 'defeat') {
        fighter.dataset.defeated = 'true';
        effect(fighter, 'DOWN', 'defeat');
        if (!await pause(reduce ? 180 : 480, signal)) return false;
      }
      delete fighter.dataset.animation;
      delete fighter.dataset.combatAction;
      if (!await pause(reduce ? 35 : 100, signal)) return false;
    }
    return !signal?.aborted;
  } finally {
    clearEffects(container);
    caption.remove();
    container.querySelectorAll('.animation-generated-anchor').forEach(node => node.remove());
    container.classList.remove('battle-playback', 'battle-playback-reduced');
    for (const fighter of fighters) {
      if (!fighter) continue;
      for (const key of ['animation', 'combatAction', 'guarding', 'riposting', 'defeated']) delete fighter.dataset[key];
    }
  }
}
