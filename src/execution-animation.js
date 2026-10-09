/** Execution playback is presentation of an accepted verdict, never a combat resolver. */
const INDICES = new Set([0, 1]);
const WEAPONS = new Set(['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident']);
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** A spare/draw/unresolved or mismatched verdict cannot produce an execution. */
export function buildExecutionEvent(duel, decision) {
  const winner = duel?.result?.winner;
  if (duel?.status !== 'complete' || !INDICES.has(winner) || duel.result.reason === 'draw'
    || !Array.isArray(duel.fighters) || duel.fighters.length !== 2
    || !duel.fighters.every(fighter => fighter && typeof fighter === 'object')
    || decision?.decision !== 'execute' || decision.winner !== winner || decision.loser !== 1 - winner) return null;
  const fighter = duel.fighters[winner];
  const selected = fighter.weapon ?? fighter.loadout?.weapon;
  const id = typeof selected === 'object' ? selected?.id : selected;
  const weapon = WEAPONS.has(id) ? id : 'sword';
  const winnerName = String(fighter.character?.name || 'The victor');
  const loserName = String(duel.fighters[1 - winner].character?.name || 'the defeated fighter');
  return Object.freeze({ winner, loser: 1 - winner, weapon, text: `${winnerName} executes ${loserName}.` });
}

function pause(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    let settled = false;
    const finish = completed => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), milliseconds);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) finish(false);
  });
}

function attributes(node, names) {
  const saved = names.map(name => [name, node.hasAttribute(name), node.getAttribute(name)]);
  return () => {
    for (const [name, present, value] of saved) {
      if (present) node.setAttribute(name, value);
      else node.removeAttribute(name);
    }
  };
}

function svgNode(document, tag, attrs = {}) {
  const node = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

// Read only the arena's recorded translations/scales. Outer facing and stands scale stay intact.
function placement(fighter, gladiator) {
  const transform = fighter.getAttribute('transform') || '';
  const translation = /translate\(\s*([-\d.]+)/.exec(transform);
  const scale = /scale\(\s*([-\d.]+)/.exec(transform);
  const nativeScale = /scale\(\s*([-\d.]+)/.exec(gladiator.getAttribute('transform') || '');
  return {
    x: Number(translation?.[1] ?? 0),
    scale: Math.abs(Number(scale?.[1] ?? 1) * Number(nativeScale?.[1] ?? 1)) || 1,
  };
}

function wrapMotion(document, motion) {
  const parent = motion.parentNode;
  // Carry the ground shadow with the registered complete figure as it closes the gap.
  const children = [...parent.childNodes];
  const wrapper = svgNode(document, 'g', { class: 'execution-motion' });
  const restore = () => {
    for (const child of children) parent.insertBefore(child, wrapper.parentNode === parent ? wrapper : null);
    wrapper.remove();
  };
  try {
    parent.insertBefore(wrapper, children[0] || null);
    for (const child of children) wrapper.append(child);
    return { wrapper, restore };
  } catch (error) {
    restore();
    throw error;
  }
}

function bloodEffect(document, weapon) {
  const effect = svgNode(document, 'g', {
    class: 'execution-blood', 'aria-hidden': 'true', 'shape-rendering': 'crispEdges',
  });
  const palette = ['#5b111b', '#861c27', '#b82b34', '#d8423d'];
  const stains = svgNode(document, 'g', { class: 'execution-sand-stains' });
  for (let i = 0; i < 19; i++) {
    const x = ((i * 29) % 106) - 55;
    const y = ((i * 7) % 13) - 4;
    stains.append(svgNode(document, 'rect', {
      x, y, width: 5 + (i % 5) * 3, height: 2 + i % 4,
      fill: palette[i % 2], opacity: .8,
    }));
  }
  effect.append(stains);
  const spray = svgNode(document, 'g', { class: 'execution-spray', transform: 'translate(0 -65)' });
  // Fixed integer cells are reproducible and stay in the defeated fighter's native coordinates.
  for (let i = 0; i < 46; i++) {
    const side = i % 2 ? -1 : 1;
    const travel = side * (14 + (i * 17) % 74);
    const rise = -12 - (i * 13) % 65;
    const fall = 56 + (i * 7) % 21;
    const size = 2 + i % 4;
    const pixel = svgNode(document, 'rect', {
      class: 'execution-blood-pixel', x: (i % 5) - 2, y: (i % 7) - 4,
      width: size, height: i % 7 === 0 ? size * 3 : size,
      fill: palette[i % palette.length],
    });
    pixel.style.setProperty('--burst-x', `${travel}px`);
    pixel.style.setProperty('--burst-rise', `${rise}px`);
    pixel.style.setProperty('--burst-fall', `${fall}px`);
    pixel.style.setProperty('--burst-delay', `${(i % 6) * 13}ms`);
    spray.append(pixel);
  }
  effect.append(spray);
  const slash = svgNode(document, 'g', { class: 'execution-slash' });
  const crushing = weapon === 'mace' || weapon === 'flail';
  const piercing = weapon === 'spear' || weapon === 'halberd' || weapon === 'dagger' || weapon === 'trident';
  for (let i = 0; i < 13; i++) {
    const x = crushing ? (i % 5) * 6 - 13 : i * 6 - 38;
    const y = crushing ? Math.floor(i / 5) * 7 - 77 : piercing ? -66 + (i % 2) * 3 : i * 4 - 91;
    slash.append(svgNode(document, 'rect', {
      x, y, width: crushing ? 9 : 8, height: crushing ? 10 : 7,
      fill: i % 3 === 0 ? '#f0b881' : '#df5143',
    }));
  }
  effect.append(slash);
  return effect;
}

/**
 * Play a server/local accepted execution. Complete identity, equipment and hands move together.
 * Every temporary node and modified attribute is restored, including on navigation/abort.
 */
export async function playExecutionAnimation(container, event, { signal, reducedMotion, onCue } = {}) {
  if (!container || signal?.aborted || !INDICES.has(event?.winner)
    || event.loser !== 1 - event.winner || !WEAPONS.has(event.weapon)) return false;
  const arena = container.querySelector('.arena-svg');
  const fighters = [0, 1].map(index => container.querySelector(`.arena-fighter[data-fighter-index="${index}"]`));
  const gladiators = fighters.map(fighter => fighter?.querySelector('.gladiator'));
  const motions = fighters.map(fighter => fighter?.querySelector('.fighter-motion'));
  if (!arena || fighters.some(fighter => !fighter) || gladiators.some(fighter => !fighter)
    || motions.some(motion => !motion) || !container.isConnected || !arena.isConnected) return false;

  const document = container.ownerDocument || globalThis.document;
  const reduce = reducedMotion ?? globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  const restore = [attributes(container, ['class', 'data-execution-phase']),
    ...fighters.map(fighter => attributes(fighter, ['class', 'data-defeated', 'data-animation', 'data-combat-action', 'data-guarding', 'data-execution-role', 'data-execution-weapon'])),
    ...gladiators.map(fighter => attributes(fighter, ['class']))];
  const wrappers = [];
  let blood;
  let caption;
  let vignette;
  const attached = () => !signal?.aborted && container.isConnected && arena.isConnected
    && fighters.every(fighter => fighter.isConnected);
  const wait = async duration => await pause(duration, signal) && attached();
  const impactCue = () => {
    if (typeof onCue !== 'function' || !attached()) return;
    try { onCue(Object.freeze({ type: 'execution', weapon: event.weapon }))?.catch?.(() => {}); }
    catch { /* A media failure must not change the confirmed verdict. */ }
  };
  try {
    container.classList.add('execution-playback');
    if (reduce) container.classList.add('execution-playback-reduced');
    for (let index = 0; index < 2; index++) {
      for (const name of ['data-defeated', 'data-animation', 'data-combat-action', 'data-guarding']) fighters[index].removeAttribute(name);
      gladiators[index].classList.remove('defeated');
      fighters[index].setAttribute('data-execution-role', index === event.winner ? 'victor' : 'defeated');
      fighters[index].setAttribute('data-execution-weapon', event.weapon);
      wrappers.push(wrapMotion(document, motions[index]));
    }
    const start = placement(fighters[event.winner], gladiators[event.winner]);
    const target = placement(fighters[event.loser], gladiators[event.loser]);
    const approach = Math.max(0, Math.round(Math.abs(target.x - start.x) / start.scale - 64));
    wrappers[event.winner].wrapper.style.setProperty('--execution-approach', `${approach}px`);
    caption = document.createElement('div');
    caption.className = 'execution-caption';
    caption.setAttribute('role', 'status');
    caption.setAttribute('aria-live', 'polite');
    caption.textContent = event.text;
    container.append(caption);
    vignette = document.createElement('div');
    vignette.className = 'execution-vignette';
    vignette.setAttribute('aria-hidden', 'true');
    container.append(vignette);

    if (reduce) {
      container.setAttribute('data-execution-phase', 'impact');
      impactCue();
      blood = bloodEffect(document, event.weapon);
      gladiators[event.loser].append(blood);
      return await wait(650);
    }
    container.setAttribute('data-execution-phase', 'windup');
    if (!await wait(520)) return false;
    container.setAttribute('data-execution-phase', 'strike');
    if (!await wait(220)) return false;
    container.setAttribute('data-execution-phase', 'impact');
    impactCue();
    blood = bloodEffect(document, event.weapon);
    gladiators[event.loser].append(blood);
    if (!await wait(1280)) return false;
    container.setAttribute('data-execution-phase', 'settle');
    if (!await wait(530)) return false;
    return attached();
  } finally {
    blood?.remove();
    caption?.remove();
    vignette?.remove();
    for (const wrapped of wrappers) wrapped.restore();
    for (const reset of restore.reverse()) reset();
  }
}
