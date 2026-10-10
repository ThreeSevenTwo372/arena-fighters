import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../server.mjs';
import { FIRST_PERSON_PIXEL_CATALOG as catalog } from '../src/first-person-pixel-catalog.js';
import { FIRST_PERSON_WHOLE_CATALOG as wholeCatalog } from '../src/first-person-whole-catalog.js';
import { FIRST_PERSON_AXE_CATALOG as axeCatalog } from '../src/first-person-axe-catalog.js';

test('pixel foreground assets are served exactly without opening sessions or exposing source/private paths', async t => {
  const server = createAppServer({ temporarySessions: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await server.duels.initialized;
  const paths = new Set(['/assets/first-person/v002/manifest.json', '/assets/first-person/v003/manifest.json', '/assets/first-person/v004/manifest.json']);
  for (const part of [...Object.values(catalog.parts), ...Object.values(catalog.weapons), ...Object.values(catalog.offhands)]) {
    for (const url of part.variants ? Object.values(part.variants) : [part.url]) paths.add(url);
  }
  for (const armors of [...Object.values(wholeCatalog.holds), ...Object.values(axeCatalog.holds)]) for (const hold of Object.values(armors)) {
    for (const part of hold.mode === 'paired' ? [hold.main, hold.off] : [hold.main]) {
      for (const url of Object.values(part.variants)) paths.add(url);
    }
  }
  for (const url of paths) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200, url);
    assert.match(response.headers.get('content-type'), url.endsWith('.png') ? /^image\/png$/ : /^application\/json/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const expected = await readFile(new URL(`..${url}`, import.meta.url));
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(expected), `HTTP serves exact registered bytes: ${url}`);
  }
  const head = await fetch(`${base}/assets/first-person/v002/hand-ivory.png`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const axeUrl = axeCatalog.holds.axe.light.main.variants.ivory;
  const axeHead = await fetch(`${base}${axeUrl}`, { method: 'HEAD' });
  assert.equal(axeHead.status, 200);
  assert.equal((await axeHead.arrayBuffer()).byteLength, 0);
  for (const url of [
    '/assets/first-person/v002/manifest.js',
    '/assets/first-person/v002/hand-ivory.svg',
    '/assets/first-person/v002/missing.png',
    '/assets/first-person/v004/missing.png',
    '/assets/first-person/v004/%2e%2e%2f%2e%2e%2f%2e%2e%2f.local-data%2fonline-duels.json',
    '/assets/first-person/v002/%2e%2e%2f%2e%2e%2fclean-gladiator%2fv013%2fmanifest.json',
    '/assets/first-person/v002/%2e%2e%2f%2e%2e%2f%2e%2e%2f.local-data%2fonline-duels.json',
    '/ArtReview/First_Person_HD_v001/PREPARATION_RECEIPT.json',
    '/tools/prepare-first-person-hd.py',
  ]) assert.equal((await fetch(`${base}${url}`)).status, 404, url);
  assert.equal((await fetch(`${base}/assets/first-person/v002/hand-ivory.png`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}${axeUrl}`, { method: 'POST' })).status, 405);
  assert.deepEqual(Object.keys(server.duels.data.sessions), []);
});
