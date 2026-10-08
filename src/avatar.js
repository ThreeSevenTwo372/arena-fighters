// Browser port of D-PIXEL's linked portrait / world / equipped avatar rig.
// Exported layers retain the source palette pixels, registration and draw order.
const MANIFEST_PATH = '/assets/dpixel-avatar/v001/manifest.json';
const MAX_LAYER_BYTES = 32 * 1024 * 1024;
const MAX_RENDERS = 24;

const options = rows => Object.freeze(rows.map(([id, label, color]) => Object.freeze({ id, label, ...(color ? { color } : {}) })));
const bodies = options([['male', 'Male'], ['female', 'Female']]);
export const avatarChoices = Object.freeze({
  body: bodies,
  sex: bodies,
  hairstyle: options([['none', 'Bald'], ['shag', 'Tousled'], ['short_swept', 'Short swept'], ['cropped', 'Cropped'], ['braided_ponytail', 'Braided ponytail'], ['high_ponytail', 'High ponytail'], ['center_part_medium', 'Center part'], ['swept_back_undercut', 'Swept undercut'], ['shoulder_length_loose', 'Shoulder length']]),
  skin: options([['porcelain', 'Porcelain', '#eed4bc'], ['ivory', 'Ivory', '#dbb798'], ['sand', 'Sand', '#bf936c'], ['copper', 'Copper', '#a8744f'], ['umber', 'Umber', '#785236'], ['ebony', 'Ebony', '#493225']]),
  hairColor: options([['raven', 'Raven', '#25232a'], ['chestnut', 'Chestnut', '#634630'], ['auburn', 'Auburn', '#864738'], ['ashen', 'Ash brown', '#797269'], ['silver', 'Silver', '#bfc3c7'], ['wheat', 'Wheat', '#bea26b'], ['wine', 'Wine', '#743145'], ['indigo', 'Indigo', '#464266']]),
  eyes: options([['amber', 'Amber', '#a97432'], ['moss', 'Moss', '#7a8150'], ['jade', 'Jade', '#518e73'], ['ice', 'Ice', '#8dc2d5'], ['storm', 'Storm', '#71859b'], ['violet', 'Violet', '#9372aa'], ['ruby', 'Ruby', '#a24648'], ['umber', 'Brown', '#684333']]),
  eyeStyle: options([['classic', 'Classic'], ['sharp', 'Sharp']]),
  beard: options([['none', 'Clean shaven'], ['stubble', 'Stubble'], ['trimmed_full', 'Trimmed beard'], ['moustache_goatee', 'Moustache & goatee']]),
});

export const defaultAppearance = Object.freeze({
  schema: 1, body: 'male', sex: 'male', hairstyle: 'shag', skin: 'ivory',
  hairColor: 'chestnut', eyes: 'amber', eyeStyle: 'classic', beard: 'none',
});

function choice(value, field, fallback, offset = 0) {
  const list = avatarChoices[field];
  if (typeof value === 'number' && Number.isInteger(value)) return list[value + offset]?.id ?? fallback;
  return list.some(item => item.id === value) ? value : fallback;
}

// Accept the source's zero-based fields as well as this prototype's readable IDs.
export function normalizeAppearance(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const body = choice(value.sex ?? value.body, 'body', defaultAppearance.body);
  return {
    schema: 1, body, sex: body,
    hairstyle: choice(value.hairstyle ?? value.hairStyle ?? value.hair, 'hairstyle', defaultAppearance.hairstyle, value.hairstyle === undefined && value.hairStyle === undefined ? 1 : 0),
    skin: choice(value.skin, 'skin', defaultAppearance.skin),
    hairColor: choice(value.hairColor, 'hairColor', defaultAppearance.hairColor),
    eyes: choice(value.eyes ?? value.eyeColor ?? value.iris, 'eyes', defaultAppearance.eyes),
    eyeStyle: choice(value.eyeStyle, 'eyeStyle', defaultAppearance.eyeStyle),
    // Preserve a man's facial hair choice when switching to female, like D-PIXEL.
    // The compositor suppresses it for the female rig.
    beard: choice(value.beard ?? value.linkedBeard, 'beard', defaultAppearance.beard),
    // Preserve the candidate's stable identity through character/network copies.
    // Historic recipes retain their original shape when no preset was supplied.
    ...(typeof value.facePreset === 'string' && /^p(?:0[1-9]|10)$/.test(value.facePreset) ? { facePreset: value.facePreset } : {}),
  };
}

export const appearanceSignature = appearance => {
  const a = normalizeAppearance(appearance);
  return [a.body, a.hairstyle, a.skin, a.hairColor, a.eyes, a.eyeStyle, a.body === 'male' ? a.beard : 'none'].join('/');
};

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const equipmentId = (value, fallback) => typeof value === 'object' ? value?.id ?? fallback : value ?? fallback;
const wardrobeFor = loadout => {
  const armor = equipmentId(loadout?.armor, 'light');
  return ({ light: 'plain', cloth: 'plain', medium: 'Bow', leather: 'Bow', heavy: 'SwordShield', plate: 'SwordShield' })[armor] ?? 'plain';
};

let manifest;
let manifestUrl;
let manifestPromise;
let layerBytes = 0;
const layerCache = new Map();
const pendingLayers = new Map();
const renderCache = new Map();
const pendingRenders = new Map();

export async function preloadAvatarAssets(config = {}) {
  if (manifest) return manifest;
  if (manifestPromise) return manifestPromise;
  manifestPromise = (async () => {
    const base = config.baseUrl ?? globalThis.location?.href ?? 'http://127.0.0.1:4173/';
    manifestUrl = new URL(config.manifestUrl ?? MANIFEST_PATH, base);
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`Avatar catalog could not load (${response.status}).`);
    const data = await response.json();
    if (!data.avatar?.structures || !data.avatar?.layers || !data.equipment?.frames || !data.equipment?.assets) throw new Error('Avatar catalog has an unsupported layout.');
    for (const [field, actual] of [['hairstyle', data.hairIds], ['eyeStyle', data.eyeStyleIds], ['beard', data.beardIds], ['skin', data.paletteIds?.skin], ['hairColor', data.paletteIds?.hair], ['eyes', data.paletteIds?.iris]]) {
      if (!Array.isArray(actual) || actual.join('|') !== avatarChoices[field].map(item => item.id).join('|')) throw new Error(`Avatar catalog ${field} options do not match the exported rig.`);
    }
    manifest = data;
    return data;
  })();
  try { return await manifestPromise; } catch (error) { manifestPromise = undefined; throw error; }
}

const paletteIndices = appearance => [
  avatarChoices.skin.findIndex(item => item.id === appearance.skin),
  avatarChoices.hairColor.findIndex(item => item.id === appearance.hairColor),
  avatarChoices.eyes.findIndex(item => item.id === appearance.eyes),
];

function variantIndex(entry, palette) {
  let index = 0;
  const counts = [6, 8, 8];
  entry.materials.forEach((active, axis) => { if (active) index = index * counts[axis] + palette[axis]; });
  return index;
}

function textureUrl(entry) {
  if (typeof entry.url !== 'string') throw new Error('A body placeholder cannot be decoded as an identity layer.');
  const url = new URL(entry.url, manifestUrl);
  const directory = new URL('.', manifestUrl).pathname;
  if (url.origin !== manifestUrl.origin || !url.pathname.startsWith(directory)) throw new Error('Avatar layer URL is outside the exported asset package.');
  return url.href;
}

async function loadLayer(entry, palette) {
  const url = textureUrl(entry);
  let texture = layerCache.get(url);
  if (texture) { layerCache.delete(url); layerCache.set(url, texture); }
  else {
    let pending = pendingLayers.get(url);
    if (!pending) {
      pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Avatar layer could not load (${response.status}).`);
        const decoded = await decodeAvatarPng(new Uint8Array(await response.arrayBuffer()));
        layerCache.set(url, decoded); layerBytes += decoded.pixels.byteLength;
        while (layerBytes > MAX_LAYER_BYTES && layerCache.size > 1) {
          const oldest = layerCache.keys().next().value;
          layerBytes -= layerCache.get(oldest).pixels.byteLength;
          layerCache.delete(oldest);
        }
        return decoded;
      })();
      pendingLayers.set(url, pending);
      pending.finally(() => pendingLayers.delete(url)).catch(() => {});
    }
    texture = await pending;
  }
  const rect = entry.variants[variantIndex(entry, palette)];
  if (!rect || rect[2] !== entry.width || rect[3] !== entry.height || rect[0] < 0 || rect[1] < 0 || rect[0] + rect[2] > texture.width || rect[1] + rect[3] > texture.height) throw new Error('Avatar palette rectangle is invalid.');
  return { ...texture, rect, layerWidth: entry.width, layerHeight: entry.height };
}

const blank = (width, height) => ({ width, height, pixels: new Uint8Array(width * height * 4) });
const div255 = value => ((value >>> 8) + value) >>> 8;

// Same integer straight-alpha over operator as LinkedAvatarData.cpp / Pillow.
// Canvas drawImage would alter translucent palette pixels by premultiplying them.
function over(target, ti, source, si) {
  const sa = source[si + 3];
  if (sa === 0) return;
  const da = target[ti + 3];
  if (sa === 255 || da === 0) {
    target[ti] = source[si]; target[ti + 1] = source[si + 1]; target[ti + 2] = source[si + 2]; target[ti + 3] = sa;
    return;
  }
  const alpha = sa * 255 + da * (255 - sa);
  const c1 = Math.floor(sa * 255 * 255 * 128 / alpha);
  const c2 = 255 * 128 - c1;
  for (let channel = 0; channel < 3; channel++) target[ti + channel] = div255(source[si + channel] * c1 + target[ti + channel] * c2 + (128 << 7)) >>> 7;
  target[ti + 3] = div255(alpha + 128);
}

function blit(target, source, x, y, crop = [0, 0, source.layerWidth, source.layerHeight]) {
  const [sx, sy, width, height] = crop;
  const [atlasX, atlasY] = source.rect;
  for (let yy = 0; yy < height; yy++) {
    const dy = y + yy;
    if (dy < 0 || dy >= target.height) continue;
    for (let xx = 0; xx < width; xx++) {
      const dx = x + xx;
      if (dx < 0 || dx >= target.width) continue;
      over(target.pixels, (dy * target.width + dx) * 4, source.pixels, ((atlasY + sy + yy) * source.width + atlasX + sx + xx) * 4);
    }
  }
}

function composite(target, source) {
  for (let index = 0; index < target.pixels.length; index += 4) over(target.pixels, index, source.pixels, index);
}

const bodySource = path => path.startsWith('Assets/Outfits/') || path.startsWith('Assets/World/male/') || path.startsWith('Assets/World/female/');
const bodyPart = path => path.endsWith('rear.png') ? 'rear' : path.endsWith('front.png') ? 'front' : 'base';
const frameFor = (frames, row, col) => frames.find(frame => frame.row === row && frame.col === col);

function requestPlan(appearance, kind, loadout, config) {
  const a = normalizeAppearance(appearance);
  const wardrobe = ['plain', 'Bow', 'SwordShield', 'Greatsword'].includes(config.wardrobe) ? config.wardrobe : wardrobeFor(loadout);
  const action = kind === 'portrait' ? 'portrait' : kind === 'thumbnail' ? 'thumbnail' : kind === 'battle' ? 'battle_idle' : (config.action === 'walk' || config.action === 'seated_idle' ? config.action : 'idle');
  const direction = action === 'battle_idle' ? 'W' : ['S', 'W', 'E', 'N'].includes(config.direction) ? config.direction : 'E';
  const row = action === 'portrait' ? Math.max(0, Math.min(2, Math.trunc(config.lid ?? 0))) : ['S', 'W', 'E', 'N'].indexOf(direction);
  const col = action === 'portrait' ? Math.max(0, Math.min(3, Math.trunc(config.mouth ?? 0))) : action === 'walk' ? Math.max(0, Math.min(3, Math.trunc(config.frame ?? 0))) : 0;
  const weapon = ['sword', 'spear', 'axe'].includes(equipmentId(loadout?.weapon, 'sword')) ? equipmentId(loadout?.weapon, 'sword') : 'sword';
  const items = Array.isArray(config.items) ? config.items.filter(item => ['legion_shield', 'legion_sword', 'recruit_greatsword', 'ash_bow'].includes(item)) : undefined;
  return { a, wardrobe, action, direction, row, col, weapon, items, key: `${appearanceSignature(a)}|${action}|${wardrobe}|${direction}|${row}|${col}|${weapon}|${items?.join(',') ?? 'equipped'}` };
}

function beardCommands(plan, headOrigin) {
  if (plan.a.body !== 'male' || plan.a.beard === 'none') return [];
  const beard = manifest.avatar.beardOverlays[plan.a.beard];
  let frame;
  let shift = [0, 0];
  if (plan.action === 'portrait') frame = frameFor(beard.portrait.frames, plan.row, plan.col);
  else if (plan.action === 'thumbnail') frame = beard.thumbnail;
  else { frame = beard.world[plan.direction]; shift = [headOrigin[0] - frame.headOrigin[0], headOrigin[1] - frame.headOrigin[1]]; }
  if (!frame) throw new Error('Selected facial hair phase is missing.');
  return frame.commands.map(command => ({ ...command, x: command.x + shift[0], y: command.y + shift[1] }));
}

async function composePlan(plan) {
  const { a, action, direction, row, col, wardrobe } = plan;
  const structure = manifest.avatar.structures[`${a.body}/${a.hairstyle}/${a.eyeStyle}`];
  if (!structure) throw new Error('Selected linked identity is missing.');
  const source = action === 'thumbnail' ? structure.thumbnail : frameFor(structure.sheets[action === 'battle_idle' ? 'idle' : action].frames, row, col);
  if (!source) throw new Error('Selected linked frame is missing.');
  const equipmentKey = `${a.body}/${action}/${action === 'portrait' ? 'S' : direction}/${action === 'portrait' ? 0 : col}${action === 'battle_idle' ? `/${wardrobe}` : ''}`;
  const frame = action === 'thumbnail' ? undefined : manifest.equipment.frames[equipmentKey];
  if (action !== 'thumbnail' && !frame) throw new Error(`Equipment rig is missing ${equipmentKey}.`);
  const canvas = action === 'thumbnail' ? source.canvas : frame.canvas;
  const output = blank(...canvas);
  const headShift = action === 'portrait' || action === 'thumbnail' ? [0, 0] : [frame.headOrigin[0] - source.headOrigin[0], frame.headOrigin[1] - source.headOrigin[1]];
  const facialHair = beardCommands(plan, action === 'thumbnail' ? [0, 0] : action === 'portrait' ? source.headOrigin : frame.headOrigin);
  const palette = paletteIndices(a);
  const neededHead = [...source.commands, ...facialHair].filter(command => !manifest.avatar.layers[command.layer]?.externalBodyPlaceholder);
  const selectedGear = action === 'battle_idle' ? plan.items ?? ['legion_shield', ...(plan.weapon === 'sword' ? ['legion_sword'] : [])] : [];
  const neededGear = frame ? [...Object.values(frame.bodies[wardrobe]), ...selectedGear.filter(id => frame.gear[id]).map(id => frame.gear[id].asset)] : [];
  const heads = new Map(); const gear = new Map();
  await Promise.all([
    ...[...new Set(neededHead.map(command => command.layer))].map(async id => { heads.set(id, await loadLayer(manifest.avatar.layers[id], palette)); }),
    ...[...new Set(neededGear)].map(async id => { gear.set(id, await loadLayer(manifest.equipment.assets[id], palette)); }),
  ]);
  function drawHead(command, target = output, delta = headShift) {
    const entry = manifest.avatar.layers[command.layer];
    if (entry.externalBodyPlaceholder) return;
    const x = command.x + delta[0], y = command.y + delta[1];
    const layer = heads.get(command.layer);
    // Native rear contour repair for the exact male short-swept east head.
    if (entry.source === 'Assets/Hair/male/short_swept/chibi/E_front.png') blit(target, layer, x, y + 22, [0, 20, Math.min(12, entry.width), Math.min(16, entry.height - 20)]);
    blit(target, layer, x, y);
  }
  function drawBody(part) {
    const id = frame.bodies[wardrobe][part];
    if (id) blit(output, gear.get(id), 0, 0);
  }
  function drawGear(part) {
    for (const item of selectedGear) {
      const entry = frame.gear[item];
      if (!entry || entry.pass !== part) continue;
      const image = gear.get(entry.asset);
      const placement = entry.placements?.[wardrobe] ?? entry;
      if (entry.registered) { blit(output, image, 0, 0); continue; }
      const angle = placement.angle * Math.PI / 180, cosine = Math.cos(angle), sine = Math.sin(angle);
      const [atlasX, atlasY] = image.rect;
      for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
        const dx = (x + .5 - placement.position[0]) / placement.scale, dy = (y + .5 - placement.position[1]) / placement.scale;
        const sx = Math.floor(entry.grip[0] + (placement.mirror ? -1 : 1) * (cosine * dx + sine * dy));
        const sy = Math.floor(entry.grip[1] - sine * dx + cosine * dy);
        if (sx >= 0 && sx < image.layerWidth && sy >= 0 && sy < image.layerHeight) over(output.pixels, (y * output.width + x) * 4, image.pixels, ((atlasY + sy) * image.width + atlasX + sx) * 4);
      }
      if (placement.handOcclusion) {
        const body = gear.get(frame.bodies[wardrobe].base);
        const [bx, by] = body.rect;
        const radius = output.width === 512 ? 7 : 2;
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
          const x = placement.position[0] + dx, y = placement.position[1] + dy;
          if (dx * dx + dy * dy <= radius * radius && x >= 0 && y >= 0 && x < output.width && y < output.height) over(output.pixels, (y * output.width + x) * 4, body.pixels, ((by + y) * body.width + bx + x) * 4);
        }
      }
    }
  }
  if (action === 'thumbnail') {
    source.commands.forEach(command => drawHead(command, output, [0, 0]));
    facialHair.forEach(command => drawHead(command, output, [0, 0]));
  } else if (frame.staticOrder) {
    for (const part of frame.staticOrder) {
      if (part.startsWith('head')) {
        const grouped = part === 'head';
        const target = grouped ? blank(output.width, output.height) : output;
        for (const command of source.commands) {
          const layer = manifest.avatar.layers[command.layer];
          if (layer.source.startsWith('Assets/Outfits/') || layer.source.startsWith('Assets/World/')) continue;
          if (layer.headDepth) { if (!grouped && part !== `head_${layer.headDepth}`) continue; }
          else {
            const hair = layer.source.startsWith('Assets/Hair/'), rear = hair && layer.source.endsWith('_rear.png');
            if (part === 'head_rear' && !rear || part === 'head_base' && hair || part === 'head_front' && (!hair || rear)) continue;
          }
          drawHead(command, target);
        }
        if (grouped || part === 'head_front') facialHair.forEach(command => drawHead(command, target, [0, 0]));
        if (grouped) composite(output, target);
      } else if (part === 'mainhand' || part === 'shield') drawGear(part);
      else drawBody(part);
    }
  } else {
    let rearGear = false, frontGear = false;
    for (const command of source.commands) {
      const path = manifest.avatar.layers[command.layer].source;
      if (bodySource(path)) {
        const part = bodyPart(path);
        if (part === 'base' && !rearGear) { drawGear('rear'); rearGear = true; }
        drawBody(part);
        if (part === 'front') { drawGear('front'); frontGear = true; }
      } else drawHead(command);
    }
    facialHair.forEach(command => drawHead(command, output, [0, 0]));
    if (!frontGear) drawGear('front');
    drawGear('head');
  }
  const swordPlacement = frame?.gear?.legion_sword?.placements?.[wardrobe] ?? frame?.gear?.legion_sword;
  return { ...output, pivot: action === 'portrait' ? [256, 640] : action === 'thumbnail' ? [256, 512] : action === 'battle_idle' ? [96, 152] : action === 'seated_idle' ? [96, 180] : [48, 120], sourceFacing: direction, wardrobe, nativeWeapon: action === 'battle_idle' && selectedGear.includes('legion_sword'), mainhandGrip: swordPlacement?.position ?? swordPlacement?.registration?.target ?? frame?.rightGrip ?? [71, 111], appearance: a, kind: action === 'battle_idle' ? 'battle' : action };
}

// Useful to compare exact browser pixels with an independent native renderer.
export async function composeAvatarPixels(appearance, kind = 'portrait', loadout = {}, config = {}) {
  await preloadAvatarAssets();
  return composePlan(requestPlan(appearance, kind, loadout, config));
}

// Reuse the exact linked identity on a separately authored, registered body rig.
// The original native compositor remains available for source-parity checks.
export async function composeAvatarHeadPixels(appearance, config = {}) {
  await preloadAvatarAssets();
  const plan = requestPlan(appearance, 'world', {}, { direction: config.direction ?? 'W' });
  const structure = manifest.avatar.structures[`${plan.a.body}/${plan.a.hairstyle}/${plan.a.eyeStyle}`];
  const source = frameFor(structure.sheets.idle.frames, plan.row, 0);
  const canvas = config.canvas ?? [192, 160];
  const headOrigin = config.headOrigin ?? [64, 36];
  if (canvas.length !== 2 || !canvas.every(value => Number.isInteger(value) && value > 0 && value <= 1024)
    || headOrigin.length !== 2 || !headOrigin.every(Number.isInteger)) throw new Error('Invalid clean head registration.');
  const output = blank(...canvas);
  const shift = [headOrigin[0] - source.headOrigin[0], headOrigin[1] - source.headOrigin[1]];
  const commands = source.commands.filter(command => {
    const layer = manifest.avatar.layers[command.layer];
    return !layer.externalBodyPlaceholder && !bodySource(layer.source);
  });
  const facialHair = beardCommands(plan, headOrigin);
  const palette = paletteIndices(plan.a);
  const layers = new Map();
  await Promise.all([...new Set([...commands, ...facialHair].map(command => command.layer))].map(async id => {
    layers.set(id, await loadLayer(manifest.avatar.layers[id], palette));
  }));
  for (const command of commands) blit(output, layers.get(command.layer), command.x + shift[0], command.y + shift[1]);
  for (const command of facialHair) blit(output, layers.get(command.layer), command.x, command.y);
  return { ...output, appearance: plan.a, sourceFacing: plan.direction, headOrigin };
}

export async function prepareAvatar(appearance, kind = 'portrait', loadout = {}, config = {}) {
  await preloadAvatarAssets();
  const plan = requestPlan(appearance, kind, loadout, config);
  const existing = renderCache.get(plan.key);
  if (existing) { renderCache.delete(plan.key); renderCache.set(plan.key, existing); return existing; }
  if (pendingRenders.has(plan.key)) return pendingRenders.get(plan.key);
  const pending = (async () => {
    const composed = await composePlan(plan);
    const png = await encodeAvatarPng(composed.width, composed.height, composed.pixels);
    const image = { ...composed, pixels: undefined, url: `data:image/png;base64,${toBase64(png)}` };
    renderCache.set(plan.key, image);
    while (renderCache.size > MAX_RENDERS) renderCache.delete(renderCache.keys().next().value);
    return image;
  })();
  pendingRenders.set(plan.key, pending);
  try { return await pending; } finally { pendingRenders.delete(plan.key); }
}

export function getAvatarImage(appearance, kind = 'portrait', loadout = {}, config = {}) {
  if (!manifest) return null;
  return renderCache.get(requestPlan(appearance, kind, loadout, config).key) ?? null;
}

export function renderAvatar(appearance, kind = 'portrait', loadout = {}, config = {}) {
  const image = getAvatarImage(appearance, kind, loadout, config);
  if (!image) return '<span class="linked-avatar-loading" role="status">Preparing character art…</span>';
  const a = image.appearance;
  const label = config.alt ?? `${a.body === 'female' ? 'Female' : 'Male'} gladiator with ${avatarChoices.hairstyle.find(item => item.id === a.hairstyle).label.toLowerCase()} hair`;
  return `<img class="linked-avatar linked-avatar--${escape(image.kind)}" src="${image.url}" width="${image.width}" height="${image.height}" alt="${escape(label)}" draggable="false">`;
}

export function getAvatarDiagnostics() {
  return { loaded: Boolean(manifest), loadedLayerTextures: layerCache.size, decodedLayerBytes: layerBytes, renderedAvatars: renderCache.size, pendingRenders: pendingRenders.size };
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
const crc32 = bytes => { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; };
const read32 = (bytes, index) => (bytes[index] * 0x1000000 + (bytes[index + 1] << 16) + (bytes[index + 2] << 8) + bytes[index + 3]) >>> 0;
const write32 = (bytes, index, value) => { bytes[index] = value >>> 24; bytes[index + 1] = value >>> 16; bytes[index + 2] = value >>> 8; bytes[index + 3] = value; };
const concat = arrays => { const out = new Uint8Array(arrays.reduce((sum, bytes) => sum + bytes.length, 0)); let offset = 0; arrays.forEach(bytes => { out.set(bytes, offset); offset += bytes.length; }); return out; };
const paeth = (a, b, c) => { const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c); return da <= db && da <= dc ? a : db <= dc ? b : c; };

async function transformBytes(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

// The exporter writes only RGBA8, noninterlaced PNGs. A small exact decoder
// avoids the browser Canvas color / alpha conversion at transparent edges.
export async function decodeAvatarPng(bytes) {
  if (bytes.length < 33 || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte)) throw new Error('Avatar layer is not a PNG.');
  let width, height; const data = []; let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = read32(bytes, offset), end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Avatar PNG is truncated.');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== read32(bytes, offset + 8 + length)) throw new Error('Avatar PNG failed its pixel integrity check.');
    if (type === 'IHDR') {
      width = read32(bytes, offset + 8); height = read32(bytes, offset + 12);
      if (length !== 13 || !width || !height || width * height > 16 * 1024 * 1024 || bytes[offset + 16] !== 8 || bytes[offset + 17] !== 6 || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) throw new Error('Avatar PNG has an unsupported format.');
    } else if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    else if (type === 'IEND') { ended = true; break; }
    offset = end;
  }
  if (!width || !ended || !data.length) throw new Error('Avatar PNG has no complete pixel stream.');
  const raw = await transformBytes(concat(data), new DecompressionStream('deflate'));
  const stride = width * 4;
  if (raw.length !== height * (stride + 1)) throw new Error('Avatar PNG pixel dimensions do not match.');
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('Avatar PNG filter is invalid.');
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 4 ? pixels[index - 4] : 0, above = y ? pixels[index - stride] : 0, diagonal = y && x >= 4 ? pixels[index - stride - 4] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, diagonal) : 0;
      pixels[index] = raw[y * (stride + 1) + x + 1] + predictor;
    }
  }
  return { width, height, pixels };
}

function pngChunk(type, data) {
  const out = new Uint8Array(data.length + 12);
  write32(out, 0, data.length);
  out.set([...type].map(char => char.charCodeAt(0)), 4); out.set(data, 8);
  write32(out, data.length + 8, crc32(out.subarray(4, data.length + 8)));
  return out;
}

export async function encodeAvatarPng(width, height, pixels) {
  const header = new Uint8Array(13); write32(header, 0, width); write32(header, 4, height); header[8] = 8; header[9] = 6;
  const stride = width * 4, rows = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const compressed = await transformBytes(rows, new CompressionStream('deflate'));
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())]);
}

function toBase64(bytes) {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(result);
}
