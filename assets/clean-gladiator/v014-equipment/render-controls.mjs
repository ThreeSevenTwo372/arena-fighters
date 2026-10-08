import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { normalizePresetAppearance } from '../../../src/face-presets.js';
import { preloadCleanArt, prepareCleanAvatar, renderCleanAvatar } from '../../../src/current-avatar.js';

const project = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const destination = path.join(project, 'artifacts/Weapon_Dagger_v001');
const require = createRequire(process.env.ARENA_NODE_RUNTIME ?? 'C:/Users/santa/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const sharp = require('sharp');
globalThis.fetch = async input => {
  const url = new URL(input), target = path.resolve(project, `.${decodeURIComponent(url.pathname)}`);
  if (url.origin !== 'http://127.0.0.1:4173' || !target.startsWith(`${project}${path.sep}`)) return new Response('', { status: 403 });
  try { return new Response(await fs.readFile(target)); } catch { return new Response('', { status: 404 }); }
};
await preloadCleanArt();
async function specimen(sex, armor) {
  const appearance = normalizePresetAppearance({ sex, facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' });
  const gear = { weapon: 'dagger', armor, helmet: 'none' };
  const image = await prepareCleanAvatar(appearance, 'battle', gear);
  let svg = renderCleanAvatar(appearance, 'battle', gear);
  for (const url of new Set([...svg.matchAll(/href="((?:http:\/\/127\.0\.0\.1:4173)?\/assets\/[^\"]+)"/g)].map(match => match[1]))) {
    const bytes = await fs.readFile(path.join(project, new URL(url, 'http://127.0.0.1:4173').pathname.slice(1)));
    svg = svg.replaceAll(`href="${url}"`, `href="data:image/png;base64,${bytes.toString('base64')}"`);
  }
  return { svg, sex, armor, appearance, mainhandGrip: image.mainhandGrip, weaponGrip: image.weaponImage.grip,
    weaponAngle: image.weaponAngle, weaponMirror: image.weaponMirror, identityOffset: image.identityOffset,
    assembledIdentityAnchor: image.assembledIdentityAnchor, bodySha256: crypto.createHash('sha256').update(image.url).digest('hex') };
}
async function board(name, specimens) {
  const columns = specimens.length, width = columns * 320, height = 512;
  const labels = specimens.map((sample, index) => `<text x="${index * 320 + 160}" y="26" text-anchor="middle">${sample.sex.toUpperCase()} P05 · ${sample.armor.toUpperCase()}</text><text x="${index * 320 + 160}" y="210" text-anchor="middle">SAME COMPLETE FIGURE · 2×</text><g transform="translate(${index * 320 + 80} 50)">${sample.svg}</g><g transform="translate(${index * 320} 230) scale(2)">${sample.svg}</g>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>.pixel-sprite{image-rendering:pixelated}text{font-family:monospace;font-size:12px;fill:#ead8b3}</style><rect width="${width}" height="${height}" fill="#242026"/>${labels}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, `${name}.svg`), svg);
  await fs.writeFile(path.join(destination, `${name}.png`), png);
  await fs.writeFile(path.join(destination, `${name}-receipt.json`), `${JSON.stringify({ renderer: 'src/current-avatar.js + renderCleanAvatar', rasterizer: 'sharp SVG renderer', frame: 'complete figure native and integer 2x',
    pngSha256: crypto.createHash('sha256').update(png).digest('hex'), specimens: specimens.map(({ svg, ...metadata }) => metadata),
    evidence: 'Actual runtime renderer output rasterized locally. Separate browser checks establish creator, armory, both arena facings and attack playback. Human art acceptance remains separate.' }, null, 2)}\n`);
  console.log(path.join(destination, `${name}.png`));
}
if (process.argv.includes('--all-armors')) {
  await board('dagger-actual-renderer-all-armors', await Promise.all(['light', 'medium', 'heavy'].flatMap(armor => ['male', 'female'].map(sex => specimen(sex, armor)))));
} else await board('dagger-actual-renderer-first-pair', await Promise.all(['male', 'female'].map(sex => specimen(sex, 'medium'))));
