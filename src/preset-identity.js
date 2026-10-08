// Finished preset identities retain their registered canvas and authored face.
// Only the explicit skin / hair / iris masks can change a baked pixel's color.
import { avatarChoices, decodeAvatarPng } from './avatar.js';
import { normalizePresetAppearance } from './face-presets.js';

const WIDTH = 192, HEIGHT = 160, AREA = WIDTH * HEIGHT;
const MAX_SOURCES = 24, MAX_FILE_BYTES = 2 * 1024 * 1024;
const PRESETS = Array.from({ length: 10 }, (_, index) => `p${String(index + 1).padStart(2, '0')}`);
const sources = new Map(), pending = new Map();
const rgb = value => /^#[0-9a-f]{6}$/i.test(value ?? '') ? [1, 3, 5].map(start => Number.parseInt(value.slice(start, start + 2), 16)) : null;
const luminance = color => color[0] * .2126 + color[1] * .7152 + color[2] * .0722;

function packageBase(config) {
  return new URL(config.baseUrl ?? globalThis.location?.href ?? 'http://127.0.0.1:4173/');
}
function assetUrl(value, base) {
  if (typeof value !== 'string') throw new Error('Preset face texture has no URL.');
  const url = new URL(value, base);
  if (url.origin !== base.origin || !/^\/assets\/clean-gladiator\/v\d+\/faces\/[\w-]+\.png$/.test(url.pathname)
    || url.search || url.hash) throw new Error('Preset faces must use a local versioned face package.');
  return url.href;
}

export function validatePresetCatalog(catalog, baseUrl = globalThis.location?.href ?? 'http://127.0.0.1:4173/') {
  const base = new URL(baseUrl);
  if (catalog?.styleVersion !== 'arena-identity-v4' || catalog.identityMode !== 'preset-faces-v1') throw new Error('Preset face catalog has an unsupported layout.');
  const rig = catalog.identityTransform;
  if (!Number.isFinite(rig?.scale) || rig.scale < .5 || rig.scale > 1
    || [rig.sourceAnchor, rig.targetAnchor].some(anchor => !Array.isArray(anchor) || anchor.length !== 2 || anchor.some((value, axis) => !Number.isFinite(value) || value < 0 || value >= [WIDTH, HEIGHT][axis]))) throw new Error('Preset face neck registration is invalid.');
  const offsets = catalog.identityOffsetBySex;
  if (offsets !== undefined && (!offsets || typeof offsets !== 'object' || Array.isArray(offsets)
    || Object.keys(offsets).length !== 2 || Object.keys(offsets).some(sex => !['male', 'female'].includes(sex))
    || ['male', 'female'].some(sex => !Array.isArray(offsets[sex]) || offsets[sex].length !== 2
      || offsets[sex].some((value, axis) => !Number.isInteger(value) || Math.abs(value) > 4
        || rig.targetAnchor[axis] + value < 0 || rig.targetAnchor[axis] + value >= [WIDTH, HEIGHT][axis])))) throw new Error('Preset identity offsets must be bounded integer pairs for both sexes.');
  const helmetRigs = catalog.helmetTransformBySex;
  if (helmetRigs !== undefined && (!helmetRigs || typeof helmetRigs !== 'object' || Array.isArray(helmetRigs)
    || Object.keys(helmetRigs).length !== 2 || Object.keys(helmetRigs).some(sex => !['male', 'female'].includes(sex))
    || ['male', 'female'].some(sex => {
      const transform = helmetRigs[sex];
      return !transform || !Number.isFinite(transform.scale) || transform.scale < .5 || transform.scale > 1
        || [transform.sourceAnchor, transform.targetAnchor].some(anchor => !Array.isArray(anchor) || anchor.length !== 2
          || anchor.some((value, axis) => !Number.isInteger(value) || value < 0 || value >= [WIDTH, HEIGHT][axis]));
    }))) throw new Error('Preset helmet source transforms must be bounded complete socket rigs for both sexes.');
  for (const sex of ['male', 'female']) {
    const entries = catalog.facePresets?.[sex];
    if (!entries || Object.keys(entries).length !== PRESETS.length || Object.keys(entries).some(id => !PRESETS.includes(id))) throw new Error(`Preset face catalog must contain ten ${sex} identities.`);
    for (const id of PRESETS) {
      const entry = entries[id];
      if (!entry || entry.width !== WIDTH || entry.height !== HEIGHT) throw new Error(`Preset face ${sex}/${id} must use the registered 192×160 canvas.`);
      const url = new URL(assetUrl(entry.url, base)), mask = new URL(assetUrl(entry.materialsUrl, base));
      if (new URL('.', url).pathname !== new URL('.', mask).pathname) throw new Error('Preset face and material mask must share a versioned package.');
      for (const material of ['skin', 'hair', 'iris']) if (!rgb(entry.materialDefaults?.[material])) throw new Error(`Preset face ${sex}/${id} ${material} palette is invalid.`);
    }
  }
  return catalog;
}

async function decodeFile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Preset face could not load (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Preset face exceeds the texture memory budget.');
  const image = await decodeAvatarPng(bytes);
  if (image.width !== WIDTH || image.height !== HEIGHT) throw new Error('Preset face texture dimensions disagree with its registration.');
  return image;
}
async function source(entry, base) {
  const url = assetUrl(entry.url, base), maskUrl = assetUrl(entry.materialsUrl, base), key = `${url}|${maskUrl}`;
  if (sources.has(key)) { const image = sources.get(key); sources.delete(key); sources.set(key, image); return image; }
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const [image, mask] = await Promise.all([decodeFile(url), decodeFile(maskUrl)]);
    const materials = new Uint8Array(AREA);
    for (let p = 0; p < AREA; p++) {
      const offset = p * 4, alpha = mask.pixels[offset + 3];
      if (!alpha) continue;
      const channels = mask.pixels.subarray(offset, offset + 3), owner = channels.findIndex(value => value === 255);
      if (alpha !== 255 || owner < 0 || channels.some((value, index) => value !== (index === owner ? 255 : 0))) throw new Error('Preset material ownership must be exclusive red skin, green hair, or blue iris.');
      if (!image.pixels[offset + 3]) throw new Error('Preset material mask cannot own a transparent face pixel.');
      materials[p] = owner + 1;
    }
    const output = { ...image, materials };
    sources.set(key, output);
    while (sources.size > MAX_SOURCES) sources.delete(sources.keys().next().value);
    return output;
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

export async function composePresetIdentityPixels(appearance, config = {}) {
  const base = packageBase(config), catalog = validatePresetCatalog(config.catalog, base), a = normalizePresetAppearance(appearance);
  const entry = catalog.facePresets[a.sex][a.facePreset], original = await source(entry, base), pixels = original.pixels.slice();
  const targets = [
    avatarChoices.skin.find(option => option.id === a.skin).color,
    avatarChoices.hairColor.find(option => option.id === a.hairColor).color,
    avatarChoices.eyes.find(option => option.id === a.eyes).color,
  ].map(rgb);
  const defaults = ['skin', 'hair', 'iris'].map(material => rgb(entry.materialDefaults[material]));
  const changed = targets.map((color, index) => color.some((value, channel) => value !== defaults[index][channel]));
  for (let p = 0; p < AREA; p++) {
    const owner = original.materials[p] - 1;
    if (owner < 0 || !changed[owner]) continue;
    const offset = p * 4, shade = luminance(original.pixels.subarray(offset, offset + 3)) / Math.max(1, luminance(defaults[owner]));
    for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(Math.max(0, Math.min(255, targets[owner][channel] * shade)));
  }
  const anchor = [...catalog.identityTransform.targetAnchor];
  return {
    width: WIDTH, height: HEIGHT, pixels, materials: original.materials.slice(), appearance: a,
    anchor, sourceFacing: 'W', kind: 'chibi', expression: 'preset', facialHairAvailable: false,
    facePreset: a.facePreset, sourceUrl: entry.url, alreadyFitted: true,
    registration: { ...catalog.identityTransform, sourceAnchor: [...catalog.identityTransform.sourceAnchor], targetAnchor: anchor },
  };
}

export function getPresetIdentityDiagnostics() {
  return { sourceTextures: sources.size, pendingSources: pending.size, styleVersion: 'preset-faces-v1' };
}
