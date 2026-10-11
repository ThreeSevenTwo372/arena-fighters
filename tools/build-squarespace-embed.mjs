import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function squarespaceEmbed(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use the verified HTTPS game origin without a path or credentials.');
  const origin = url.origin.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<div class="blackbook-arena-game" style="width:100%;min-width:0">\n  <p style="margin:0 0 12px"><a href="${origin}/" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;min-height:44px;font-size:16px">Open Arena Fighters full screen</a></p>\n  <iframe src="${origin}/" title="Arena Fighters" style="width:100%;height:calc(100vh - 112px);height:min(900px,calc(100svh - 112px));min-height:320px;border:0;display:block;background:#201b18" allow="autoplay; fullscreen" allowfullscreen></iframe>\n</div>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = squarespaceEmbed(process.argv[2]);
  const folder = fileURLToPath(new URL('../artifacts/Temporary_Sessions_v001/', import.meta.url));
  await mkdir(folder, { recursive: true });
  const filename = `squarespace-embed-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.html`;
  const path = resolve(folder, filename);
  await writeFile(path, html, { flag: 'wx' });
  process.stdout.write(`${path}\n`);
}
