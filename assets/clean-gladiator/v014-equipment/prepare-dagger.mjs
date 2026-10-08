import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodeAvatarPng } from '../../../src/avatar.js';

const directory = new URL('./', import.meta.url);
const sourceUrl = new URL('dagger.source.json', directory);
const sourceBytes = await fs.readFile(sourceUrl);
const source = JSON.parse(sourceBytes);
const [width, height] = source.canvas;
const pixels = new Uint8Array(width * height * 4), occupied = new Set();
const rectangles = [];
for (const row of source.rows) for (const [offset, code] of [...row.cells].entries()) {
  const x = row.x + offset, y = row.y, index = y * width + x;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height || occupied.has(index)) throw new Error('Authored cells must be unique integer canvas coordinates.');
  const entry = source.palette[code];
  if (!entry || entry.rgba.length !== 4 || entry.rgba[3] !== 255) throw new Error('Authored palette must own an opaque RGBA material.');
  occupied.add(index); pixels.set(entry.rgba, index * 4);
  const color = `#${entry.rgba.slice(0, 3).map(value => value.toString(16).padStart(2, '0')).join('')}`;
  rectangles.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`);
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">${rectangles.join('')}</svg>\n`;
const png = await encodeAvatarPng(width, height, pixels);
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entry = { url: '/assets/clean-gladiator/v014-equipment/weapons/dagger.png', width, height, grip: source.grip, sourceFacing: 'W' };
const manifest = {
  schema: 'last-laurel.arena-equipment.v1', revision: 'dagger-v001',
  compatibleIdentityCatalogs: ['v006', 'v013'], weapons: { dagger: entry },
  provenance: source.provenance,
};
const receipt = {
  schema: 'arena-dagger-preparation-v1', source: 'dagger.source.json', sourceSvg: 'dagger.source.svg',
  sourceSha256: sha256(sourceBytes), sourceSvgSha256: sha256(svg), textureSha256: sha256(png),
  authoredCanvas: source.canvas, grip: source.grip, opaqueCells: occupied.size,
  operations: ['Map authored integer cells to exact RGBA samples', 'Emit matching integer-cell SVG source', 'Encode lossless RGBA PNG without resampling'],
  preserved: ['All existing v003 weapon/body/hand assets', 'Exact v006 legacy identity dispatch', 'Exact v013 preset identity dispatch', 'All armor/head/helmet transforms'],
  evidence: 'Source preparation and registration only; assembled browser review and human art judgment are separate.',
};
async function writeNewOrIdentical(relative, bytes) {
  const destination = new URL(relative, directory);
  try { const old = await fs.readFile(destination); if (!old.equals(Buffer.from(bytes))) throw new Error(`Refusing to replace different preserved asset: ${relative}`); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(new URL('./', destination), { recursive: true });
  await fs.writeFile(destination, bytes, { flag: 'wx' });
}
await writeNewOrIdentical('dagger.source.svg', svg);
await writeNewOrIdentical('weapons/dagger.png', png);
await writeNewOrIdentical('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
await writeNewOrIdentical('PREPARATION_RECEIPT.json', `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ texture: fileURLToPath(new URL('weapons/dagger.png', directory)), width, height, grip: source.grip, opaqueCells: occupied.size, textureSha256: receipt.textureSha256 }));
