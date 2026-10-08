// Arena-only assembly using the user's complete figure reference: preserved
// ready-stance armor, compact serious identity, and authored hand registration.
import { normalizeAppearance, appearanceSignature, decodeAvatarPng, encodeAvatarPng } from './avatar.js';
import { composeDarkIdentityPixels } from './dark-identity.js';
import { composeFixedIdentityPixels } from './fixed-identity.js';
import { normalizePresetAppearance } from './face-presets.js';
import { composePresetIdentityPixels, validatePresetCatalog } from './preset-identity.js';

const CATALOG = '/assets/clean-gladiator/v006/manifest.json';
const PRESET_CATALOG = '/assets/clean-gladiator/v013/manifest.json';
const WEAPONS = ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword'];
const OPTIONAL_WEAPONS = ['dagger'];
const HELMETS = ['none', 'closed_bascinet', 'barbute', 'greathelm'];
const MAX_RENDERS = 24, MAX_TEXTURE_BYTES = 16 * 1024 * 1024;
let catalog, catalogPromise, baseUrl, textureBytes = 0;
const renders = new Map(), pending = new Map(), textures = new Map(), pendingTextures = new Map();
const id = (value, fallback) => typeof value === 'object' ? value?.id ?? fallback : value ?? fallback;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const pair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const presetReviewRequested = () => new URLSearchParams(globalThis.location?.search ?? '').get('face-presets-review') === '1';
function request(appearance, kind, loadout) {
  if (kind === 'portrait') throw new Error('The arena identity has no portrait presentation.');
  const presetMode = catalog?.identityMode === 'preset-faces-v1' || (!catalog && presetReviewRequested());
  const a = presetMode ? normalizePresetAppearance(appearance) : normalizeAppearance(appearance);
  const armorId = id(loadout?.armor, 'light');
  const armor = ({ cloth: 'light', leather: 'medium', plate: 'heavy' })[armorId] ?? (['light', 'medium', 'heavy'].includes(armorId) ? armorId : 'light');
  const weaponId = id(loadout?.weapon, 'sword');
  const weapon = WEAPONS.includes(weaponId) || OPTIONAL_WEAPONS.includes(weaponId) && catalog?.weapons?.[weaponId] ? weaponId : 'sword';
  const helmet = HELMETS.includes(id(loadout?.helmet, 'none')) ? id(loadout?.helmet, 'none') : 'none';
  // Creator, equipment and combat use exactly the same assembled pixels.
  const identityKey = presetMode ? [a.sex, a.facePreset, a.skin, a.hairColor, a.eyes].join('/') : `${appearanceSignature(a)}|${a.beard}`;
  return { a, armor, weapon, helmet, key: `${identityKey}|${armor}|${weapon}|${helmet}` };
}
function textureUrl(entry) {
  if (!entry || !Number.isInteger(entry.width) || !Number.isInteger(entry.height) || entry.width <= 0 || entry.height <= 0 || entry.width > 512 || entry.height > 512) throw new Error('Arena equipment dimensions are invalid.');
  const url = new URL(entry.url, baseUrl);
  if (url.origin !== baseUrl.origin || !/^\/assets\/clean-gladiator\/v\d+(?:-equipment)?\/[\w/-]+\.png$/.test(url.pathname) || url.search || url.hash) throw new Error('Arena equipment must use a preserved local asset package.');
  return url.href;
}
export async function preloadCleanArt(config = {}) {
  if (catalog) return catalog;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    baseUrl = new URL(config.baseUrl ?? globalThis.location?.href ?? 'http://127.0.0.1:4173/');
    const url = new URL(config.manifestUrl ?? (presetReviewRequested() ? PRESET_CATALOG : CATALOG), baseUrl);
    if (url.origin !== baseUrl.origin || !/^\/assets\/clean-gladiator\/v\d+\/manifest\.json$/.test(url.pathname) || url.search || url.hash) throw new Error('Arena catalog must use a local versioned package.');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Arena catalog could not load (${response.status}).`);
    const data = await response.json();
    if (!['arena-identity-v1', 'arena-identity-v2', 'arena-identity-v3', 'arena-identity-v4'].includes(data.styleVersion)) throw new Error('Unsupported arena identity catalog.');
    if (data.styleVersion === 'arena-identity-v3' && data.identityMode !== 'fixed-skull-v1') throw new Error('Arena fixed face registration is missing.');
    if (data.styleVersion === 'arena-identity-v4') validatePresetCatalog(data, baseUrl);
    const identityTransform = data.identityTransform ?? { scale: 1, sourceAnchor: [96, 86], targetAnchor: [96, 86] };
    if (!Number.isFinite(identityTransform.scale) || identityTransform.scale < .5 || identityTransform.scale > 1
      || !pair(identityTransform.sourceAnchor) || !pair(identityTransform.targetAnchor)
      || [identityTransform.sourceAnchor, identityTransform.targetAnchor].some(anchor => anchor.some((p, axis) => p < 0 || p >= [192, 160][axis]))) throw new Error('Arena head socket registration is invalid.');
    for (const sex of ['male', 'female']) for (const armor of ['light', 'medium', 'heavy']) {
      const entry = data.bodies?.[sex]?.[armor]; textureUrl(entry);
      if (entry.width !== 192 || entry.height !== 160 || !pair(entry.mainhandGrip) || !pair(entry.offhandGrip)
        || [entry.mainhandGrip, entry.offhandGrip].some(grip => grip.some((p, axis) => p < 0 || p >= [192, 160][axis]))) throw new Error('Arena body registration is invalid.');
      textureUrl({ ...entry, url: entry.handsUrl });
    }
    for (const name of [...WEAPONS, 'shield']) {
      const entry = data.weapons?.[name]; textureUrl(entry);
      if (!pair(entry.grip) || entry.grip.some((p, axis) => p < 0 || p >= [entry.width, entry.height][axis])) throw new Error('Arena weapon grip is invalid.');
      for (const part of Object.values(entry.parts ?? {})) { textureUrl(part); if (!pair(part.origin)) throw new Error('Arena articulated part origin is invalid.'); }
    }
    for (const name of HELMETS.slice(1)) {
      const entry = data.helmets?.[name]; textureUrl(entry);
      if (entry.width !== 192 || entry.height !== 160) throw new Error('Arena helmet must use the registered source canvas.');
    }
    // Add new equipment without rewriting or requiring it in historical identity catalogs.
    if (config.equipmentManifestUrl !== undefined) {
      const equipmentUrl = new URL(config.equipmentManifestUrl, baseUrl);
      if (equipmentUrl.origin !== baseUrl.origin || !/^\/assets\/clean-gladiator\/v\d+-equipment\/manifest\.json$/.test(equipmentUrl.pathname) || equipmentUrl.search || equipmentUrl.hash) throw new Error('Arena equipment overlay must use a local versioned equipment package.');
      const equipmentResponse = await fetch(equipmentUrl);
      if (!equipmentResponse.ok) throw new Error(`Arena equipment catalog could not load (${equipmentResponse.status}).`);
      const equipment = await equipmentResponse.json();
      const identityVersion = /^\/assets\/clean-gladiator\/(v\d+)\/manifest\.json$/.exec(url.pathname)?.[1];
      if (equipment.schema !== 'last-laurel.arena-equipment.v1' || !equipment.compatibleIdentityCatalogs?.includes(identityVersion)
        || !equipment.weapons || typeof equipment.weapons !== 'object' || Array.isArray(equipment.weapons)) throw new Error('Arena equipment overlay does not match this identity catalog.');
      for (const [name, entry] of Object.entries(equipment.weapons)) {
        if (!OPTIONAL_WEAPONS.includes(name) || Object.hasOwn(data.weapons, name)) throw new Error('Arena equipment overlay cannot replace a preserved weapon.');
        textureUrl(entry);
        if (!pair(entry.grip) || entry.grip.some((p, axis) => p < 0 || p >= [entry.width, entry.height][axis]) || entry.sourceFacing !== 'W' || entry.parts) throw new Error('Arena optional weapon registration is invalid.');
      }
      data.weapons = { ...data.weapons, ...equipment.weapons };
      data.equipmentRevision = equipment.revision;
    }
    catalog = freeze({ ...data, identityTransform }); return catalog;
  })();
  try { return await catalogPromise; } catch (error) { catalogPromise = undefined; throw error; }
}
async function texture(entry) {
  const url = textureUrl(entry);
  if (textures.has(url)) { const image = textures.get(url); textures.delete(url); textures.set(url, image); return image; }
  if (pendingTextures.has(url)) return pendingTextures.get(url);
  const work = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Arena equipment could not load (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_TEXTURE_BYTES) throw new Error('Arena equipment exceeds the memory budget.');
    const image = await decodeAvatarPng(bytes);
    if (image.width !== entry.width || image.height !== entry.height) throw new Error('Arena texture dimensions disagree with its catalog.');
    textures.set(url, image); textureBytes += image.pixels.byteLength;
    while (textureBytes > MAX_TEXTURE_BYTES && textures.size > 1) { const oldest = textures.keys().next().value; textureBytes -= textures.get(oldest).pixels.byteLength; textures.delete(oldest); }
    return image;
  })();
  pendingTextures.set(url, work);
  try { return await work; } finally { pendingTextures.delete(url); }
}
const div255 = value => ((value >>> 8) + value) >>> 8;
// Register the whole identity at the garment's neck socket, independent of hair
// silhouette. One transform owns skull, rear hair, beard and enclosed helmets.
// The body's authored size, shoulders, hands and equipment never move with it.
function fitIdentity(image, rig) {
  if (rig.scale === 1 && rig.sourceAnchor.every((p, axis) => p === rig.targetAnchor[axis])) return image;
  const pixels = new Uint8Array(image.pixels.length);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const sx = Math.floor(rig.sourceAnchor[0] + (x + .5 - rig.targetAnchor[0]) / rig.scale);
    const sy = Math.floor(rig.sourceAnchor[1] + (y + .5 - rig.targetAnchor[1]) / rig.scale);
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) continue;
    const source = (sy * image.width + sx) * 4;
    pixels.set(image.pixels.subarray(source, source + 4), (y * image.width + x) * 4);
  }
  return { ...image, pixels };
}
// Seat an already prepared identity at the garment without fitting or changing
// any source pixel again. Helmets receive this same final group translation.
function translateIdentity(image, offset) {
  const [dx, dy] = offset;
  if (!dx && !dy) return image;
  const pixels = new Uint8Array(image.pixels.length);
  const materials = image.materials ? new Uint8Array(image.materials.length) : null;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const source = y * image.width + x, tx = x + dx, ty = y + dy;
    if (tx < 0 || ty < 0 || tx >= image.width || ty >= image.height) {
      if (image.pixels[source * 4 + 3]) throw new Error('Arena identity translation would clip authored pixels.');
      continue;
    }
    const target = ty * image.width + tx;
    pixels.set(image.pixels.subarray(source * 4, source * 4 + 4), target * 4);
    if (materials) materials[target] = image.materials[source];
  }
  return { ...image, pixels, ...(materials ? { materials } : {}) };
}
function overlay(target, source) {
  for (let i = 0; i < target.length; i += 4) {
    const sa = source[i + 3]; if (!sa) continue;
    const da = target[i + 3];
    if (sa === 255 || !da) { target.set(source.subarray(i, i + 4), i); continue; }
    const alpha = sa * 255 + da * (255 - sa);
    const c1 = Math.floor(sa * 255 * 255 * 128 / alpha), c2 = 255 * 128 - c1;
    for (let c = 0; c < 3; c++) target[i + c] = div255(source[i + c] * c1 + target[i + c] * c2 + (128 << 7)) >>> 7;
    target[i + 3] = div255(alpha + 128);
  }
}
async function pngUrl(image) {
  const png = await encodeAvatarPng(image.width, image.height, image.pixels);
  let binary = ''; for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}
const equipmentImage = entry => ({ ...entry, url: textureUrl(entry), ...(entry.parts ? { parts: Object.fromEntries(Object.entries(entry.parts).map(([name, part]) => [name, { ...part, url: textureUrl(part) }])) } : {}) });
export async function prepareCleanAvatar(appearance, kind = 'battle', loadout = {}) {
  await preloadCleanArt();
  const plan = request(appearance, kind, loadout);
  if (renders.has(plan.key)) { const image = renders.get(plan.key); renders.delete(plan.key); renders.set(plan.key, image); return image; }
  if (pending.has(plan.key)) return pending.get(plan.key);
  const work = (async () => {
    const helmet = plan.helmet === 'none' ? null : catalog.helmets[plan.helmet];
    const body = catalog.bodies[plan.a.sex][plan.armor];
    const [source, identity, hands] = await Promise.all([
      texture(body),
      helmet ? texture(helmet) : catalog.identityMode === 'preset-faces-v1'
        ? composePresetIdentityPixels(plan.a, { catalog, baseUrl }) : catalog.identityMode === 'fixed-skull-v1'
        ? composeFixedIdentityPixels(plan.a, catalog.identityTransform)
        : composeDarkIdentityPixels(plan.a, 'chibi', { canvas: [192, 160], anchor: [96, 86] }),
      texture({ ...body, url: body.handsUrl }),
      texture(catalog.weapons[plan.weapon]), texture(catalog.weapons.shield),
      ...Object.values(catalog.weapons[plan.weapon].parts ?? {}).map(texture),
    ]);
    const helmetTransform = helmet && catalog.identityMode === 'preset-faces-v1' ? catalog.helmetTransformBySex?.[plan.a.sex] ?? catalog.identityTransform : catalog.identityTransform;
    const fittedIdentity = !helmet && ['fixed-skull-v1', 'preset-faces-v1'].includes(catalog.identityMode) ? identity : fitIdentity(identity, helmetTransform);
    const identityOffset = catalog.identityMode === 'preset-faces-v1' ? catalog.identityOffsetBySex?.[plan.a.sex] ?? [0, 0] : [0, 0];
    const seatedIdentity = translateIdentity(fittedIdentity, identityOffset);
    const pixels = source.pixels.slice(); overlay(pixels, seatedIdentity.pixels);
    const url = await pngUrl({ ...source, pixels });
    const rightHand = body.mainhandGrip[0] >= 96;
    const image = freeze({
      url, width: source.width, height: source.height, pivot: [96, 152], headOrigin: [64, 36], sourceFacing: 'W', nativeWeapon: false,
      mainhandGrip: body.mainhandGrip, offhandGrip: body.offhandGrip,
      weaponImage: equipmentImage(catalog.weapons[plan.weapon]), shieldImage: equipmentImage(catalog.weapons.shield),
      handsImage: { url: textureUrl({ ...body, url: body.handsUrl }), width: hands.width, height: hands.height },
      // Stow on the actual hand's side so long blades never cross the face.
      weaponAngle: rightHand ? 40 : -40, weaponMirror: rightHand ? -1 : 1,
      appearance: plan.a, armor: plan.armor, weapon: plan.weapon, helmet: plan.helmet,
      identityTransform: catalog.identityTransform, identityOffset,
      helmetTransform: helmet ? helmetTransform : null,
      assembledIdentityAnchor: (fittedIdentity.anchor ?? helmetTransform.targetAnchor).map((value, axis) => value + identityOffset[axis]),
      styleVersion: catalog.styleVersion, kind: 'battle',
    });
    renders.set(plan.key, image); while (renders.size > MAX_RENDERS) renders.delete(renders.keys().next().value);
    return image;
  })();
  pending.set(plan.key, work);
  try { return await work; } finally { pending.delete(plan.key); }
}
export function getCleanAvatarImage(appearance, kind = 'battle', loadout = {}) { return renders.get(request(appearance, kind, loadout).key) ?? null; }
export function renderCleanAvatar(appearance, kind = 'world', loadout = {}, config = {}) {
  const image = getCleanAvatarImage(appearance, kind, loadout);
  if (!image) return '<span class="linked-avatar-loading" role="status">Preparing arena identity…</span>';
  const label = config.alt ?? `${image.appearance.sex === 'female' ? 'Female' : 'Male'} gladiator in ${image.armor} armor, carrying a ${image.weapon}${image.helmet !== 'none' ? ` wearing ${image.helmet.replaceAll('_', ' ')}` : ''}`;
  const gear = (item, grip, className, angle = 0, mirror = 1) => `<g class="${className}" transform="translate(${grip[0]} ${grip[1]}) rotate(${angle}) scale(${mirror} 1)"><image href="${escape(item.url)}" x="${-item.grip[0]}" y="${-item.grip[1]}" width="${item.width}" height="${item.height}" class="pixel-sprite"/></g>`;
  // Frame the assembled figure, including polearms. Source canvases and every
  // attachment stay untouched; this discards only verified transparent margins.
  return `<svg class="linked-avatar clean-avatar clean-avatar--${kind}" data-art-version="${escape(image.styleVersion)}" width="160" height="128" viewBox="0 32 160 128" role="img" aria-label="${escape(label)}">${gear(image.shieldImage, image.offhandGrip, 'clean-shield')}<image href="${escape(image.url)}" width="192" height="160" class="pixel-sprite"/>${gear(image.weaponImage, image.mainhandGrip, 'clean-mainhand', image.weaponAngle, image.weaponMirror)}<image href="${escape(image.handsImage.url)}" width="192" height="160" class="pixel-sprite clean-hands"/></svg>`;
}
export function getCleanArtDiagnostics() { return { loaded: Boolean(catalog), textures: textures.size, textureBytes, renders: renders.size, pendingRenders: pending.size }; }
