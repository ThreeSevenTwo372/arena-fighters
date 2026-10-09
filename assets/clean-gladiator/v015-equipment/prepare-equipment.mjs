import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { encodeAvatarPng } from '../../../src/avatar.js';

// Original pixel cells, authored at final size. No generated source, scaling,
// recoloring, classification, or alterations to preserved identity packages.
const directory = new URL('./', import.meta.url);
const palette = {
  i: { rgba: [35, 27, 22, 255], material: 'fixed outline' },
  s: { rgba: [82, 78, 67, 255], material: 'steel shadow' },
  m: { rgba: [153, 153, 136, 255], material: 'steel body' },
  h: { rgba: [208, 207, 182, 255], material: 'steel bevel' },
  b: { rgba: [237, 226, 194, 255], material: 'edge highlight' },
  c: { rgba: [101, 68, 34, 255], material: 'bronze shadow' },
  g: { rgba: [164, 122, 62, 255], material: 'bronze body' },
  l: { rgba: [213, 174, 102, 255], material: 'bronze highlight' },
  r: { rgba: [67, 43, 28, 255], material: 'wood and cord shadow' },
  t: { rgba: [121, 85, 48, 255], material: 'wood and cord body' },
  n: { rgba: [183, 146, 93, 255], material: 'net cord highlight' },
};
const provenance = { type: 'original hand-authored vector pixel artwork', providerCalls: 0, imageEdits: 0,
  direction: 'Three steel tines on a wrapped wooden shaft, bronze collars; weighted knotted cord net held at the existing offhand socket.',
  license: 'Project-specific original artwork; no third-party source or new public-domain claim.' };
function canvas(name, width, height, grip) {
  const cells = new Map();
  const put = (x, y, material) => {
    if (x < 0 || x >= width || y < 0 || y >= height || !palette[material]) throw new Error('Invalid authored integer cell.');
    cells.set(`${x},${y}`, material);
  };
  const row = (y, x, materials) => [...materials].forEach((code, offset) => put(x + offset, y, code));
  const line = (x1, y1, x2, y2, code) => {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
    for (let step = 0; step <= steps; step++) put(Math.round(x1 + (x2 - x1) * step / Math.max(1, steps)), Math.round(y1 + (y2 - y1) * step / Math.max(1, steps)), code);
  };
  return { put, row, line, source: () => ({ schema: 'arena-authored-pixel-source-v1', name, canvas: [width, height], grip,
    palette, cells: [...cells].map(([coordinate, material]) => ({ position: coordinate.split(',').map(Number), material })), provenance }) };
}
const trident = canvas('Retiarius trident', 26, 92, [12, 64]);
// Three individually outlined pointed tines share a strong connected crossbar.
for (const [center, tip] of [[4, 5], [12, 0], [20, 5]]) {
  trident.put(center, tip, 'i');
  for (let y = tip + 1; y < 24; y++) trident.row(y, center - 1, y === tip + 1 ? 'ihi' : 'ibmsi');
}
for (let y = 22; y <= 27; y++) trident.row(y, 3, y === 22 || y === 27 ? 'iiiiiiiiiiiiiiiiiiiii' : y === 23 ? 'ibhhhhhhhhhhhhhhhhmsi' : 'ihmmmmmmmmmmmmmmmssmi');
for (let y = 28; y < 89; y++) trident.row(y, 10, y % 6 === 0 && y > 56 ? 'irttri' : 'itntri');
for (const y of [28, 29, 30, 53, 54]) trident.row(y, 9, y % 2 ? 'icglggci' : 'iglgggci');
trident.row(89, 9, 'icggggci'); trident.row(90, 10, 'icggci'); trident.row(91, 11, 'iiii');
const net = canvas('Weighted knotted net', 38, 42, [5, 4]);
// Cord from the exact offhand grip to a hanging net, with open diamond weave.
net.line(5, 0, 5, 12, 'r'); net.line(6, 0, 6, 12, 'n');
const boundary = [[5, 10], [22, 8], [35, 20], [28, 37], [10, 39], [2, 25], [5, 10]];
for (let index = 1; index < boundary.length; index++) net.line(...boundary[index - 1], ...boundary[index], 'r');
for (let y = 10; y <= 38; y++) for (let x = 3; x <= 34; x++) {
  const inside = x >= (y < 25 ? 5 - (y - 10) / 5 : 2 + (y - 25) * 8 / 14)
    && x <= (y < 20 ? 22 + (y - 8) * 13 / 12 : 35 - (y - 20) * 7 / 17);
  if (inside && ((x + y) % 7 === 0 || (x - y + 70) % 7 === 0)) net.put(x, y, (x + y) % 7 === 0 ? 'n' : 't');
}
for (const [x, y] of [[10, 39], [19, 38], [28, 37]]) { net.row(y, x - 1, 'igi'); if (y + 1 < 42) net.row(y + 1, x - 1, 'ici'); }
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function writeNewOrIdentical(relative, bytes) {
  const target = new URL(relative, directory), content = Buffer.from(bytes);
  try { const old = await fs.readFile(target); if (!old.equals(content)) throw new Error(`Preserved asset differs: ${relative}`); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(new URL('./', target), { recursive: true }); await fs.writeFile(target, content, { flag: 'wx' });
}
const textures = {}, receipts = [];
for (const [id, source] of [['trident', trident.source()], ['net', net.source()]]) {
  const [width, height] = source.canvas, pixels = new Uint8Array(width * height * 4), rectangles = [];
  for (const { position: [x, y], material } of source.cells) {
    const rgba = source.palette[material].rgba; pixels.set(rgba, (y * width + x) * 4);
    rectangles.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#${rgba.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}"/>`);
  }
  const sourceText = `${JSON.stringify(source, null, 2)}\n`, svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${rectangles.join('')}</svg>\n`;
  const png = await encodeAvatarPng(width, height, pixels);
  await writeNewOrIdentical(`${id}.source.json`, sourceText); await writeNewOrIdentical(`${id}.source.svg`, svg); await writeNewOrIdentical(`weapons/${id}.png`, png);
  textures[id] = { url: `/assets/clean-gladiator/v015-equipment/weapons/${id}.png`, width, height, grip: source.grip, sourceFacing: 'W' };
  receipts.push({ id, sourceSha256: hash(sourceText), sourceSvgSha256: hash(svg), textureSha256: hash(png), canvas: source.canvas, grip: source.grip, authoredCells: source.cells.length });
}
const previous = JSON.parse(await fs.readFile(new URL('../v014-equipment/manifest.json', directory)));
await writeNewOrIdentical('manifest.json', `${JSON.stringify({ schema: previous.schema, revision: 'trident-net-v001', compatibleIdentityCatalogs: previous.compatibleIdentityCatalogs,
  weapons: { ...previous.weapons, trident: { ...textures.trident, offhand: textures.net } }, provenance }, null, 2)}\n`);
await writeNewOrIdentical('PREPARATION_RECEIPT.json', `${JSON.stringify({ schema: 'arena-trident-net-preparation-v1', textures: receipts,
  operations: ['Author exact native integer cells with explicit fixed material ownership', 'Emit editable matching SVG and source JSON', 'Encode lossless RGBA without resampling'],
  placement: 'Preserved body.mainhandGrip and outward weapon angle; net uses preserved body.offhandGrip, replacing decorative shield only for trident.',
  preserved: ['Every existing identity, body, hand, head, helmet and weapon file', 'Exact v014 dagger manifest entry'],
  evidence: 'Preparation only. Whole-figure rendering, browser checks and user art acceptance are separate.' }, null, 2)}\n`);
console.log(JSON.stringify(receipts));
