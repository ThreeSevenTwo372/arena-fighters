import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createAppServer } from '../server.mjs';
import { MemoryStore } from '../online/store.mjs';

const manifestPath = '/public/audio/soundtrack-v001/manifest.json';
const localBytes = path => readFile(new URL(`..${path}`, import.meta.url));

async function fixture(t) {
  const server = createAppServer({ store: new MemoryStore(), temporarySessions: true, tickMs: 100000 });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.duels.close(); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function rawGet(base, path) {
  return new Promise((resolve, reject) => {
    const destination = new URL(base);
    const call = request({ hostname: destination.hostname, port: destination.port, path, method: 'GET' }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    call.on('error', reject);
    call.end();
  });
}

test('soundtrack manifest serves the selected menu, eleven distinct battle songs, and a short victory effect', async t => {
  const { base, server } = await fixture(t);
  const response = await fetch(`${base}${manifestPath}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /(?:^|; )media-src 'self'(?:;|$)/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(bytes, await localBytes(manifestPath));
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, 'arena-fighters.soundtrack.v1');
  assert.equal(manifest.menu.title, 'Where the Stars Remember');
  assert.equal(manifest.battles.length, 11);
  assert.equal(new Set(manifest.battles.map(track => track.id)).size, 11);
  assert(!manifest.battles.some(track => [manifest.menu.id, manifest.effects.victory.id].includes(track.id)));
  assert.equal(manifest.effects.victory.durationSeconds, 4);
  assert(manifest.battles.every(track => track.durationSeconds > 100));
  for (const track of [manifest.menu, ...manifest.battles, manifest.effects.victory]) {
    assert.match(track.src, /^\/public\/audio\/soundtrack-v001\/[a-z0-9-]+\.mp3$/);
    assert(Number.isFinite(track.durationSeconds) && track.durationSeconds > 0);
    const head = await fetch(`${base}${track.src}`, { method: 'HEAD' });
    assert.equal(head.status, 200, track.id);
    assert.equal(head.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Number(head.headers.get('content-length')), (await localBytes(track.src)).length);
    assert.equal(await head.text(), '');
  }
  assert.equal(Object.keys(server.duels.data.sessions).length, 0, 'audio needs no guest session or fighter authority');
});

test('menu, battle, and victory MP3 GET/HEAD responses preserve encoded bytes and safe media headers', async t => {
  const { base } = await fixture(t);
  const manifest = JSON.parse(await localBytes(manifestPath));
  for (const track of [manifest.menu, manifest.battles[0], manifest.effects.victory]) {
    const expected = await localBytes(track.src);
    const response = await fetch(`${base}${track.src}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(Number(response.headers.get('content-length')), expected.length);
    assert.equal(response.headers.get('content-range'), null);
    assert.match(response.headers.get('content-security-policy'), /(?:^|; )media-src 'self'(?:;|$)/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
    const head = await fetch(`${base}${track.src}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), expected.length);
    assert.equal(head.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await head.text(), '');
  }
});

test('MP3 seeking returns exact prefix, suffix, open-ended, and clamped byte ranges', async t => {
  const { base } = await fixture(t);
  const { menu } = JSON.parse(await localBytes(manifestPath));
  const expected = await localBytes(menu.src);
  for (const [range, start, end] of [
    ['bytes=0-127', 0, 127], ['bytes=-97', expected.length - 97, expected.length - 1],
    [`bytes=${expected.length - 81}-`, expected.length - 81, expected.length - 1],
    [`bytes=${expected.length - 33}-${expected.length + 500}`, expected.length - 33, expected.length - 1],
  ]) {
    const response = await fetch(`${base}${menu.src}`, { headers: { Range: range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${expected.length}`);
    assert.equal(Number(response.headers.get('content-length')), end - start + 1);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected.subarray(start, end + 1));
    const head = await fetch(`${base}${menu.src}`, { method: 'HEAD', headers: { Range: range } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-range'), `bytes ${start}-${end}/${expected.length}`);
    assert.equal(Number(head.headers.get('content-length')), end - start + 1);
    assert.equal(await head.text(), '');
  }
});

test('invalid and unsatisfiable MP3 ranges return finite empty 416 responses', async t => {
  const { base } = await fixture(t);
  const { effects: { victory } } = JSON.parse(await localBytes(manifestPath));
  const expected = await localBytes(victory.src);
  for (const range of [`bytes=${expected.length}-`, 'bytes=80-40', 'bytes=-0', 'bytes=0-1,2-3', 'bytes=wat', 'bytes=']) {
    const response = await fetch(`${base}${victory.src}`, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${expected.length}`);
    assert.equal(response.headers.get('content-length'), '0');
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('audio allowlist rejects traversal, scripts, private paths, missing tracks, and malformed versions', async t => {
  const { base } = await fixture(t);
  for (const path of [
    '/public/audio/soundtrack-v001/../../server.mjs',
    '/public/audio/soundtrack-v001/%2e%2e%2f%2e%2e%2fserver.mjs',
    '/public/audio/soundtrack-v001/%2e%2e%5c%2e%2e%5cserver.mjs',
    '/public/audio/soundtrack-v001/manifest.js', '/public/audio/soundtrack-v001/unknown.mp3',
    '/public/audio/soundtrack-v001/subdirectory/manifest.json', '/public/audio/soundtrack-v001/.local-data/online-duels.json',
    '/public/audio/soundtrack-v001/menu-where-the-stars-remember.mp3%00',
    '/public/audio/soundtrack-v../manifest.json', '/public/audio/unversioned/menu.mp3',
    '/.local-data/online-duels.json', '/artifacts/Soundtrack_v001/PREPARATION_RECEIPT.json',
  ]) {
    const response = await rawGet(base, path);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(JSON.parse(response.body), { error: 'Not found.', code: 'invalid_request' });
    assert(!response.body.toString().includes('C:\\Users'), 'errors do not reveal local source paths');
  }
  assert.equal((await rawGet(base, '/public/audio/soundtrack-v001/%ZZ.mp3')).status, 400);
  const response = await fetch(`${base}${manifestPath}`, { method: 'POST' });
  assert.equal(response.status, 405);
});
