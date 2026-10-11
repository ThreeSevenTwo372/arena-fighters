/** Presentation geometry only: callers supply already-resolved public damage or a Kill verdict. */
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const BLOOD_PALETTE = Object.freeze(['#620d1c', '#891526', '#b52232', '#d33a3d', '#ed6350']);
const NORMAL_PARTICLE_LIMIT = 72;
const EXECUTION_PARTICLES = 96;

function variables(node, values) {
  // CSSOM assignment works under the game's strict style-src policy; assigning
  // a style attribute is blocked in the browser. The fallback supports inert
  // attribute-only SVG fixtures that have no stylesheet engine.
  if (node.style?.setProperty) {
    for (const [name, value] of Object.entries(values)) node.style.setProperty(name, value);
  } else node.setAttribute('style', Object.entries(values).map(([name, value]) => `${name}:${value}`).join(';'));
}

/** Bound the effect even when public damage is larger than the remaining health. */
export function pixelBloodProfile({ damage, execution = false, view = 'fighter' } = {}) {
  const validDamage = typeof damage === 'number' && Number.isFinite(damage) && damage > 0;
  if (!execution && !validDamage) return null;
  const resolvedDamage = validDamage ? damage : 0;
  const scale = view === 'screen' ? 3 : 1;
  const level = Math.min(24, Math.ceil(resolvedDamage));
  return Object.freeze({
    damage: resolvedDamage,
    execution: !!execution,
    view: view === 'screen' ? 'screen' : 'fighter',
    count: execution ? EXECUTION_PARTICLES : Math.min(NORMAL_PARTICLE_LIMIT, 4 + level * 3),
    spread: (execution ? 54 : 14 + level) * scale,
    scale,
    durationMs: execution ? 760 : 380,
  });
}

function seedValue(seed) {
  const value = String(seed ?? 0);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFrom(seed) {
  let state = seedValue(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let sample = Math.imul(state ^ state >>> 15, 1 | state);
    sample ^= sample + Math.imul(sample ^ sample >>> 7, 61 | sample);
    return ((sample ^ sample >>> 14) >>> 0) / 4294967296;
  };
}

/** Every square and movement milestone lands on the same native pixel grid. */
export function pixelBloodParticles({ damage, execution = false, seed = 0, reducedMotion = false, view = 'fighter' } = {}) {
  const profile = pixelBloodProfile({ damage, execution, view });
  if (!profile) return Object.freeze([]);
  const random = randomFrom(seed);
  const snap = value => Math.round(value / profile.scale) * profile.scale;
  const particles = [];
  for (let index = 0; index < profile.count; index++) {
    // Fan slightly upward from the wound, then let individual droplets fall.
    const angle = (random() * 1.75 - .875) * Math.PI;
    const radius = profile.spread * (.32 + random() * .68);
    const endX = snap(Math.sin(angle) * radius);
    const endY = snap(-Math.cos(angle) * radius * .62 + profile.spread * .36);
    const midX = snap(endX * .58);
    const midY = snap(endY * .45 - profile.spread * .12);
    const finalX = snap(endX);
    const finalY = profile.view === 'screen' ? Math.min(150, snap(endY + profile.spread * .35)) : snap(endY + profile.spread * .35);
    const size = (random() < .72 ? 2 : random() < .75 ? 3 : 1) * profile.scale;
    // Incoming blows mark the foreground edges, leaving the rival's center
    // clear. These offsets are relative to the shared screen anchor [460,270].
    const clusterX = profile.view === 'screen' ? index % 2 === 0 ? -240 : 240 : 0;
    const clusterY = profile.view === 'screen' ? -12 : 0;
    const x = clusterX + (reducedMotion ? snap(endX * .55) : snap((random() * 8 - 4) * profile.scale));
    const y = clusterY + (reducedMotion ? snap(endY * .55) : snap((random() * 7 - 6) * profile.scale));
    particles.push(Object.freeze({
      x, y, size,
      color: BLOOD_PALETTE[index % 11 === 0 ? 4 : Math.floor(random() * 4)],
      midX, midY, endX, endY, finalX, finalY,
    }));
  }
  return Object.freeze(particles);
}

/** An origin-centered SVG group; placement and lifetime stay with the existing animation clock. */
export function createPixelBloodEffect(document, options = {}) {
  const profile = pixelBloodProfile(options);
  if (!profile) return null;
  const group = document.createElementNS(SVG_NAMESPACE, 'g');
  group.setAttribute('class', 'pixel-blood-effect');
  group.setAttribute('aria-hidden', 'true');
  group.setAttribute('shape-rendering', 'crispEdges');
  group.setAttribute('data-blood-damage', String(profile.damage));
  group.setAttribute('data-blood-particles', String(profile.count));
  group.setAttribute('data-blood-execution', String(profile.execution));
  group.setAttribute('data-blood-view', profile.view);
  group.setAttribute('data-reduced-motion', String(!!options.reducedMotion));
  variables(group, { '--blood-duration': `${profile.durationMs}ms` });
  for (const particle of pixelBloodParticles(options)) {
    const node = document.createElementNS(SVG_NAMESPACE, 'rect');
    node.setAttribute('class', 'pixel-blood-particle');
    node.setAttribute('x', String(particle.x));
    node.setAttribute('y', String(particle.y));
    node.setAttribute('width', String(particle.size));
    node.setAttribute('height', String(particle.size));
    node.setAttribute('fill', particle.color);
    variables(node, { '--blood-mid-x': `${particle.midX}px`, '--blood-mid-y': `${particle.midY}px`,
      '--blood-end-x': `${particle.endX}px`, '--blood-end-y': `${particle.endY}px`,
      '--blood-final-x': `${particle.finalX}px`, '--blood-final-y': `${particle.finalY}px` });
    group.append(node);
  }
  return group;
}
