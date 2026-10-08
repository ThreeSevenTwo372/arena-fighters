// Versioned equipment rig with linked, registered dark-fantasy identities.
import { normalizeAppearance, appearanceSignature, composeAvatarHeadPixels, decodeAvatarPng, encodeAvatarPng } from './avatar.js';
import { composeDarkIdentityPixels } from './dark-identity.js';

const MANIFEST_PATH = '/assets/clean-gladiator/v003/manifest.json';
const WEAPONS = ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword'];
const HELMETS = ['none', 'closed_bascinet', 'barbute', 'greathelm'];
const MAX_RENDERS = 24;
const MAX_TEXTURE_BYTES = 16 * 1024 * 1024;
const DEFAULTS = Object.freeze({ canvas: [192, 160], headOrigin: [64, 36], pivot: [96, 152], mainhandGrip: [70, 111], offhandGrip: [106, 113] });
let manifest, manifestUrl, manifestPromise;
let textureBytes = 0;
const textures = new Map(), pendingTextures = new Map(), renders = new Map(), pendingRenders = new Map();

const idOf = (value, fallback) => typeof value === 'object' ? value?.id ?? fallback : value ?? fallback;
const equipment = loadout => ({
  armor: ({ cloth: 'light', leather: 'medium', plate: 'heavy' })[idOf(loadout?.armor, 'light')] ?? (['light', 'medium', 'heavy'].includes(idOf(loadout?.armor, 'light')) ? idOf(loadout?.armor, 'light') : 'light'),
  weapon: WEAPONS.includes(idOf(loadout?.weapon, 'sword')) ? idOf(loadout?.weapon, 'sword') : 'sword',
  helmet: HELMETS.includes(idOf(loadout?.helmet, 'none')) ? idOf(loadout?.helmet, 'none') : 'none',
});
const pair = (value, fallback) => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) ? [...value] : [...fallback];
const bodyEntry = (data, sex, armor) => data.bodies?.[sex]?.[armor] ?? data.bodies?.[`${sex}/${armor}`];
const deepFreeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

function assetUrl(entry, base = manifestUrl) {
  if (!entry || typeof entry.url !== 'string') throw new Error('Clean character texture has no URL.');
  const url = new URL(entry.url, base);
  const directory = new URL('.', base).pathname;
  let decoded;
  try { decoded = decodeURIComponent(url.pathname); } catch { throw new Error('Clean character texture URL is invalid.'); }
  if (url.origin !== base.origin || !url.pathname.startsWith(directory) || !decoded.startsWith(directory) || decoded.includes('\\') || decoded.split('/').some(segment => segment === '..' || segment === '.')) throw new Error('Clean character texture URL is outside the versioned asset package.');
  if (!url.pathname.endsWith('.png') || url.search || url.hash) throw new Error('Clean character texture must be a local PNG.');
  return url.href;
}

function validateManifest(data, url) {
  if (!data || !['clean-v1', 'dark-v1'].includes(data.styleVersion) || !data.bodies || !data.weapons) throw new Error('Clean character catalog has an unsupported layout.');
  const normalized = { ...data };
  for (const [name, fallback] of Object.entries(DEFAULTS)) {
    if (data[name] !== undefined && (!Array.isArray(data[name]) || data[name].length !== 2 || !data[name].every(Number.isInteger))) throw new Error(`Clean character ${name} registration is invalid.`);
    normalized[name] = pair(data[name], fallback);
  }
  if (normalized.canvas[0] !== 192 || normalized.canvas[1] !== 160) throw new Error('Clean character canvas must be 192 by 160.');
  for (const name of ['headOrigin', 'pivot', 'mainhandGrip', 'offhandGrip']) if (normalized[name].some((value, axis) => value < 0 || value >= normalized.canvas[axis])) throw new Error(`Clean character ${name} is outside its frame.`);
  for (const sex of ['male', 'female']) for (const armor of ['light', 'medium', 'heavy']) {
    const entry = bodyEntry(data, sex, armor);
    assetUrl(entry, url);
    if (entry.width !== 192 || entry.height !== 160) throw new Error(`Clean character body ${sex}/${armor} has an invalid frame.`);
    if (entry.handsUrl) assetUrl({ url: entry.handsUrl }, url);
    for (const name of ['mainhandGrip', 'offhandGrip']) if (entry[name] !== undefined && (!Array.isArray(entry[name]) || entry[name].length !== 2 || !entry[name].every(Number.isInteger) || entry[name].some((value, axis) => value < 0 || value >= normalized.canvas[axis]))) throw new Error(`Clean character body ${sex}/${armor} ${name} is invalid.`);
  }
  for (const name of [...(data.styleVersion === 'dark-v1' ? WEAPONS : ['sword', 'spear', 'axe']), 'shield']) {
    const entry = data.weapons[name];
    assetUrl(entry, url);
    if (![entry.width, entry.height].every(value => Number.isInteger(value) && value > 0 && value <= 512)) throw new Error(`Clean character ${name} has invalid dimensions.`);
    if (!Array.isArray(entry.grip) || entry.grip.length !== 2 || !entry.grip.every(Number.isInteger) || entry.grip.some((value, axis) => value < 0 || value >= [entry.width, entry.height][axis])) throw new Error(`Clean character ${name} has an invalid grip.`);
  }
  if (data.styleVersion === 'dark-v1') for (const name of HELMETS.slice(1)) for (const kind of ['world', 'portrait']) {
    const entry = data.helmets?.[name]?.[kind];
    assetUrl(entry, url);
    if (![entry.width, entry.height].every(value => Number.isInteger(value) && value > 0 && value <= 1024)) throw new Error(`Clean character helmet ${name}/${kind} has invalid dimensions.`);
    if (kind === 'world' && (entry.width !== 192 || entry.height !== 160)) throw new Error('World helmet must share the registered body frame.');
    if (kind === 'portrait' && (!Array.isArray(entry.anchor) || entry.anchor.length !== 2 || !entry.anchor.every(Number.isInteger))) throw new Error('Portrait helmet needs a neck anchor.');
  }
  for (const part of Object.values(data.weapons.flail?.parts ?? {})) {
    assetUrl(part, url);
    if (![part.width, part.height].every(value => Number.isInteger(value) && value > 0 && value <= 512)) throw new Error('Flail part dimensions are invalid.');
    if (!Array.isArray(part.origin) || part.origin.length !== 2 || !part.origin.every(Number.isInteger)) throw new Error('Flail part origin is invalid.');
  }
  return deepFreeze(normalized);
}

export async function preloadCleanArt(config = {}) {
  if (manifest) return manifest;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const base = new URL(config.baseUrl ?? globalThis.location?.href ?? 'http://127.0.0.1:4173/');
    const url = new URL(config.manifestUrl ?? MANIFEST_PATH, base);
    if (url.origin !== base.origin || !/^\/assets\/clean-gladiator\/v\d+\/manifest\.json$/.test(url.pathname) || url.search || url.hash) throw new Error('Clean character catalog URL is outside the versioned asset package.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Clean character catalog could not load (${response.status}).`);
    const data = validateManifest(await response.json(), url);
    manifestUrl = url; manifest = data;
    return manifest;
  })();
  try { return await manifestPromise; } catch (error) { manifestPromise = undefined; throw error; }
}

async function loadTexture(entry) {
  const url = assetUrl(entry);
  if (textures.has(url)) {
    const value = textures.get(url); textures.delete(url); textures.set(url, value); return value;
  }
  if (pendingTextures.has(url)) return pendingTextures.get(url);
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Clean character texture could not load (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TEXTURE_BYTES) throw new Error('Clean character texture exceeds the memory limit.');
    const image = await decodeAvatarPng(bytes);
    if (image.width !== entry.width || image.height !== entry.height) throw new Error('Clean character texture dimensions disagree with its catalog.');
    textures.set(url, image); textureBytes += image.pixels.byteLength;
    while (textureBytes > MAX_TEXTURE_BYTES && textures.size > 1) {
      const oldest = textures.keys().next().value; textureBytes -= textures.get(oldest).pixels.byteLength; textures.delete(oldest);
    }
    return image;
  })();
  pendingTextures.set(url, pending);
  try { return await pending; } finally { pendingTextures.delete(url); }
}

const div255 = value => ((value >>> 8) + value) >>> 8;
function over(target, source) {
  for (let index = 0; index < target.length; index += 4) {
    const sa = source[index + 3];
    if (!sa) continue;
    const da = target[index + 3];
    if (sa === 255 || !da) { target.set(source.subarray(index, index + 4), index); continue; }
    const alpha = sa * 255 + da * (255 - sa);
    const c1 = Math.floor(sa * 255 * 255 * 128 / alpha), c2 = 255 * 128 - c1;
    for (let channel = 0; channel < 3; channel++) target[index + channel] = div255(source[index + channel] * c1 + target[index + channel] * c2 + (128 << 7)) >>> 7;
    target[index + 3] = div255(alpha + 128);
  }
}
const toBase64 = bytes => {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) value += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(value);
};
const request = (appearance, kind, loadout) => {
  const a = normalizeAppearance(appearance), gear = equipment(loadout);
  const presentation = kind === 'portrait' ? 'portrait' : kind === 'battle' ? 'battle' : 'idle';
  return { a, gear, kind: presentation, key: `${appearanceSignature(a)}|${presentation}|${gear.armor}|${gear.weapon}|${gear.helmet}` };
};
const weaponImage = entry => deepFreeze({ ...entry, url: assetUrl(entry), width: entry.width, height: entry.height, grip: [...entry.grip],
  ...(entry.parts ? { parts: Object.fromEntries(Object.entries(entry.parts).map(([name, part]) => [name, { ...part, url: assetUrl(part) }])) } : {}),
});

// Nearest-neighbor assembly is deterministic in browsers and Node, including
// portrait crops. It never changes the authored texture or identity palette.
function scaledFrame(image, canvas, scale, left, top) {
  const output = new Uint8Array(canvas[0] * canvas[1] * 4);
  for (let y = Math.max(0, top); y < Math.min(canvas[1], top + image.height * scale); y++) for (let x = Math.max(0, left); x < Math.min(canvas[0], left + image.width * scale); x++) {
    const source = (Math.floor((y - top) / scale) * image.width + Math.floor((x - left) / scale)) * 4;
    output.set(image.pixels.subarray(source, source + 4), (y * canvas[0] + x) * 4);
  }
  return output;
}

export async function prepareCleanAvatar(appearance, kind = 'battle', loadout = {}) {
  await preloadCleanArt();
  const plan = request(appearance, kind, loadout);
  if (renders.has(plan.key)) { const value = renders.get(plan.key); renders.delete(plan.key); renders.set(plan.key, value); return value; }
  if (pendingRenders.has(plan.key)) return pendingRenders.get(plan.key);
  const pending = (async () => {
    const body = bodyEntry(manifest, plan.a.body, plan.gear.armor);
    const isPortrait = plan.kind === 'portrait';
    const canvas = isPortrait ? [512, 640] : [...manifest.canvas];
    const anchor = isPortrait ? [256, 420] : pair(manifest.neckCenter, [96, 86]);
    const helmet = manifest.styleVersion === 'dark-v1' && plan.gear.helmet !== 'none' ? manifest.helmets[plan.gear.helmet][isPortrait ? 'portrait' : 'world'] : null;
    const [texture, head] = await Promise.all([
      loadTexture(body), helmet ? loadTexture(helmet) : manifest.styleVersion === 'dark-v1'
        ? composeDarkIdentityPixels(plan.a, isPortrait ? 'portrait' : 'chibi', { canvas, anchor })
        : composeAvatarHeadPixels(plan.a, { direction: 'W', canvas: [...manifest.canvas], headOrigin: [...manifest.headOrigin] }),
      loadTexture(manifest.weapons[plan.gear.weapon]), loadTexture(manifest.weapons.shield),
      ...(body.handsUrl ? [loadTexture({ url: body.handsUrl, width: body.width, height: body.height })] : []),
    ]);
    const pixels = isPortrait ? scaledFrame(texture, canvas, 6, 256 - 96 * 6, 420 - 86 * 6) : texture.pixels.slice();
    const identity = helmet && isPortrait ? scaledFrame(head, canvas, 1, anchor[0] - helmet.anchor[0], anchor[1] - helmet.anchor[1]) : head.pixels;
    if (identity.length !== pixels.length) throw new Error('Linked identity does not fit the clean character frame.');
    over(pixels, identity);
    const png = await encodeAvatarPng(canvas[0], canvas[1], pixels);
    const mainhand = weaponImage(manifest.weapons[plan.gear.weapon]), offhand = weaponImage(manifest.weapons.shield);
    const mainhandGrip = pair(body.mainhandGrip, manifest.mainhandGrip), offhandGrip = pair(body.offhandGrip, manifest.offhandGrip);
    const result = deepFreeze({
      url: `data:image/png;base64,${toBase64(png)}`, width: canvas[0], height: canvas[1],
      pivot: [...manifest.pivot], headOrigin: [...manifest.headOrigin], sourceFacing: 'W', nativeWeapon: false,
      mainhandGrip, offhandGrip,
      weaponImage: mainhand, shieldImage: offhand, equipment: { weapon: mainhand, shield: offhand },
      attachments: { mainhand: [...mainhandGrip], offhand: [...offhandGrip] },
      handsImage: body.handsUrl ? { url: assetUrl({ url: body.handsUrl }), width: body.width, height: body.height } : null,
      appearance: plan.a, kind: plan.kind, armor: plan.gear.armor, weapon: plan.gear.weapon, helmet: plan.gear.helmet, styleVersion: manifest.styleVersion,
    });
    renders.set(plan.key, result);
    while (renders.size > MAX_RENDERS) renders.delete(renders.keys().next().value);
    return result;
  })();
  pendingRenders.set(plan.key, pending);
  try { return await pending; } finally { pendingRenders.delete(plan.key); }
}

export function getCleanAvatarImage(appearance, kind = 'battle', loadout = {}) {
  return renders.get(request(appearance, kind, loadout).key) ?? null;
}

export function renderCleanAvatar(appearance, kind = 'world', loadout = {}, config = {}) {
  const image = getCleanAvatarImage(appearance, kind, loadout);
  if (!image) return '<span class="linked-avatar-loading" role="status">Preparing character art…</span>';
  const label = config.alt ?? `${image.appearance.body === 'female' ? 'Female' : 'Male'} gladiator in ${image.armor} armor${image.helmet !== 'none' ? ` wearing ${image.helmet.replaceAll('_', ' ')}` : ''}, carrying a ${image.weapon}`;
  if (kind === 'portrait') return `<img class="linked-avatar linked-avatar--portrait dark-portrait" src="${image.url}" width="${image.width}" height="${image.height}" alt="${escape(label)}" draggable="false">`;
  // Menu previews face west. Lean the blade outward around its authored grip
  // so the selected face and hairstyle stay visible behind the held equipment.
  const gear = (item, grip, className, angle = 0) => `<g class="${className}" transform="translate(${grip[0]} ${grip[1]})${angle ? ` rotate(${angle})` : ''}"><image href="${escape(item.url)}" x="${-item.grip[0]}" y="${-item.grip[1]}" width="${item.width}" height="${item.height}" class="pixel-sprite"/></g>`;
  return `<svg class="linked-avatar clean-avatar clean-avatar--${kind === 'battle' ? 'battle' : 'world'}" width="128" height="132" viewBox="24 24 128 132" role="img" aria-label="${escape(label)}">${gear(image.shieldImage, image.offhandGrip, 'clean-shield')}<image href="${escape(image.url)}" width="${image.width}" height="${image.height}" class="pixel-sprite"/>${gear(image.weaponImage, image.mainhandGrip, 'clean-mainhand', -40)}${image.handsImage ? `<image href="${escape(image.handsImage.url)}" width="${image.width}" height="${image.height}" class="pixel-sprite clean-hands"/>` : ''}</svg>`;
}

export function getCleanArtDiagnostics() {
  return { loaded: Boolean(manifest), textures: textures.size, textureBytes, renders: renders.size, pendingRenders: pendingRenders.size };
}
