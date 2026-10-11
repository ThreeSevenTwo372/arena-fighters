import { FIRST_PERSON_FRAME_CATALOG } from './first-person-frame-catalog.js';
import { FIRST_PERSON_AXIS_CATALOG } from './first-person-axis-catalog.js';
import { FIRST_PERSON_BLADE_CATALOG } from './first-person-blade-catalog.js';
import { FIRST_PERSON_ARMOR_FRAME_CATALOG } from './first-person-armor-frame-catalog.js';

const imageLoads = new Map();
const decodedImages = new Set();
const URL_PATTERN = /^\/assets\/first-person\/(?:v005\/[a-z0-9-]+|v00[67]\/greatsword-(?:light|medium|heavy)-windup-(?:porcelain|ivory|sand|copper|umber|ebony)|v008\/(?:sword|spear|axe|flail|halberd|mace|greatsword|dagger|trident(?:-netcast)?)-(?:light|medium|heavy)-(?:windup|contact|follow|recovery)-(?:porcelain|ivory|sand|copper|umber|ebony))\.png$/;
const POSES = ['windup', 'contact', 'follow', 'recovery'];
const NORMAL_TIMELINE = [[0, null], [90, 'windup'], [285, 'contact'], [365, 'follow'], [570, 'recovery'], [665, null]];
const FEINT_TIMELINE = [[0, null], [90, 'contact'], [180, 'windup'], [285, 'contact'], [365, 'follow'], [570, 'recovery'], [665, null]];

function selectFrames(clip, skin) {
  if (!clip?.fullFrame || clip.durationMs !== 665 || clip.contactMs !== 285 || clip.frames?.length !== 4) return null;
  const frames = {};
  for (const frame of clip.frames) {
    const url = frame.variants?.[skin];
    if (!URL_PATTERN.test(url ?? '') || frame.width !== 460 || frame.height !== 220 || !POSES.includes(frame.pose)) return null;
    frames[frame.pose] = url;
  }
  if (Object.keys(frames).length !== 4) return null;
  return Object.freeze(frames);
}

function actionClip(weapon, armor, artVersion) {
  const base = FIRST_PERSON_FRAME_CATALOG.clips?.[weapon]?.[armor];
  if (artVersion === 'v005' || !base) return base;
  if (!Array.isArray(base.frames)) return null;
  let clip = base;
  if (weapon === 'greatsword') {
    const version = artVersion === 'v006' ? 'v006' : 'v007';
    const overlay = version === 'v006' ? FIRST_PERSON_BLADE_CATALOG : FIRST_PERSON_AXIS_CATALOG;
    const replacement = overlay.overrides?.greatsword?.[armor]?.windup;
    if (overlay.schema !== 1 || overlay.version !== version
      || overlay.baseVersion !== 'v005' || replacement?.pose !== 'windup') return null;
    clip = { ...base, frames: base.frames.map(frame => frame.pose === 'windup' ? replacement : frame) };
  }
  if (artVersion !== 'v008') return clip;
  const overlay = FIRST_PERSON_ARMOR_FRAME_CATALOG;
  if (overlay.schema !== 1 || overlay.version !== 'v008' || overlay.baseVersion !== 'v007'
    || !overlay.overrides || typeof overlay.overrides !== 'object' || Array.isArray(overlay.overrides)) return null;
  const armors = overlay.overrides[weapon];
  if (armors === undefined) return clip;
  if (!armors || typeof armors !== 'object' || Array.isArray(armors)) return null;
  const replacements = armors[armor];
  if (replacements === undefined) return clip;
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)
    || Object.entries(replacements).some(([pose, frame]) => !POSES.includes(pose) || frame?.pose !== pose)) return null;
  return { ...clip, frames: clip.frames.map(frame => Object.hasOwn(replacements, frame.pose) ? replacements[frame.pose] : frame) };
}

/** Complete poses share one clock; v005/v006/v007 remain explicit prior-art comparisons. */
export function getFirstPersonFrameClip({ weapon, armor, skin = 'ivory', artVersion = 'v008' } = {}) {
  if (!['v005', 'v006', 'v007', 'v008'].includes(artVersion)) return null;
  const frames = selectFrames(actionClip(weapon, armor, artVersion), skin);
  if (!frames) return null;
  const techniqueFrames = weapon === 'trident'
    ? selectFrames(actionClip('trident-netcast', armor, artVersion), skin) : null;
  if (weapon === 'trident' && artVersion === 'v008'
    && Object.hasOwn(FIRST_PERSON_ARMOR_FRAME_CATALOG.overrides, 'trident-netcast') && !techniqueFrames) return null;
  return Object.freeze({ weapon, armor, skin, artVersion, frames, techniqueFrames });
}

export function firstPersonFrameAt(clip, elapsedMs, action = 'strike') {
  if (!clip) return null;
  const frames = clip.weapon === 'trident' && action === 'technique' ? clip.techniqueFrames : clip.frames;
  if (!frames) return null;
  const timeline = clip.weapon === 'sword' && action === 'technique' ? FEINT_TIMELINE : NORMAL_TIMELINE;
  const elapsed = Math.max(0, Math.min(665, Number(elapsedMs) || 0));
  const pose = timeline.findLast(([at]) => at <= elapsed)[1];
  return { pose: pose ?? 'idle', url: pose ? frames[pose] : null };
}

const clipUrls = clip => [...Object.values(clip.frames), ...Object.values(clip.techniqueFrames ?? {})];

function loadImage(url) {
  if (imageLoads.has(url)) return imageLoads.get(url);
  if (typeof globalThis.Image !== 'function') return Promise.resolve(false);
  const promise = new Promise(resolve => {
    const image = new globalThis.Image();
    let settled = false;
    const finish = success => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = image.onerror = null;
      if (success) decodedImages.add(url);
      resolve(success);
    };
    const timer = setTimeout(() => finish(false), 2500);
    image.onerror = () => finish(false);
    image.onload = () => {
      if (typeof image.decode === 'function') image.decode().then(() => finish(true), () => finish(false));
      else finish(true);
    };
    image.src = url;
  });
  imageLoads.set(url, promise);
  promise.then(success => { if (!success) imageLoads.delete(url); });
  return promise;
}

/** Playback never waits for network work or changes the shared presentation clock. */
export function preparedFirstPersonFrameClip(selection) {
  const clip = getFirstPersonFrameClip(selection);
  return clip && clipUrls(clip).every(url => decodedImages.has(url)) ? clip : null;
}

/** A missing frame keeps the entire attack on its preserved transform fallback. */
export async function preloadFirstPersonFrames(selection, { signal, loadFrame = loadImage } = {}) {
  const clip = getFirstPersonFrameClip(selection);
  if (!clip || signal?.aborted) return null;
  const ready = Promise.all(clipUrls(clip).map(url => Promise.resolve().then(() => loadFrame(url)).catch(() => false)));
  let abort;
  const aborted = new Promise(resolve => {
    abort = () => resolve(null);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) resolve(null);
  });
  try {
    const results = signal ? await Promise.race([ready, aborted]) : await ready;
    return results?.every(Boolean) && !signal?.aborted ? clip : null;
  } finally { signal?.removeEventListener('abort', abort); }
}

/** One complete image swaps atomically; arms and their held items never separate. */
export function applyFirstPersonFrame(node, clip, elapsedMs, action) {
  if (!node?.isConnected || !clip) return false;
  const image = node.querySelector('.fp-authored-frame');
  if (!image?.isConnected) return false;
  const frame = firstPersonFrameAt(clip, elapsedMs, action);
  if (!frame) {
    image.removeAttribute('href');
    node.removeAttribute('data-frame-pose');
    return false;
  }
  if (frame.url && image.getAttribute('href') !== frame.url) image.setAttribute('href', frame.url);
  else if (!frame.url) image.removeAttribute('href');
  if (node.getAttribute('data-frame-pose') !== frame.pose) node.setAttribute('data-frame-pose', frame.pose);
  return true;
}
