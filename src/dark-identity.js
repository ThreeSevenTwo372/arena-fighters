// Dark-fantasy identities keep face and hairstyle in one registered sprite.
// Palette changes affect materials, while linework and the neck anchor stay fixed.
import { avatarChoices, normalizeAppearance, appearanceSignature, decodeAvatarPng, encodeAvatarPng } from './avatar.js';

const MANIFEST_PATH = '/assets/clean-gladiator/v003/identity.json';
const LIMIT_BYTES = 24 * 1024 * 1024;
const LIMIT_RENDERS = 24;
const DEFAULT_CANVAS = Object.freeze({ portrait: [512, 640], chibi: [192, 160] });
const DEFAULT_ANCHOR = Object.freeze({ portrait: [256, 420], chibi: [96, 86] });
const DEFAULT_MATERIALS = Object.freeze({ skin: '#c58d70', hair: '#626e83', iris: '#429886' });
let manifest, manifestUrl, manifestPromise, textureBytes = 0;
const textures = new Map(), pendingTextures = new Map(), renders = new Map(), pendingRenders = new Map();
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const frozen = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(frozen); Object.freeze(value); } return value; };
const kindOf = kind => kind === 'portrait' ? 'portrait' : 'chibi';
const rgb = value => /^#[0-9a-f]{6}$/i.test(value ?? '') ? [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16)) : null;
const luminance = color => color[0] * .2126 + color[1] * .7152 + color[2] * .0722;
const pair = (value, fallback) => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) ? [...value] : [...fallback];

function assetUrl(entry, base = manifestUrl) {
  if (!entry || typeof entry.url !== 'string') throw new Error('Dark identity texture has no URL.');
  const url = new URL(entry.url, base), directory = new URL('.', base).pathname;
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new Error('Dark identity texture URL is invalid.'); }
  if (url.origin !== base.origin || !url.pathname.startsWith(directory) || !decoded.startsWith(directory) || decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..') || !url.pathname.endsWith('.png') || url.search || url.hash) throw new Error('Dark identity texture URL is outside the versioned asset package.');
  return url.href;
}

function validateEntry(entry, label, url) {
  assetUrl(entry, url);
  if (![entry.width, entry.height].every(value => Number.isInteger(value) && value > 0 && value <= 1024)) throw new Error(`Dark identity ${label} dimensions are invalid.`);
  if (!Array.isArray(entry.anchor) || entry.anchor.length !== 2 || !entry.anchor.every(Number.isInteger) || entry.anchor.some((value, axis) => value < 0 || value >= [entry.width, entry.height][axis])) throw new Error(`Dark identity ${label} neck anchor is invalid.`);
  if (entry.materialsUrl) assetUrl({ url: entry.materialsUrl }, url);
  if (entry.irisBounds && (!Array.isArray(entry.irisBounds) || entry.irisBounds.length !== 4 || !entry.irisBounds.every(Number.isInteger) || entry.irisBounds[0] < 0 || entry.irisBounds[1] < 0 || entry.irisBounds[2] > entry.width || entry.irisBounds[3] > entry.height || entry.irisBounds[2] <= entry.irisBounds[0] || entry.irisBounds[3] <= entry.irisBounds[1])) throw new Error(`Dark identity ${label} iris bounds are invalid.`);
  if (entry.eyeBounds && (!Array.isArray(entry.eyeBounds) || entry.eyeBounds.length !== 4 || !entry.eyeBounds.every(Number.isInteger) || entry.eyeBounds[0] < 0 || entry.eyeBounds[1] < 0 || entry.eyeBounds[2] > entry.width || entry.eyeBounds[3] > entry.height || entry.eyeBounds[2] <= entry.eyeBounds[0] || entry.eyeBounds[3] <= entry.eyeBounds[1])) throw new Error(`Dark identity ${label} eye bounds are invalid.`);
  for (const material of ['skin', 'hair', 'iris']) if (entry.materialDefaults?.[material] && !rgb(entry.materialDefaults[material])) throw new Error(`Dark identity ${label} ${material} palette is invalid.`);
}

function validateManifest(data, url) {
  if (!data || data.styleVersion !== 'dark-v1' || !data.identities) throw new Error('Dark identity catalog has an unsupported layout.');
  for (const sex of ['male', 'female']) for (const { id } of avatarChoices.hairstyle) for (const kind of ['portrait', 'chibi']) {
    const entry = data.identities[sex]?.[id]?.[kind];
    validateEntry(entry, `${sex}/${id}/${kind}`, url);
    for (const [eyeStyle, alternative] of Object.entries(entry.eyeVariants ?? {})) {
      if (!avatarChoices.eyeStyle.some(option => option.id === eyeStyle)) throw new Error('Dark identity eye variant is unknown.');
      validateEntry(alternative, `${sex}/${id}/${kind}/${eyeStyle}`, url);
    }
  }
  for (const [beard, phases] of Object.entries(data.beards ?? {})) {
    if (!avatarChoices.beard.some(option => option.id === beard && beard !== 'none')) throw new Error('Dark identity facial hair is unknown.');
    for (const kind of ['portrait', 'chibi']) validateEntry(phases[kind], `beard/${beard}/${kind}`, url);
  }
  return frozen(data);
}

export async function preloadDarkIdentity(config = {}) {
  if (manifest) return manifest;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const base = new URL(config.baseUrl ?? globalThis.location?.href ?? 'http://127.0.0.1:4173/');
    const url = new URL(config.manifestUrl ?? MANIFEST_PATH, base);
    if (url.origin !== base.origin || !/^\/assets\/clean-gladiator\/v\d+\/identity\.json$/.test(url.pathname) || url.search || url.hash) throw new Error('Dark identity catalog URL is outside the versioned asset package.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Dark identity catalog could not load (${response.status}).`);
    const data = validateManifest(await response.json(), url);
    manifestUrl = url; manifest = data;
    return manifest;
  })();
  try { return await manifestPromise; } catch (error) { manifestPromise = undefined; throw error; }
}

async function loadTexture(entry) {
  const url = assetUrl(entry);
  if (textures.has(url)) { const value = textures.get(url); textures.delete(url); textures.set(url, value); return value; }
  if (pendingTextures.has(url)) return pendingTextures.get(url);
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Dark identity texture could not load (${response.status}).`);
    const image = await decodeAvatarPng(new Uint8Array(await response.arrayBuffer()));
    if (image.width !== entry.width || image.height !== entry.height) throw new Error('Dark identity texture dimensions disagree with its catalog.');
    textures.set(url, image); textureBytes += image.pixels.byteLength;
    while (textureBytes > LIMIT_BYTES && textures.size > 1) { const first = textures.keys().next().value; textureBytes -= textures.get(first).pixels.byteLength; textures.delete(first); }
    return image;
  })();
  pendingTextures.set(url, pending);
  try { return await pending; } finally { pendingTextures.delete(url); }
}

// Exported for material-mask QA. Authored RGB masks have red skin, green hair,
// blue iris and transparent fixed pixels. Cool source hair is the fallback.
export function classifyDarkIdentityMaterial(color, x = 0, y = 0, config = {}, mask) {
  const [r, g, b, alpha = 255] = color;
  if (!alpha || Math.max(r, g, b) <= 48) return null;
  if (mask) {
    if (!mask[3]) return null;
    const peak = Math.max(mask[0], mask[1], mask[2]);
    return peak ? ['skin', 'hair', 'iris'][mask.findIndex((value, index) => index < 3 && value === peak)] : null;
  }
  if (config.material === 'hair') return 'hair';
  const insideIris = !config.irisBounds || (x >= config.irisBounds[0] && y >= config.irisBounds[1] && x < config.irisBounds[2] && y < config.irisBounds[3]);
  if (insideIris && g > r + 12 && b > r + 6 && g > b) return 'iris';
  if (b >= r + 4 && b >= g - 12) return 'hair';
  if (r > g + 8 && g >= b + 5) return 'skin';
  return null;
}

export function recolorDarkIdentityPixels(image, appearance, config = {}, materials) {
  const a = normalizeAppearance(appearance), pixels = image.pixels.slice();
  if (materials && (materials.width !== image.width || materials.height !== image.height || materials.pixels.length !== pixels.length)) throw new Error('Dark identity material mask dimensions disagree.');
  const target = Object.fromEntries([['skin', 'skin', a.skin], ['hair', 'hairColor', a.hairColor], ['iris', 'eyes', a.eyes]].map(([material, field, id]) => [material, rgb(avatarChoices[field].find(option => option.id === id).color)]));
  const bases = Object.fromEntries(Object.entries({ ...DEFAULT_MATERIALS, ...config.materialDefaults }).map(([key, value]) => [key, rgb(value)]));
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = (y * image.width + x) * 4, source = pixels.subarray(index, index + 4);
    const material = classifyDarkIdentityMaterial(source, x, y, config, materials?.pixels.subarray(index, index + 4));
    if (!material) continue;
    const shade = luminance(source) / Math.max(1, luminance(bases[material]));
    for (let channel = 0; channel < 3; channel++) {
      // Preserve original value contrast, including dark recesses and highlights.
      const value = target[material][channel] * Math.min(1, shade);
      pixels[index + channel] = Math.round(Math.max(0, Math.min(255, shade <= 1 ? value : target[material][channel] + (255 - target[material][channel]) * Math.min(.7, (shade - 1) * .55))));
    }
  }
  if (a.eyeStyle === 'sharp' && config.eyeBounds) {
    const [left, top, right, bottom] = config.eyeBounds;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const index = (y * image.width + x) * 4;
      if (!pixels[index + 3]) continue;
      const value = luminance(pixels.subarray(index, index + 3));
      // The intense variant deepens the authored brow and upper lid shadows.
      // Iris palette remains unchanged, so eye-color choices stay readable.
      const material = classifyDarkIdentityMaterial(image.pixels.subarray(index, index + 4), x, y, config, materials?.pixels.subarray(index, index + 4));
      if (material === 'iris') continue;
      if (value >= 110) continue;
      const contrast = .72;
      for (let channel = 0; channel < 3; channel++) pixels[index + channel] = Math.round(pixels[index + channel] * contrast);
    }
  }
  return { width: image.width, height: image.height, pixels };
}

const div255 = value => ((value >>> 8) + value) >>> 8;
function blit(target, image, left, top) {
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const dx = left + x, dy = top + y;
    if (dx < 0 || dy < 0 || dx >= target.width || dy >= target.height) continue;
    const si = (y * image.width + x) * 4, ti = (dy * target.width + dx) * 4, sa = image.pixels[si + 3], da = target.pixels[ti + 3];
    if (!sa) continue;
    if (sa === 255 || !da) { target.pixels.set(image.pixels.subarray(si, si + 4), ti); continue; }
    const alpha = sa * 255 + da * (255 - sa), c1 = Math.floor(sa * 255 * 255 * 128 / alpha), c2 = 255 * 128 - c1;
    for (let channel = 0; channel < 3; channel++) target.pixels[ti + channel] = div255(image.pixels[si + channel] * c1 + target.pixels[ti + channel] * c2 + (128 << 7)) >>> 7;
    target.pixels[ti + 3] = div255(alpha + 128);
  }
}

async function materialImage(entry, appearance) {
  const [image, materials] = await Promise.all([loadTexture(entry), entry.materialsUrl ? loadTexture({ url: entry.materialsUrl, width: entry.width, height: entry.height }) : undefined]);
  return recolorDarkIdentityPixels(image, appearance, entry, materials);
}

export async function composeDarkIdentityPixels(appearance, kind = 'chibi', config = {}) {
  await preloadDarkIdentity();
  const a = normalizeAppearance(appearance), phase = kindOf(kind);
  const original = manifest.identities[a.body][a.hairstyle][phase];
  const entry = original.eyeVariants?.[a.eyeStyle] ?? original;
  const canvas = pair(config.canvas, DEFAULT_CANVAS[phase]), anchor = pair(config.anchor ?? config.neckCenter, DEFAULT_ANCHOR[phase]);
  if (canvas.some(value => value <= 0 || value > 1024) || anchor.some((value, axis) => value < 0 || value >= canvas[axis])) throw new Error('Dark identity target registration is invalid.');
  const output = { width: canvas[0], height: canvas[1], pixels: new Uint8Array(canvas[0] * canvas[1] * 4) };
  const image = await materialImage(entry, a);
  blit(output, image, anchor[0] - entry.anchor[0], anchor[1] - entry.anchor[1]);
  const beard = a.body === 'male' && a.beard !== 'none' ? manifest.beards?.[a.beard]?.[phase] : undefined;
  if (beard) blit(output, await materialImage({ ...beard, material: 'hair' }, a), anchor[0] - beard.anchor[0], anchor[1] - beard.anchor[1]);
  return { ...output, appearance: a, anchor, sourceFacing: entry.sourceFacing ?? 'W', kind: phase, expression: 'solemn', facialHairAvailable: a.beard === 'none' || a.body === 'female' || Boolean(beard) };
}

const renderKey = (appearance, kind, config) => `${appearanceSignature(appearance)}|${kindOf(kind)}|${JSON.stringify(config.canvas ?? DEFAULT_CANVAS[kindOf(kind)])}|${JSON.stringify(config.anchor ?? config.neckCenter ?? DEFAULT_ANCHOR[kindOf(kind)])}`;
const toBase64 = bytes => { let value = ''; for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(value); };
export async function prepareDarkIdentity(appearance, kind = 'chibi', config = {}) {
  const key = renderKey(appearance, kind, config);
  if (renders.has(key)) { const image = renders.get(key); renders.delete(key); renders.set(key, image); return image; }
  if (pendingRenders.has(key)) return pendingRenders.get(key);
  const pending = (async () => {
    const pixels = await composeDarkIdentityPixels(appearance, kind, config), png = await encodeAvatarPng(pixels.width, pixels.height, pixels.pixels);
    const image = frozen({ ...pixels, pixels: undefined, url: `data:image/png;base64,${toBase64(png)}` });
    renders.set(key, image); while (renders.size > LIMIT_RENDERS) renders.delete(renders.keys().next().value);
    return image;
  })();
  pendingRenders.set(key, pending);
  try { return await pending; } finally { pendingRenders.delete(key); }
}

export function getDarkIdentityImage(appearance, kind = 'chibi', config = {}) { return renders.get(renderKey(appearance, kind, config)) ?? null; }
export function renderDarkIdentity(appearance, kind = 'chibi', config = {}) {
  const image = getDarkIdentityImage(appearance, kind, config);
  if (!image) return '<span class="linked-avatar-loading" role="status">Preparing character art…</span>';
  const label = config.alt ?? `${image.appearance.body === 'female' ? 'Female' : 'Male'} gladiator with a solemn expression`;
  return `<img class="linked-avatar linked-avatar--${kindOf(kind)} dark-identity" src="${image.url}" width="${image.width}" height="${image.height}" alt="${escape(label)}" draggable="false">`;
}
export function getDarkIdentityDiagnostics() { return { loaded: Boolean(manifest), textures: textures.size, textureBytes, renders: renders.size, pendingRenders: pendingRenders.size }; }
