import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameAudio } from '../src/game-audio.js';

const directory = '/public/audio/soundtrack-v001/';
const track = (id, title = id) => ({ id, title, src: `${directory}${id}.mp3`, durationSeconds: 120 });
const soundtrack = () => ({
  schema: 'arena-fighters.soundtrack.v1', menu: track('menu', 'Deicide Main Menu'),
  battles: ['battle-a', 'battle-b', 'battle-c'].map(id => track(id)),
  effects: { victory: { ...track('victory'), durationSeconds: 2.5 } },
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class FakeAudio {
  constructor() {
    this.src = '';
    this.currentTime = 0;
    this.calls = [];
    this.listeners = new Map();
    this.results = [];
    this.playing = false;
  }
  play() {
    this.calls.push(['play', this.src]);
    this.playing = true;
    return this.results.shift() ?? Promise.resolve();
  }
  pause() { this.calls.push(['pause']); this.playing = false; }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  removeAttribute(name) { if (name === 'src') this.src = ''; }
  load() { this.calls.push(['load']); }
  count(name) { return this.calls.filter(call => call[0] === name).length; }
}

class FakeParameter {
  constructor() { this.value = 0; this.calls = []; }
  setValueAtTime(...args) { this.calls.push(['set', ...args]); }
  linearRampToValueAtTime(...args) { this.calls.push(['linear', ...args]); }
  exponentialRampToValueAtTime(...args) { this.calls.push(['exponential', ...args]); }
}
class FakeNode {
  constructor() { this.connections = []; this.disconnected = false; }
  connect(node) { this.connections.push(node); }
  disconnect() { this.disconnected = true; }
}
class FakeOscillator extends FakeNode {
  constructor() { super(); this.frequency = new FakeParameter(); this.stops = []; }
  start(time) { this.started = time; }
  stop(time) { this.stops.push(time); }
  end() { this.onended?.(); }
}
class FakeContext {
  constructor(state = 'running') {
    this.state = state;
    this.currentTime = 10;
    this.destination = {};
    this.gains = [];
    this.oscillators = [];
    this.resumes = 0;
  }
  createGain() { const node = new FakeNode(); node.gain = new FakeParameter(); this.gains.push(node); return node; }
  createOscillator() { const node = new FakeOscillator(); this.oscillators.push(node); return node; }
  resume() { this.resumes++; this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}

function fixture(options = {}) {
  const players = [];
  const context = new FakeContext();
  const writes = [];
  const engine = createGameAudio({
    manifestUrl: `${directory}manifest.json`,
    fetcher: async () => ({ ok: true, json: async () => soundtrack() }),
    createAudio: () => { const audio = new FakeAudio(); players.push(audio); return audio; },
    createContext: () => context,
    storage: { getItem: () => null, setItem: (...args) => writes.push(args) },
    random: () => 0.25,
    ...options,
  });
  return { engine, players, context, writes };
}

test('no score or effects autoplay before a gesture; one score survives rerenders and settings', async () => {
  const { engine, players, context } = fixture();
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.load(), true);
  assert.equal(engine.getState().status, 'locked');
  assert.equal(players.length, 0);
  assert.equal(engine.playEffect('click'), false);
  assert.equal(context.oscillators.length, 0);
  assert.equal(await engine.unlock(), true);
  assert.equal(players.length, 1);
  const score = players[0];
  assert.equal(score.src, `${directory}menu.mp3`);
  assert.equal(score.loop, true);
  assert.equal(score.volume, 0.35);
  assert.equal(engine.getState().status, 'playing');
  score.currentTime = 36;
  for (let index = 0; index < 20; index++) engine.setScene({ kind: 'menu' });
  await flush();
  assert.equal(score.count('play'), 1);
  assert.equal(score.currentTime, 36);
  engine.setMuted(true);
  assert.equal(score.playing, false);
  engine.setMuted(false);
  await flush();
  assert.equal(score.currentTime, 36);
  assert.equal(players.length, 1);
  engine.dispose();
});

test('battle shuffle uses each song before refill, never immediately repeats, and remembers stable keys', async () => {
  const { engine, players } = fixture();
  await engine.load();
  await engine.unlock();
  const choices = [];
  for (let battle = 0; battle < 12; battle++) {
    engine.setScene({ kind: 'battle', battleKey: `battle-${battle}` });
    await flush();
    choices.push(engine.getState().trackTitle);
    engine.setScene({ kind: 'battle', battleKey: `battle-${battle}` });
    await flush();
    assert.equal(engine.getState().trackTitle, choices.at(-1));
  }
  for (let offset = 0; offset < 12; offset += 3) assert.equal(new Set(choices.slice(offset, offset + 3)).size, 3);
  for (let index = 1; index < choices.length; index++) assert.notEqual(choices[index], choices[index - 1]);
  engine.setScene({ kind: 'battle', battleKey: 'battle-4' });
  await flush();
  assert.equal(engine.getState().trackTitle, choices[4]);
  assert.equal(players.length, 1);
  engine.dispose();
});

test('mute, hidden pages, and cinematics retain battle selection and silence every effect', async () => {
  const { engine, players, context } = fixture();
  await engine.load();
  engine.setScene({ kind: 'battle', battleKey: 'retained' });
  await engine.unlock();
  const selected = engine.getState().trackTitle;
  const score = players[0];
  score.currentTime = 57;
  assert.equal(engine.playEffect('hit'), true);
  engine.setVisible(false);
  assert.equal(score.playing, false);
  assert.equal(engine.getState().activeEffectVoices, 0);
  assert.equal(engine.playEffect('victory'), false);
  assert.equal(context.oscillators[0].disconnected, true);
  engine.setVisible(true);
  await flush();
  assert.equal(score.currentTime, 57);
  engine.setScene({ kind: 'cinematic' });
  assert.equal(score.playing, false);
  assert.equal(engine.playEffect('click'), false);
  engine.setScene({ kind: 'battle', battleKey: 'retained' });
  await flush();
  assert.equal(engine.getState().trackTitle, selected);
  engine.setMuted(true);
  assert.equal(engine.playEffect('swing'), false);
  engine.setMuted(false);
  await flush();
  assert.equal(engine.getState().trackTitle, selected);
  engine.setScene({ kind: 'silent' });
  assert.equal(score.playing, false);
  engine.dispose();
});

test('a late play success cannot restart hidden, muted, cinematic, or disposed audio', async () => {
  for (const stop of [engine => engine.setVisible(false), engine => engine.setMuted(true),
    engine => engine.setScene({ kind: 'cinematic' }), engine => engine.dispose()]) {
    const score = new FakeAudio();
    const pending = deferred();
    score.results.push(pending.promise);
    const { engine } = fixture({ createAudio: () => score });
    await engine.load();
    engine.setScene({ kind: 'menu' });
    const unlocking = engine.unlock();
    stop(engine);
    score.playing = true; // A media implementation may finish starting after pause.
    pending.resolve();
    assert.equal(await unlocking, false);
    assert.equal(score.playing, false);
    assert.notEqual(engine.getState().status, 'playing');
    engine.dispose();
  }
});

test('rejected playback is visible, retry waits for a later gesture, and suspended effects resume together', async () => {
  const score = new FakeAudio();
  score.results.push(Promise.reject(new Error('Autoplay denied.')));
  const context = new FakeContext('suspended');
  const { engine } = fixture({ createAudio: () => score, createContext: () => context });
  await engine.load();
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.unlock(), false);
  assert.equal(context.resumes, 1);
  assert.equal(engine.getState().status, 'blocked');
  assert.match(engine.getState().error, /Tap or press/);
  engine.setScene({ kind: 'menu' });
  await flush();
  assert.equal(score.count('play'), 1);
  assert.equal(await engine.unlock(), true);
  assert.equal(engine.getState().status, 'playing');
  assert.equal(score.count('play'), 2);
  assert.equal(engine.playEffect('click'), true);
  engine.dispose();
});

test('settings persist independently, clamp volume, and tolerate corrupt or unavailable storage', async () => {
  const values = new Map([['arena-fighters.audio.v1', JSON.stringify({ muted: true, musicVolume: 0.2, effectsVolume: 0.7 })]]);
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const { engine } = fixture({ storage });
  assert.equal(engine.getState().muted, true);
  assert.equal(engine.getState().musicVolume, 0.2);
  assert.equal(engine.getState().effectsVolume, 0.7);
  engine.setMusicVolume(7);
  engine.setEffectsVolume(-1);
  engine.setMuted(false);
  const saved = JSON.parse(values.get('arena-fighters.audio.v1'));
  assert.deepEqual(saved, { muted: false, musicVolume: 1, effectsVolume: 0 });
  engine.setMusicVolume(NaN);
  assert.equal(engine.getState().musicVolume, 1);
  engine.dispose();
  for (const broken of [{ getItem: () => '{broken', setItem: () => { throw new Error('Denied.'); } },
    { getItem: () => { throw new Error('Denied.'); }, setItem: () => { throw new Error('Denied.'); } }]) {
    const candidate = fixture({ storage: broken }).engine;
    assert.equal(candidate.getState().musicVolume, 0.35);
    assert.equal(candidate.getState().effectsVolume, 0.5);
    assert.doesNotThrow(() => candidate.setMuted(true));
    candidate.dispose();
  }
});

test('manifest failures and unsafe media paths fail safely without creating or playing media', async () => {
  const unsafe = ['https://example.com/song.mp3', '//example.com/song.mp3',
    `${directory}../song.mp3`, `${directory}song.mp3?download=1`, `${directory}%2e%2e-song.mp3`,
    '/public/audio/soundtrack-v002/song.mp3'];
  for (const src of unsafe) {
    const value = soundtrack();
    value.menu.src = src;
    const { engine, players } = fixture({ fetcher: async () => ({ json: async () => value }) });
    assert.equal(await engine.load(), false, src);
    assert.equal(engine.getState().status, 'unavailable');
    assert.equal(players.length, 0);
    engine.dispose();
  }
  for (const mutate of [value => { value.schema = 'other'; }, value => { value.battles = []; },
    value => { value.battles[0].id = value.menu.id; }, value => { value.menu.durationSeconds = NaN; }]) {
    const value = soundtrack();
    mutate(value);
    const { engine } = fixture({ fetcher: async () => ({ json: async () => value }) });
    assert.equal(await engine.load(), false);
    engine.dispose();
  }
  const { engine } = fixture({ fetcher: async () => { throw new Error('Network failure.'); } });
  assert.equal(await engine.load(), false);
  assert.equal(await engine.load(), false);
  engine.dispose();
});

test('effect voices have short quiet envelopes, are bounded, and disconnect after ending or teardown', async () => {
  const { engine, context } = fixture();
  await engine.load();
  engine.setScene({ kind: 'battle', battleKey: 'effects' });
  await engine.unlock();
  assert.equal(engine.playEffect('unknown'), false);
  for (let index = 0; index < 20; index++) assert.equal(engine.playEffect('hit'), true);
  assert.equal(engine.getState().activeEffectVoices, 8);
  assert.equal(context.oscillators.filter(node => node.disconnected).length, 12);
  const last = context.oscillators.at(-1);
  const gain = context.gains.at(-1);
  assert.ok(last.stops[0] - last.started < 0.2);
  assert.ok(gain.gain.calls.find(call => call[0] === 'linear')[1] < 0.25);
  last.end();
  assert.equal(engine.getState().activeEffectVoices, 7);
  assert.equal(last.disconnected, true);
  assert.equal(gain.disconnected, true);
  engine.setEffectsVolume(0);
  assert.equal(engine.getState().activeEffectVoices, 0);
  assert.ok(context.oscillators.every(node => node.disconnected));
  assert.equal(engine.playEffect('recover'), false);
  engine.setEffectsVolume(0.8);
  assert.equal(context.gains[0].gain.value, 0.8);
  assert.equal(engine.playEffect('swing', { weapon: 'dagger' }), true);
  assert.equal(context.oscillators.at(-1).frequency.calls[0][1], 336);
  engine.dispose();
  assert.ok(context.oscillators.every(node => node.disconnected));
  assert.equal(context.state, 'closed');
});

test('victory clip uses a single bounded player, follows effect volume, and cannot resume after stop', async () => {
  const { engine, players } = fixture();
  await engine.load();
  engine.setScene({ kind: 'battle', battleKey: 'winner' });
  await engine.unlock();
  assert.equal(engine.playEffect('victory'), true);
  await flush();
  assert.equal(players.length, 2);
  const clip = players[1];
  assert.equal(clip.src, `${directory}victory.mp3`);
  assert.equal(clip.loop, false);
  engine.setEffectsVolume(0.3);
  assert.equal(clip.volume, 0.3);
  const pending = deferred();
  clip.results.push(pending.promise);
  engine.playEffect('victory');
  assert.equal(players.length, 2);
  engine.stopEffects();
  clip.playing = true;
  pending.resolve();
  await flush();
  assert.equal(clip.playing, false);
  engine.dispose();
  assert.equal(clip.src, '');
});

test('clip rejection falls back to a short synthesized cue only while effects remain allowed', async () => {
  const { engine, players, context } = fixture();
  await engine.load();
  engine.setScene({ kind: 'menu' });
  await engine.unlock();
  engine.playEffect('victory');
  await flush();
  players[1].results.push(Promise.reject(new Error('Decode failed.')));
  engine.playEffect('victory');
  await flush();
  assert.equal(context.oscillators.length, 1);
  const pending = deferred();
  players[1].results.push(pending.promise);
  engine.playEffect('victory');
  engine.setMuted(true);
  pending.reject(new Error('Muted before rejection.'));
  await flush();
  assert.equal(context.oscillators.length, 1);
  engine.dispose();
});

test('remembered battles are bounded and disposal is safe during loading and future callbacks', async () => {
  const { engine, players } = fixture();
  await engine.load();
  await engine.unlock();
  for (let index = 0; index < 80; index++) engine.setScene({ kind: 'battle', battleKey: `key-${index}` });
  await flush();
  assert.equal(engine.getState().rememberedBattleCount, 32);
  engine.dispose();
  const calls = players[0].calls.length;
  assert.equal(await engine.unlock(), false);
  engine.setScene({ kind: 'menu' });
  engine.setVisible(true);
  engine.setMuted(false);
  assert.equal(engine.playEffect('hit'), false);
  assert.equal(players[0].calls.length, calls);
  const pending = deferred();
  const loading = fixture({ fetcher: () => pending.promise }).engine;
  const completed = loading.load();
  loading.dispose();
  pending.resolve({ json: async () => soundtrack() });
  assert.equal(await completed, false);
  assert.equal(loading.getState().ready, false);
});

test('missing browser audio APIs and subscriber errors cannot interrupt the game', async () => {
  const { engine } = fixture({ createAudio: () => null, createContext: () => null });
  let count = 0;
  const unsubscribe = engine.subscribe(() => { count++; throw new Error('UI listener failed.'); });
  await engine.load();
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.unlock(), false);
  assert.equal(engine.getState().status, 'unavailable');
  assert.equal(engine.playEffect('click'), false);
  assert.ok(count > 1);
  unsubscribe();
  const previous = count;
  engine.dispose();
  assert.equal(count, previous);
  assert.ok(Object.isFrozen(engine.getState()));
});

test('a later sound gesture retries a transient manifest failure without rerender polling', async () => {
  let requests = 0;
  const context = new FakeContext('suspended');
  const { engine } = fixture({
    createContext: () => context,
    fetcher: async () => {
      requests++;
      if (requests === 1) throw new Error('Temporary network outage.');
      return { json: async () => soundtrack() };
    },
  });
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.load(), false);
  assert.equal(requests, 1);
  for (let index = 0; index < 10; index++) engine.setScene({ kind: 'menu' });
  assert.equal(requests, 1);
  assert.equal(await engine.unlock(), true);
  assert.equal(context.resumes, 1);
  assert.equal(requests, 2);
  assert.equal(engine.getState().status, 'playing');
  engine.dispose();
});

test('unsupported media shows unavailable while autoplay rejection requests a gesture', async () => {
  const score = new FakeAudio();
  const unavailable = new Error('Unsupported file.');
  unavailable.name = 'NotSupportedError';
  score.results.push(Promise.reject(unavailable));
  const { engine } = fixture({ createAudio: () => score });
  await engine.load();
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.unlock(), false);
  assert.equal(engine.getState().status, 'unavailable');
  assert.equal(engine.getState().error, 'Soundtrack is unavailable.');
  engine.setScene({ kind: 'menu' });
  await flush();
  assert.equal(score.count('play'), 1);
  assert.equal(await engine.unlock(), true);
  assert.equal(engine.getState().status, 'playing');
  score.listeners.get('error')();
  assert.equal(engine.getState().status, 'unavailable');
  assert.equal(score.playing, false);
  engine.dispose();
});

test('audio creation can recover and independent zero volumes silence only their channel', async () => {
  let attempts = 0;
  const score = new FakeAudio();
  const { engine, context } = fixture({ createAudio: () => ++attempts === 1 ? null : score });
  await engine.load();
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.unlock(), false);
  assert.equal(engine.getState().status, 'unavailable');
  assert.equal(await engine.unlock(), true);
  assert.equal(engine.getState().status, 'playing');
  engine.setMusicVolume(0);
  assert.equal(score.playing, false);
  assert.equal(engine.playEffect('click'), true);
  engine.setMusicVolume(0.4);
  await flush();
  assert.equal(score.playing, true);
  engine.setEffectsVolume(0);
  assert.equal(score.playing, true);
  assert.equal(engine.playEffect('click'), false);
  assert.ok(context.oscillators.every(node => node.disconnected));
  engine.dispose();
});

test('best-effort music can start before interaction without enabling effects or constructing a context', async () => {
  let contexts = 0;
  const context = new FakeContext();
  const { engine, players } = fixture({ createContext: () => { contexts++; return context; } });
  engine.setScene({ kind: 'menu' });
  await engine.load();
  assert.equal(await engine.startMusic(), true);
  assert.equal(engine.getState().status, 'playing');
  assert.equal(engine.getState().effectsUnlocked, false);
  assert.equal(contexts, 0);
  assert.equal(engine.playEffect('click'), false);
  assert.equal(engine.playEffect('victory'), false);
  assert.equal(players.length, 1);
  const score = players[0];
  score.currentTime = 14;
  for (let index = 0; index < 10; index++) engine.setScene({ kind: 'menu' });
  await flush();
  assert.equal(score.count('play'), 1);
  assert.equal(score.currentTime, 14);
  assert.equal(await engine.unlock(), true);
  assert.equal(contexts, 1);
  assert.equal(engine.playEffect('click'), true);
  assert.equal(score.count('play'), 1);
  engine.dispose();
});

test('denied best-effort autoplay waits for a trusted gesture instead of retrying on rerenders', async () => {
  const score = new FakeAudio();
  const denial = new Error('A gesture is required.');
  denial.name = 'NotAllowedError';
  score.results.push(Promise.reject(denial));
  let contexts = 0;
  const context = new FakeContext('suspended');
  const { engine } = fixture({ createAudio: () => score, createContext: () => { contexts++; return context; } });
  await engine.load();
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.startMusic(), false);
  assert.equal(engine.getState().status, 'blocked');
  assert.equal(contexts, 0);
  for (let index = 0; index < 10; index++) {
    engine.setScene({ kind: 'menu' });
    assert.equal(await engine.startMusic(), false);
  }
  assert.equal(score.count('play'), 1);
  assert.equal(engine.playEffect('hit'), false);
  assert.equal(await engine.unlock(), true);
  assert.equal(score.count('play'), 2);
  assert.equal(contexts, 1);
  assert.equal(context.resumes, 1);
  assert.equal(engine.playEffect('hit'), true);
  engine.dispose();
});

test('best-effort music respects mute, zero volume, hidden pages, silent scenes, and disposal before any media attempt', async () => {
  for (const silence of [engine => engine.setMuted(true), engine => engine.setMusicVolume(0),
    engine => engine.setVisible(false), engine => engine.setScene({ kind: 'cinematic' }),
    engine => engine.setScene({ kind: 'silent' }), engine => engine.dispose()]) {
    let contexts = 0;
    const { engine, players } = fixture({ createContext: () => { contexts++; return new FakeContext(); } });
    engine.setScene({ kind: 'menu' });
    assert.equal(await engine.startMusic(), false);
    await engine.load();
    silence(engine);
    assert.equal(await engine.startMusic(), false);
    assert.equal(players.length, 0);
    assert.equal(contexts, 0);
    assert.equal(engine.playEffect('victory'), false);
    engine.dispose();
  }
});

test('late best-effort playback cannot resume after visibility, mute, cinematic, or disposal cancels it', async () => {
  for (const cancel of [engine => engine.setVisible(false), engine => engine.setMuted(true),
    engine => engine.setScene({ kind: 'cinematic' }), engine => engine.dispose()]) {
    const score = new FakeAudio();
    const pending = deferred();
    score.results.push(pending.promise);
    let contexts = 0;
    const { engine } = fixture({ createAudio: () => score, createContext: () => { contexts++; return new FakeContext(); } });
    await engine.load();
    engine.setScene({ kind: 'menu' });
    const starting = engine.startMusic();
    cancel(engine);
    score.playing = true;
    pending.resolve();
    assert.equal(await starting, false);
    assert.equal(score.playing, false);
    assert.equal(contexts, 0);
    assert.equal(engine.getState().effectsUnlocked, false);
    engine.dispose();
  }
});
