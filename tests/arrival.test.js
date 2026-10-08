import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createArrivalController, ARRIVAL_SEEN_KEY, ARRIVAL_VIDEO, ARRIVAL_STILL } from '../src/arrival.js';
import { createAppServer, parseMediaRange } from '../server.mjs';

class Element {
  listeners = new Map(); dataset = {}; hidden = true; focused = false;
  addEventListener(kind, handler) { this.listeners.set(kind, handler); }
  removeEventListener(kind, handler) { if (this.listeners.get(kind) === handler) this.listeners.delete(kind); }
  dispatch(kind, event = {}) { return this.listeners.get(kind)?.(event); }
  focus() { this.focused = true; }
}
function fixture({ blocked = false, reducedMotion = false, search = '', storage } = {}) {
  const values = new Map(), completions = [], classes = new Set();
  const elements = new Map();
  let plays = 0, pauses = 0, loads = 0;
  const video = new Element();
  video.play = () => { plays += 1; return blocked ? Promise.reject(new Error('Autoplay denied')) : Promise.resolve(); };
  video.pause = () => { pauses += 1; };
  video.load = () => { loads += 1; };
  video.removeAttribute = key => { delete video[key]; };
  elements.set('.arrival-video', video);
  for (const selector of ['.arrival-screen', '.arrival-status', '[data-arrival="play"]', '[data-arrival="enter"]', '[data-arrival="skip"]']) elements.set(selector, new Element());
  elements.get('.arrival-screen').classList = { remove: value => classes.delete(value) };
  const host = new Element();
  host.classList = { add: value => classes.add(value), remove: value => classes.delete(value) };
  host.querySelector = selector => elements.get(selector);
  const session = storage ?? { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const controller = createArrivalController({ storage: session, reducedMotion, search, onComplete: value => completions.push(value.reason) });
  return { host, video, elements, values, completions, controller, classes, get plays() { return plays; }, get pauses() { return pauses; }, get loads() { return loads; } };
}

test('first visit plays the real Flux export and ends once before naming; reload in the same tab bypasses it', async () => {
  const f = fixture();
  assert.equal(f.controller.shouldShow(), true);
  assert.equal(f.controller.mount(f.host), true);
  await Promise.resolve();
  assert.equal(f.controller.active, true);
  assert.equal(f.video.src, ARRIVAL_VIDEO);
  assert.equal(f.video.muted, true);
  assert.equal(f.video.playsInline, true);
  assert.match(f.host.innerHTML, /Skip intro/);
  assert.equal(f.plays, 1);
  assert.equal(f.controller.mount(f.host), false, 'An active intro cannot be mounted twice.');
  f.video.dispatch('ended');
  f.video.dispatch('ended');
  assert.deepEqual(f.completions, ['ended']);
  assert.equal(f.values.get(ARRIVAL_SEEN_KEY), '1');
  assert.equal(f.controller.active, false);
  assert.equal(f.pauses, 1);
  assert.equal(f.loads, 1);
  assert.equal(f.video.src, undefined);
  assert.equal(f.controller.shouldShow(), false);
  const next = createArrivalController({ storage: { getItem: key => f.values.get(key) } });
  assert.equal(next.shouldShow(), false);
});

test('skip and Escape complete immediately, preserve the once-per-tab flag, and explicit replay remains available', async () => {
  const f = fixture();
  f.controller.mount(f.host);
  f.elements.get('[data-arrival="skip"]').dispatch('click');
  assert.deepEqual(f.completions, ['skip']);
  assert.equal(f.controller.replay(f.host), true);
  let prevented = false;
  f.host.dispatch('keydown', { key: 'Escape', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(f.completions, ['skip', 'skip']);
  await Promise.resolve();
  assert.equal(f.controller.active, false, 'Late play resolution must not reactivate a completed intro.');
});

test('review URLs bypass both the first arrival and replay without modifying the session flag', () => {
  for (const search of ['?face-presets-review=1', '?spectator-frame-review=1', '?other=1&face-presets-review=1']) {
    const f = fixture({ search });
    assert.equal(f.controller.shouldShow(), false);
    assert.equal(f.controller.mount(f.host), false);
    assert.equal(f.controller.replay(f.host), false);
    assert.equal(f.values.size, 0);
    assert.equal(f.plays, 0);
  }
});

test('reduced motion shows the arena still and requires an intentional Enter or Watch choice', async () => {
  const f = fixture({ reducedMotion: true });
  f.controller.mount(f.host);
  assert.equal(f.plays, 0);
  assert.match(f.host.innerHTML, new RegExp(ARRIVAL_STILL));
  assert.match(f.host.innerHTML, /preload="none"/);
  assert.doesNotMatch(f.host.innerHTML, new RegExp(` src="${ARRIVAL_VIDEO}"`));
  f.elements.get('[data-arrival="enter"]').dispatch('click');
  assert.deepEqual(f.completions, ['reduced-motion']);
  f.controller.replay(f.host);
  await f.elements.get('[data-arrival="play"]').dispatch('click');
  assert.equal(f.plays, 1);
  assert.equal(f.video.src, ARRIVAL_VIDEO);
});

test('blocked autoplay and failed media offer working exits; disposal removes listeners and media requests', async () => {
  const f = fixture({ blocked: true });
  f.controller.mount(f.host);
  await Promise.resolve();
  assert.equal(f.elements.get('.arrival-screen').dataset.state, 'blocked');
  assert.equal(f.elements.get('[data-arrival="play"]').hidden, false);
  assert.equal(f.elements.get('[data-arrival="play"]').focused, true);
  f.video.dispatch('error');
  assert.equal(f.elements.get('.arrival-screen').dataset.state, 'error');
  assert.equal(f.elements.get('[data-arrival="enter"]').hidden, false);
  f.elements.get('[data-arrival="enter"]').dispatch('click');
  assert.deepEqual(f.completions, ['media-error']);
  f.controller.replay(f.host);
  f.controller.dispose();
  await Promise.resolve();
  f.video.dispatch('ended');
  assert.deepEqual(f.completions, ['media-error']);
  assert.equal(f.controller.active, false);
  assert.equal(f.host.listeners.size, 0);
  assert.equal(f.video.listeners.size, 0);
  assert.equal(f.classes.has('arrival-active'), false);
});

test('unavailable session storage still allows a usable intro and remembers completion in this page', () => {
  const f = fixture({ storage: { getItem() { throw new Error('Denied'); }, setItem() { throw new Error('Denied'); } } });
  assert.equal(f.controller.replay(f.host), true);
  f.elements.get('[data-arrival="skip"]').dispatch('click');
  assert.deepEqual(f.completions, ['skip']);
  assert.equal(f.controller.shouldShow(), false);
});

test('finite, open, and suffix ranges are bounded; impossible or ambiguous ranges are rejected', () => {
  assert.equal(parseMediaRange(undefined, 100), null);
  assert.deepEqual(parseMediaRange('bytes=4-9', 100), { start: 4, end: 9 });
  assert.deepEqual(parseMediaRange('bytes=98-', 100), { start: 98, end: 99 });
  assert.deepEqual(parseMediaRange('bytes=-7', 100), { start: 93, end: 99 });
  assert.deepEqual(parseMediaRange('bytes=-700', 100), { start: 0, end: 99 });
  assert.deepEqual(parseMediaRange('bytes=4-900', 100), { start: 4, end: 99 });
  for (const header of ['bytes=', 'bytes=-', 'bytes=-0', 'bytes=9-4', 'bytes=100-', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'items=0-1']) assert.equal(parseMediaRange(header, 100), false, header);
});

test('public cinematic media supports browser seeking and HEAD while source artwork and receipts stay private', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'arena-arrival-media-'));
  const server = createAppServer({ storePath: join(directory, 'state.json'), tickMs: 60000 });
  t.after(async () => { await new Promise(done => server.close(done)); await server.duels.close(); await rm(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const content = await readFile(new URL(`..${ARRIVAL_VIDEO}`, import.meta.url));
  const head = await fetch(base + ARRIVAL_VIDEO, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('content-length'), String(content.length));
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.match(head.headers.get('content-security-policy'), /media-src 'self'/);
  assert.match(head.headers.get('cache-control'), /immutable/);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const partial = await fetch(base + ARRIVAL_VIDEO, { headers: { Range: 'bytes=32-127' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 32-127/${content.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), content.subarray(32, 128));
  const suffix = await fetch(base + ARRIVAL_VIDEO, { headers: { Range: 'bytes=-48' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), content.subarray(-48));
  const seekHead = await fetch(base + ARRIVAL_VIDEO, { method: 'HEAD', headers: { Range: 'bytes=48-99' } });
  assert.equal(seekHead.status, 206);
  assert.equal(seekHead.headers.get('content-length'), '52');
  assert.equal((await seekHead.arrayBuffer()).byteLength, 0);
  const invalid = await fetch(base + ARRIVAL_VIDEO, { headers: { Range: `bytes=${content.length}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${content.length}`);
  assert.equal((await invalid.arrayBuffer()).byteLength, 0);
  const poster = await fetch(base + '/public/cinematics/arrival-v001/poster.jpg', { method: 'HEAD' });
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  for (const path of ['/ArtReview/Cinematics_Animation_v002/Exports/sky-to-arena-v002.mp4', '/public/cinematics/arrival-v001/PREPARATION_RECEIPT.json', '/public/cinematics/arrival-v001/..%2F..%2F..%2Fserver.mjs']) {
    const forbidden = await fetch(base + path);
    assert.equal(forbidden.status, 404, path);
    await forbidden.arrayBuffer();
  }
});
