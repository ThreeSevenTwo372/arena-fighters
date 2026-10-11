import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer, hostingOptions } from '../server.mjs';

async function app(t, options = {}) {
  const server = createAppServer({ temporarySessions: true, tickMs: 100000, ...options });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.duels.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const guest = async (headers = {}) => {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
    return { status: response.status, ...(await response.json()) };
  };
  return { server, base, guest };
}

test('hosting uses provider PORT, explicit temporary mode and HTTPS origin without changing local defaults', () => {
  assert.deepEqual(hostingOptions({}, []), { host: '127.0.0.1', port: 4173, temporarySessions: false, publicOrigins: [], embedOrigins: [] });
  const hosted = hostingOptions({ PORT: '10000', SESSION_MODE: 'temporary', RENDER_EXTERNAL_URL: 'https://arena.example', EMBED_ORIGINS: 'https://www.blackbooktattoo.com,https://blackbooktattoo.com' }, []);
  assert.equal(hosted.host, '0.0.0.0'); assert.equal(hosted.port, 10000); assert.equal(hosted.temporarySessions, true);
  assert.deepEqual(hosted.publicOrigins, ['https://arena.example']);
  assert.equal(hosted.embedOrigins.length, 2);
  assert.equal(hostingOptions({ PORT: '10000' }, ['--port', '4174', '--host', '127.0.0.1']).port, 4174);
  assert.throws(() => hostingOptions({ SESSION_MODE: 'invalid' }, []));
  assert.throws(() => hostingOptions({ PORT: '0' }, []));
  for (const origin of ['javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?query']) assert.throws(() => hostingOptions({ PUBLIC_ORIGIN: origin }, []));
});

test('temporary HTML selects tab sessions, health checks are public, and Squarespace alone may embed', async t => {
  const { base, server } = await app(t, { embedOrigins: ['https://www.blackbooktattoo.com', 'https://blackbooktattoo.com'] });
  const page = await fetch(base);
  assert.match(await page.text(), /<meta name="arena-session-mode" content="temporary">/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/www\.blackbooktattoo\.com https:\/\/blackbooktattoo\.com$/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok', sessionMode: 'temporary' });
  const head = await fetch(`${base}/healthz`, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  const created = await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.equal(typeof created.token, 'string');
  assert.equal(server.duels.temporarySessions, true);
  for (const path of ['/server.mjs', '/.local-data/online-duels.json', '/render.yaml', '/HOSTING.md']) assert.equal((await fetch(`${base}${path}`)).status, 404);
});

test('HTTPS public origin works behind a proxy while cross-site mutations remain forbidden', async t => {
  const { base, guest } = await app(t, { publicOrigin: 'https://arena.example' });
  assert.equal((await guest({ Origin: 'https://arena.example' })).status, 200);
  assert.equal((await guest({ Origin: 'https://www.blackbooktattoo.com' })).status, 403);
  assert.equal((await guest({ Origin: base, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'arena.example' })).status, 403);
  assert.equal((await guest({ Origin: 'https://arena.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('Home Screen manifest and icons are public without issuing a guest or exposing private files', async t => {
  const { base, server } = await app(t);
  await server.duels.initialized;
  assert.equal(Object.keys(server.duels.data.sessions).length, 0);
  const page = await fetch(base);
  const html = await page.text();
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<link rel="manifest" href="\/public\/app-v001\/manifest\.webmanifest">/);
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="\/public\/app-v001\/icon-180\.png">/);
  assert.match(page.headers.get('content-security-policy'), /manifest-src 'self';/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; style-src 'self';/);
  const response = await fetch(`${base}/public/app-v001/manifest.webmanifest`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/manifest\+json/);
  const manifest = await response.json();
  assert.equal(manifest.name, 'Arena Fighters');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#201b18');
  for (const size of [180, 192, 512]) {
    const icon = await fetch(`${base}/public/app-v001/icon-${size}.png`);
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    const png = Buffer.from(await icon.arrayBuffer());
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }
  for (const icon of manifest.icons) assert.equal((await fetch(new URL(icon.src, base))).status, 200);
  const svg = await fetch(`${base}/public/app-v001/icon.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(await svg.text(), decodeURIComponent(html.match(/href="data:image\/svg\+xml,([^"]+)"/)[1]));
  const head = await fetch(`${base}/public/app-v001/manifest.webmanifest`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/public/app-v001/', '/public/app-v001/manifest.json', '/public/app-v001/sub/icon.svg', '/public/app-v001/.hidden.svg', '/public/app-v001/..%2F..%2Fserver.mjs', '/server.mjs', '/.local-data/online-duels.json']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  assert.equal(Object.keys(server.duels.data.sessions).length, 0);
  assert.equal(Object.keys(server.duels.data.rooms).length, 0);
  assert.equal(Object.keys(server.duels.data.tournaments).length, 0);
});

test('authenticated poll quotas are separate for guests behind one hosting proxy', async t => {
  const { base, guest } = await app(t);
  const first = await guest(), second = await guest();
  const read = async token => { const response = await fetch(`${base}/api/session`, { headers: { Authorization: `Bearer ${token}` } }); await response.arrayBuffer(); return response.status; };
  for (let batch = 0; batch < 31; batch++) {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => read(index % 2 ? first.token : second.token)));
    assert.ok(responses.every(status => status === 200), `batch ${batch} stays below each guest quota`);
  }
  for (let remaining = 290; remaining > 0; remaining -= 20) {
    const more = await Promise.all(Array.from({ length: Math.min(20, remaining) }, () => read(first.token)));
    assert.ok(more.every(status => status === 200));
  }
  assert.equal(await read(first.token), 429);
  assert.equal(await read(second.token), 200);
});

test('guest issuance retains its anonymous quota even if a previous guest authorizes the request', async t => {
  const { guest } = await app(t);
  const first = await guest();
  for (let index = 1; index < 30; index++) assert.equal((await guest({ Authorization: `Bearer ${first.token}` })).status, 200);
  assert.equal((await guest({ Authorization: `Bearer ${first.token}` })).status, 429);
});
