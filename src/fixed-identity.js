// Registered hair is layered over one preserved skull/face per sex. Sources
// remain untouched; semantic ownership is established before recoloring.
import { avatarChoices, normalizeAppearance, decodeAvatarPng } from './avatar.js';
import { preloadDarkIdentity, recolorDarkIdentityPixels } from './dark-identity.js';

const WIDTH = 192, HEIGHT = 160, AREA = WIDTH * HEIGHT;
const DEFAULT_RIG = Object.freeze({ scale: .84, sourceAnchor: [96, 86], targetAnchor: [93, 86] });
const HAIR_REGISTRATION = Object.freeze({
  male: Object.freeze({ none: [0, 0], shag: [0, 0], short_swept: [0, 0], cropped: [0, 0], braided_ponytail: [0, 0], high_ponytail: [0, 0], center_part_medium: [0, 0], swept_back_undercut: [0, 0], shoulder_length_loose: [0, 0] }),
  female: Object.freeze({ none: [0, 0], shag: [0, 0], short_swept: [0, 0], cropped: [0, 0], braided_ponytail: [0, 0], high_ponytail: [0, 0], center_part_medium: [0, 0], swept_back_undercut: [0, 0], shoulder_length_loose: [0, 0] }),
});
// Each source already has its chin registered at [96,86]. The recorded hair
// registrations deliberately preserve that origin instead of centering a trim.
const sourceCache = new Map(), sourcePending = new Map(), layerCache = new Map(), canonicalCache = new Map();
const point = (x, y) => y * WIDTH + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT;
const blank = () => ({ width: WIDTH, height: HEIGHT, pixels: new Uint8Array(AREA * 4), materials: new Uint8Array(AREA) });

function material(r, g, b, a) {
  if (a < 80) return 0;
  if (g > r + 12 && b > r + 6 && g > b && Math.max(r, g, b) > 48) return 3;
  if (r > g + 8 && g >= b + 5 && Math.max(r, g, b) > 65) return 1;
  if (b >= r + 4 && b >= g - 12 && Math.max(r, g, b) > 48) return 2;
  return 0;
}

function dominant(image) {
  const visited = new Uint8Array(AREA); let largest = [];
  for (let start = 0; start < AREA; start++) {
    if (visited[start] || image.pixels[start * 4 + 3] < 80) continue;
    const component = [], queue = [start]; visited[start] = 1;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const p = queue[cursor], x = p % WIDTH, y = Math.floor(p / WIDTH); component.push(p);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || !inside(x + dx, y + dy)) continue;
        const q = point(x + dx, y + dy);
        if (!visited[q] && image.pixels[q * 4 + 3] >= 80) { visited[q] = 1; queue.push(q); }
      }
    }
    if (component.length > largest.length) largest = component;
  }
  const output = blank();
  for (const p of largest) {
    output.pixels.set(image.pixels.subarray(p * 4, p * 4 + 4), p * 4);
    output.materials[p] = image.materials?.[p] ?? material(...image.pixels.subarray(p * 4, p * 4 + 4));
  }
  return output;
}

async function source(entry, facialHair = false) {
  const key = `${entry.url}|${facialHair ? 'facial-hair' : 'head'}`;
  if (sourceCache.has(key)) return sourceCache.get(key);
  if (sourcePending.has(key)) return sourcePending.get(key);
  const work = (async () => {
    const url = new URL(entry.url, globalThis.location?.href ?? 'http://127.0.0.1:4173/');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Registered identity source could not load (${response.status}).`);
    const decoded = await decodeAvatarPng(new Uint8Array(await response.arrayBuffer()));
    if (decoded.width !== WIDTH || decoded.height !== HEIGHT) throw new Error('Registered identity source must preserve its 192×160 canvas.');
    // Facial hair intentionally has separate moustache, goatee and stubble
    // clusters. They join the opaque face on assembly; do not discard them as
    // if they were atlas debris outside a complete head.
    const cleaned = facialHair ? blank() : dominant(decoded);
    if (facialHair) for (let p = 0; p < AREA; p++) if (decoded.pixels[p * 4 + 3] >= 80) {
      cleaned.pixels.set(decoded.pixels.subarray(p * 4, p * 4 + 4), p * 4);
      cleaned.materials[p] = material(...decoded.pixels.subarray(p * 4, p * 4 + 4));
    }
    sourceCache.set(key, cleaned);
    while (sourceCache.size > 24) sourceCache.delete(sourceCache.keys().next().value);
    return cleaned;
  })();
  sourcePending.set(key, work);
  try { return await work; } finally { sourcePending.delete(key); }
}

function semanticMask(image) {
  const pixels = new Uint8Array(AREA * 4);
  for (let p = 0; p < AREA; p++) if (image.materials[p]) {
    pixels[p * 4 + image.materials[p] - 1] = 255; pixels[p * 4 + 3] = 255;
  }
  return { width: WIDTH, height: HEIGHT, pixels };
}

function recolor(image, appearance, entry) {
  const a = normalizeAppearance(appearance);
  const output = recolorDarkIdentityPixels(image, a, entry, semanticMask(image));
  const targetHex = avatarChoices.hairColor.find(option => option.id === a.hairColor).color;
  const baseHex = entry.materialDefaults?.hair ?? '#626e83';
  const color = hex => [1, 3, 5].map(start => Number.parseInt(hex.slice(start, start + 2), 16));
  const target = color(targetHex), reference = color(baseHex);
  const value = rgb => rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  const referenceValue = Math.max(1, value(reference));
  for (let p = 0; p < AREA; p++) if (image.materials[p] === 2) {
    const offset = p * 4, x = p % WIDTH, y = Math.floor(p / WIDTH);
    // Hair highlights stay within the selected material's hue and a restrained
    // value range, instead of pulling its brightest shades toward white.
    const shade = Math.min(1.3, value(image.pixels.subarray(offset, offset + 3)) / referenceValue);
    const shaded = target.map(channel => Math.round(Math.min(255, channel * shade)));
    const eye = entry.eyeBounds;
    const intenseBrow = a.eyeStyle === 'sharp' && eye && x >= eye[0] && y >= eye[1] && x < eye[2] && y < eye[3] && value(shaded) < 110;
    for (let channel = 0; channel < 3; channel++) output.pixels[offset + channel] = Math.round(shaded[channel] * (intenseBrow ? .72 : 1));
  }
  return { ...output, materials: image.materials };
}

const FEATURE_REGIONS = Object.freeze({ brow: [86, 69, 97, 73], nose: [81, 72, 88, 79], mouth: [86, 80, 100, 85] });
const FEATURE_LANDMARKS = Object.freeze({ brow: [[91, 70]], nose: [[85, 75]], mouth: [[85, 80]], jaw: [[96, 83], [97, 83], [86, 82]] });
const FEMALE_FEATURE_LANDMARKS = Object.freeze({ mouth: [[86, 80], [87, 81]], jaw: [[95, 82], [96, 82], [97, 81]] });
const FRONT_MOUTH_SOURCE = Object.freeze({ male: [85, 80], female: [86, 80] });
// Iris and sclera can round into the same smaller pixel. Record a disjoint,
// registered eye cluster rather than allowing the iris repair to erase white.
const EYE_WHITE_LANDMARKS = Object.freeze({ male: [{ source: [93, 72], offset: [1, 0] }], female: [{ source: [94, 70], offset: [0, 0] }, { source: [93, 71], offset: [1, 0] }] });
const inRegion = (x, y, region) => x >= region[0] && y >= region[1] && x < region[2] && y < region[3];

async function foundation(sex, catalog) {
  if (canonicalCache.has(sex)) return canonicalCache.get(sex);
  const scalpEntry = catalog.identities[sex].none.chibi, scalp = await source(scalpEntry);
  const faceEntry = sex === 'male' ? catalog.identities.male.shag.chibi : scalpEntry;
  const faceStart = sex === 'male' ? 68 : faceEntry.eyeBounds[1];
  const output = { ...scalp, pixels: scalp.pixels.slice(), materials: scalp.materials.slice() };
  if (sex === 'male') {
    const face = await source(faceEntry);
    // The reference's male face is the detailed Tousled source. Its upper bald
    // scalp remains a separate fixed foundation; no old lower jaw is layered
    // behind the recovered face, and no hairstyle selects a different face.
    for (let p = faceStart * WIDTH; p < AREA; p++) { output.pixels.fill(0, p * 4, p * 4 + 4); output.materials[p] = 0; }
    for (let y = faceStart; y < HEIGHT; y++) {
      const warm = [];
      for (let x = 0; x < WIDTH; x++) if ([1, 3].includes(face.materials[point(x, y)])) warm.push(x);
      if (!warm.length) continue;
      const left = Math.min(...warm), right = Math.max(...warm);
      for (let x = 0; x < WIDTH; x++) {
        const p = point(x, y), rgba = face.pixels.subarray(p * 4, p * 4 + 4), owner = face.materials[p];
        if (rgba[3] < 80) continue;
        let selected = owner === 1 || owner === 3;
        const brow = inRegion(x, y, FEATURE_REGIONS.brow);
        if (owner === 2 && brow) selected = true;
        if (owner === 0) {
          const feature = Object.values(FEATURE_REGIONS).some(region => inRegion(x, y, region));
          let border = false;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inside(x + dx, y + dy) && [1, 3].includes(face.materials[point(x + dx, y + dy)])) border = true;
          // Neutral bright sclera and other fixed face colors are valid face
          // pixels too. A darkness cutoff here used to discard the eye white.
          selected = feature || (x >= left && x <= right) || (border && Math.max(...rgba.subarray(0, 3)) <= 70);
        }
        if (selected) {
          output.pixels.set(rgba, p * 4); output.materials[p] = owner;
        } else if (owner === 2 && x >= left && x <= right) {
          // A source sideburn inside the ear/temple envelope becomes fixed
          // skull skin, using an existing nearby skin shade rather than leaving
          // a hollow temple or permanent hair on the Bald selection.
          let nearest = -1, distance = Infinity;
          for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (inside(x + dx, y + dy)) {
            const q = point(x + dx, y + dy), d = dx * dx + dy * dy;
            if (face.materials[q] === 1 && d < distance) { nearest = q; distance = d; }
          }
          if (nearest >= 0) { output.pixels.set(face.pixels.subarray(nearest * 4, nearest * 4 + 4), p * 4); output.materials[p] = 1; }
        }
      }
    }
    // The generated Tousled head has hair covering the rear temple. That strip
    // is skull skin on the Bald option, not a straight dark facial splice.
    // Restore the registered bald scalp there; keep the recovered brow, ear,
    // cheeks, jaw and neck from the single detailed face below/forward of it.
    for (let y = 68; y < 73; y++) for (let x = 98; x < 110; x++) {
      const p = point(x, y); if (scalp.pixels[p * 4 + 3] < 80) continue;
      output.pixels.set(scalp.pixels.subarray(p * 4, p * 4 + 4), p * 4); output.materials[p] = scalp.materials[p];
    }
  }
  const cleaned = dominant(output), protectedFaceMask = new Uint8Array(AREA);
  for (let p = faceStart * WIDTH; p < AREA; p++) if (cleaned.pixels[p * 4 + 3] >= 80) protectedFaceMask[p] = 1;
  const result = { ...cleaned, protectedFaceMask, entry: faceEntry, scalpEntry, faceStart };
  canonicalCache.set(sex, result); return result;
}

function hairLayer(image, canonical, entry, registration) {
  const key = `${entry.url}|${registration.join(',')}`;
  if (layerCache.has(key)) return layerCache.get(key);
  const output = blank(), selected = new Uint8Array(AREA), queue = [];
  // Iris and warm facial pixels cannot enter a hair layer. Ink may join a hair
  // seed only within one source pixel; it cannot crawl across a brow or jaw.
  for (let p = 0; p < AREA; p++) if (image.materials[p] === 2) { selected[p] = 1; queue.push(p); }
  for (const p of queue) {
    const x = p % WIDTH, y = Math.floor(p / WIDTH);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!inside(x + dx, y + dy)) continue;
      const q = point(x + dx, y + dy), offset = q * 4;
      if (image.pixels[offset + 3] >= 80 && image.materials[q] === 0 && Math.max(...image.pixels.subarray(offset, offset + 3)) <= 70) selected[q] = 1;
    }
  }
  for (let p = 0; p < AREA; p++) {
    if (!selected[p]) continue;
    const x = p % WIDTH + registration[0], y = Math.floor(p / WIDTH) + registration[1];
    if (!inside(x, y)) continue;
    const q = point(x, y);
    // The complete authored face below the brow is protected, including both
    // eyes, ear, cheek, jaw and the anatomical garment join.
    if (canonical.protectedFaceMask[q]) continue;
    output.pixels.set(image.pixels.subarray(p * 4, p * 4 + 4), q * 4);
    output.materials[q] = image.materials[p] === 2 ? 2 : 0;
  }
  // A generated warm fleck inside a hair cap is not facial skin. Determine
  // enclosed cap ownership geometrically before any palette is applied, and
  // fill only those holes with nearby existing cool hair pixels. Open forehead
  // and part/hairline regions remain connected to the exterior and untouched.
  const exterior = new Uint8Array(AREA), empty = [];
  const visit = p => {
    if (!exterior[p] && output.pixels[p * 4 + 3] < 80) { exterior[p] = 1; empty.push(p); }
  };
  for (let x = 0; x < WIDTH; x++) { visit(point(x, 0)); visit(point(x, HEIGHT - 1)); }
  for (let y = 0; y < HEIGHT; y++) { visit(point(0, y)); visit(point(WIDTH - 1, y)); }
  for (let cursor = 0; cursor < empty.length; cursor++) {
    const p = empty[cursor], x = p % WIDTH, y = Math.floor(p / WIDTH);
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) if (inside(x + dx, y + dy)) visit(point(x + dx, y + dy));
  }
  const capHoles = [];
  for (let p = 0; p < AREA; p++) if (!exterior[p] && !output.pixels[p * 4 + 3]
    && !canonical.protectedFaceMask[p] && canonical.pixels[p * 4 + 3] >= 80) capHoles.push(p);
  for (const p of capHoles) {
    const x = p % WIDTH, y = Math.floor(p / WIDTH); let nearest = -1, distance = Infinity;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (!inside(x + dx, y + dy)) continue;
      const q = point(x + dx, y + dy), d = dx * dx + dy * dy;
      if (output.materials[q] === 2 && d < distance) { nearest = q; distance = d; }
    }
    if (nearest >= 0) { output.pixels.set(output.pixels.subarray(nearest * 4, nearest * 4 + 4), p * 4); output.materials[p] = 2; }
  }
  layerCache.set(key, output); while (layerCache.size > 24) layerCache.delete(layerCache.keys().next().value);
  return output;
}

function lay(target, image, selection) {
  for (let p = 0; p < AREA; p++) {
    if (image.pixels[p * 4 + 3] < 80 || (selection && !selection[p])) continue;
    target.pixels.set(image.pixels.subarray(p * 4, p * 4 + 4), p * 4);
    target.materials[p] = image.materials[p];
  }
}

function sample(image, rig, faceMask) {
  const output = blank(); output.protectedFaceMask = new Uint8Array(AREA);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    const sx = Math.floor(rig.sourceAnchor[0] + (x + .5 - rig.targetAnchor[0]) / rig.scale);
    const sy = Math.floor(rig.sourceAnchor[1] + (y + .5 - rig.targetAnchor[1]) / rig.scale);
    if (!inside(sx, sy)) continue;
    const p = point(x, y), s = point(sx, sy);
    output.pixels.set(image.pixels.subarray(s * 4, s * 4 + 4), p * 4);
    output.materials[p] = image.materials[s]; output.protectedFaceMask[p] = faceMask[s];
  }
  return output;
}

function validRig(value) {
  const rig = value ?? DEFAULT_RIG;
  if (!Number.isFinite(rig.scale) || rig.scale < .5 || rig.scale > 1
    || [rig.sourceAnchor, rig.targetAnchor].some(p => !Array.isArray(p) || p.length !== 2 || p.some((v, axis) => !Number.isFinite(v) || v < 0 || v >= [WIDTH, HEIGHT][axis]))) throw new Error('Registered identity neck transform is invalid.');
  return rig;
}

export async function composeFixedIdentityPixels(appearance, registration = DEFAULT_RIG) {
  const a = normalizeAppearance(appearance), rig = validRig(registration), catalog = await preloadDarkIdentity();
  const raw = await foundation(a.sex, catalog), entry = raw.entry, base = recolor(raw, a, entry);
  const eyeTop = entry.irisBounds[1], browTop = raw.faceStart, protectedFaceMask = raw.protectedFaceMask;
  const canonical = { ...raw, protectedFaceMask }, assembled = blank(); lay(assembled, base);
  if (a.hairstyle !== 'none') {
    const hairEntry = catalog.identities[a.sex][a.hairstyle].chibi;
    const hair = hairLayer(await source(hairEntry), canonical, hairEntry, HAIR_REGISTRATION[a.sex][a.hairstyle]);
    lay(assembled, recolor(hair, a, hairEntry));
  }
  lay(assembled, base, protectedFaceMask);
  const beardEntry = a.sex === 'male' && a.beard !== 'none' ? catalog.beards[a.beard]?.chibi : null;
  if (beardEntry) {
    const beard = await source(beardEntry, true), overlay = { ...beard, materials: beard.materials.slice() };
    for (let p = 0; p < AREA; p++) {
      const y = Math.floor(p / WIDTH);
      if (y < eyeTop + 3) { overlay.pixels = overlay.pixels === beard.pixels ? beard.pixels.slice() : overlay.pixels; overlay.pixels[p * 4 + 3] = 0; }
      else if (overlay.materials[p] !== 0) overlay.materials[p] = 2;
    }
    lay(assembled, recolor(overlay, a, beardEntry));
  }
  const fitted = sample(assembled, rig, protectedFaceMask), irisLandmarks = [], featureLandmarks = {};
  for (const [name, points] of Object.entries(a.sex === 'male' ? FEATURE_LANDMARKS : FEMALE_FEATURE_LANDMARKS)) {
    featureLandmarks[name] = [];
    for (const [sx, sy] of points) {
      const x = Math.round(rig.targetAnchor[0] + (sx + .5 - rig.sourceAnchor[0]) * rig.scale - .5);
      const y = Math.round(rig.targetAnchor[1] + (sy + .5 - rig.sourceAnchor[1]) * rig.scale - .5);
      const p = point(sx, sy), q = point(x, y);
      if (!inside(x, y) || !fitted.protectedFaceMask[q]) continue;
      // Retain an authored one-pixel feature that the smaller nearest sample
      // can omit. Copy source ink; do not draw generic facial details or scale
      // the skull up. Facial hair still owns its mouth/jaw occlusion.
      if (!beardEntry || name === 'brow' || name === 'nose') {
        fitted.pixels.set(base.pixels.subarray(p * 4, p * 4 + 4), q * 4); fitted.materials[q] = raw.materials[p];
      }
      featureLandmarks[name].push({ source: [sx, sy], target: [x, y] });
    }
  }
  const frontMouth = [];
  if (!beardEntry) {
    const [sx, sy] = FRONT_MOUTH_SOURCE[a.sex];
    const x = Math.round(rig.targetAnchor[0] + (sx + .5 - rig.sourceAnchor[0]) * rig.scale - .5);
    const y = Math.round(rig.targetAnchor[1] + (sy + .5 - rig.sourceAnchor[1]) * rig.scale - .5);
    // At this final scale the source profile lip is one edge pixel. Keep its
    // genuine ink as a two-pixel closed line extending inward, so the mouth
    // reads separately from the head outline without enlarging the face.
    for (let dx = 0; dx < 2; dx++) {
      if (!inside(x + dx, y)) continue;
      const p = point(sx, sy), q = point(x + dx, y);
      if (!fitted.protectedFaceMask[q]) continue;
      fitted.pixels.set(base.pixels.subarray(p * 4, p * 4 + 4), q * 4); fitted.materials[q] = raw.materials[p];
      frontMouth.push({ source: [sx, sy], target: [x + dx, y] });
    }
  }
  // Preserve canonical iris landmarks explicitly. Nearest sampling at 0.84
  // otherwise misses both source iris pixels on the female bald foundation.
  for (let p = 0; p < AREA; p++) if (raw.materials[p] === 3) {
    const x = Math.round(rig.targetAnchor[0] + (p % WIDTH + .5 - rig.sourceAnchor[0]) * rig.scale - .5);
    const y = Math.round(rig.targetAnchor[1] + (Math.floor(p / WIDTH) + .5 - rig.sourceAnchor[1]) * rig.scale - .5);
    if (!inside(x, y)) continue;
    const q = point(x, y); fitted.pixels.set(base.pixels.subarray(p * 4, p * 4 + 4), q * 4); fitted.materials[q] = 3; fitted.protectedFaceMask[q] = 1;
    if (!irisLandmarks.some(v => v[0] === x && v[1] === y)) irisLandmarks.push([x, y]);
  }
  const eyeWhites = [];
  for (const landmark of EYE_WHITE_LANDMARKS[a.sex]) {
    const [sx, sy] = landmark.source;
    const x = Math.round(rig.targetAnchor[0] + (sx + .5 - rig.sourceAnchor[0]) * rig.scale - .5) + landmark.offset[0];
    const y = Math.round(rig.targetAnchor[1] + (sy + .5 - rig.sourceAnchor[1]) * rig.scale - .5) + landmark.offset[1];
    if (!inside(x, y) || irisLandmarks.some(p => p[0] === x && p[1] === y)) continue;
    const p = point(sx, sy), q = point(x, y);
    fitted.pixels.set(raw.pixels.subarray(p * 4, p * 4 + 4), q * 4); fitted.materials[q] = 0; fitted.protectedFaceMask[q] = 1;
    eyeWhites.push({ source: [sx, sy], target: [x, y] });
  }
  const cleaned = dominant(fitted);
  for (let p = 0; p < AREA; p++) if (!cleaned.pixels[p * 4 + 3]) fitted.protectedFaceMask[p] = 0;
  return {
    ...cleaned, protectedFaceMask: fitted.protectedFaceMask, irisLandmarks,
    appearance: a, anchor: [...rig.targetAnchor], sourceFacing: 'W', kind: 'chibi', expression: 'solemn', facialHairAvailable: true,
    registration: { scale: rig.scale, sourceAnchor: [...rig.sourceAnchor], targetAnchor: [...rig.targetAnchor] },
    canonicalFace: { sourceUrl: entry.url, scalpSourceUrl: raw.scalpEntry.url, faceStart: raw.faceStart, eyeTop, browTop, featureLandmarks, eyeWhites, frontMouth }, alreadyFitted: true,
  };
}

export function getFixedIdentityDiagnostics() {
  return { sourceTextures: sourceCache.size, pendingSources: sourcePending.size, registeredHairLayers: layerCache.size, styleVersion: 'fixed-identity-v1' };
}
