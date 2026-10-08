/** Local presentation only. Audio never reads choices or changes battle state. */
const DEFAULT_MANIFEST = '/public/audio/soundtrack-v001/manifest.json';
const SETTINGS_KEY = 'arena-fighters.audio.v1';
const DEFAULT_SETTINGS = Object.freeze({ muted: false, musicVolume: 0.35, effectsVolume: 0.5 });
const MAX_REMEMBERED_BATTLES = 32;
const MAX_EFFECT_VOICES = 8;
const SCENES = new Set(['menu', 'battle', 'cinematic', 'silent']);
const MANIFEST_PATH = /^\/public\/audio\/soundtrack-v\d{3}\/manifest\.json$/;
const AUDIO_PATH = /^\/public\/audio\/soundtrack-v\d{3}\/[a-z0-9][a-z0-9_-]*\.mp3$/i;
const EFFECTS = Object.freeze({
  click: { wave: 'square', from: 900, to: 650, duration: 0.055, gain: 0.075 },
  swing: { wave: 'triangle', from: 240, to: 90, duration: 0.11, gain: 0.12 },
  hit: { wave: 'square', from: 100, to: 38, duration: 0.08, gain: 0.18 },
  parry: { wave: 'triangle', from: 1200, to: 650, duration: 0.12, gain: 0.13 },
  guard: { wave: 'triangle', from: 550, to: 310, duration: 0.1, gain: 0.1 },
  recover: { wave: 'sine', from: 370, to: 740, duration: 0.22, gain: 0.09 },
  defeat: { wave: 'triangle', from: 200, to: 45, duration: 0.35, gain: 0.12 },
  round: { wave: 'square', from: 620, to: 820, duration: 0.09, gain: 0.07 },
  execution: { wave: 'square', from: 90, to: 25, duration: 0.17, gain: 0.2 },
  victory: { wave: 'triangle', from: 660, to: 990, duration: 0.32, gain: 0.12 },
});

const boundedVolume = value => typeof value === 'number' && Number.isFinite(value)
  ? Math.min(1, Math.max(0, value)) : null;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function readSettings(storage) {
  try {
    const saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { ...DEFAULT_SETTINGS };
    return {
      muted: typeof saved.muted === 'boolean' ? saved.muted : DEFAULT_SETTINGS.muted,
      musicVolume: boundedVolume(saved.musicVolume) ?? DEFAULT_SETTINGS.musicVolume,
      effectsVolume: boundedVolume(saved.effectsVolume) ?? DEFAULT_SETTINGS.effectsVolume,
    };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function validateManifest(value, manifestUrl) {
  if (!MANIFEST_PATH.test(manifestUrl) || value?.schema !== 'arena-fighters.soundtrack.v1'
    || !Array.isArray(value.battles) || value.battles.length < 1 || value.battles.length > 64) {
    throw new Error('Invalid soundtrack manifest.');
  }
  const directory = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
  const identifiers = new Set();
  const track = entry => {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(entry.id)
      || identifiers.has(entry.id) || typeof entry.title !== 'string' || !entry.title.trim()
      || entry.title.length > 200 || typeof entry.src !== 'string' || !AUDIO_PATH.test(entry.src)
      || !entry.src.startsWith(directory) || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds <= 0) {
      throw new Error('Invalid soundtrack track.');
    }
    identifiers.add(entry.id);
    return Object.freeze({ id: entry.id, title: entry.title.trim(), src: entry.src, durationSeconds: entry.durationSeconds });
  };
  const menu = track(value.menu);
  const battles = Object.freeze(value.battles.map(track));
  const victory = value.effects?.victory ? track(value.effects.victory) : null;
  return Object.freeze({ menu, battles, victory });
}

function defaultAudio() {
  return typeof globalThis.Audio === 'function' ? new globalThis.Audio() : null;
}

function defaultContext() {
  const Constructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return typeof Constructor === 'function' ? new Constructor() : null;
}

/** Call unlock directly in a trusted pointer/key handler; play/resume can reject. */
export function createGameAudio({
  manifestUrl = DEFAULT_MANIFEST,
  fetcher = (...args) => globalThis.fetch(...args),
  createAudio = defaultAudio,
  createContext = defaultContext,
  storage = defaultStorage(),
  random = Math.random,
} = {}) {
  const settings = readSettings(storage);
  const subscribers = new Set();
  const rememberedBattles = new Map();
  const voices = new Set();
  let scene = { kind: 'silent', battleKey: null };
  let manifest = null;
  let loadPromise = null;
  let loadFailed = false;
  let visible = true;
  let unlocked = false;
  let disposed = false;
  let score = null;
  let scoreSrc = null;
  let scoreFailed = false;
  let scorePlaying = false;
  let scorePending = false;
  let blocked = false;
  let playGeneration = 0;
  let context = null;
  let masterGain = null;
  let clip = null;
  let clipGeneration = 0;
  let effectGeneration = 0;
  let bag = [];
  let lastBattleId = null;

  function nextBattleTrack() {
    if (!bag.length) {
      bag = [...manifest.battles];
      for (let index = bag.length - 1; index > 0; index--) {
        let value;
        try { value = random(); } catch { value = 0.5; }
        const fraction = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0.5;
        const other = Math.floor(fraction * (index + 1));
        [bag[index], bag[other]] = [bag[other], bag[index]];
      }
      if (bag.length > 1 && bag.at(-1).id === lastBattleId) {
        const other = bag.findIndex(entry => entry.id !== lastBattleId);
        [bag[bag.length - 1], bag[other]] = [bag[other], bag[bag.length - 1]];
      }
    }
    const selected = bag.pop();
    lastBattleId = selected.id;
    return selected;
  }

  function selectedTrack() {
    if (!manifest) return null;
    if (scene.kind === 'menu') return manifest.menu;
    if (scene.kind !== 'battle') return null;
    const key = scene.battleKey;
    if (!rememberedBattles.has(key)) {
      rememberedBattles.set(key, nextBattleTrack());
      if (rememberedBattles.size > MAX_REMEMBERED_BATTLES) rememberedBattles.delete(rememberedBattles.keys().next().value);
    }
    return rememberedBattles.get(key);
  }

  function mayPlayScore() {
    return !disposed && visible && unlocked && !settings.muted && settings.musicVolume > 0 && !!selectedTrack();
  }

  function mayPlayEffects() {
    return !disposed && visible && unlocked && !settings.muted && settings.effectsVolume > 0
      && (scene.kind === 'menu' || scene.kind === 'battle');
  }

  function getState() {
    const track = selectedTrack();
    let status = 'ready';
    if (disposed) status = 'paused';
    else if (loadFailed || scoreFailed) status = 'unavailable';
    else if (!manifest) status = 'loading';
    else if (!unlocked) status = 'locked';
    else if (!visible || settings.muted || settings.musicVolume === 0 || !track) status = 'paused';
    else if (blocked) status = 'blocked';
    else if (scorePlaying) status = 'playing';
    return Object.freeze({
      ...settings, unlocked, status, trackTitle: track?.title ?? '', kind: scene.kind,
      battleKey: scene.battleKey, ready: !!manifest, error: loadFailed || scoreFailed ? 'Soundtrack is unavailable.'
        : blocked ? 'Tap or press a key to enable music.' : null,
      rememberedBattleCount: rememberedBattles.size, activeEffectVoices: voices.size, disposed,
    });
  }

  function notify() {
    const state = getState();
    for (const subscriber of subscribers) {
      try { subscriber(state); } catch { /* A UI listener cannot interrupt audio cleanup. */ }
    }
  }

  function pauseScore() {
    playGeneration++;
    scorePending = false;
    scorePlaying = false;
    try { score?.pause(); } catch { /* Browser/media teardown is optional. */ }
  }

  function ensureScore() {
    if (score) return score;
    try {
      score = createAudio();
      if (!score || typeof score.play !== 'function' || typeof score.pause !== 'function') throw new Error('No audio player.');
      score.preload = 'metadata';
      score.loop = true;
      score.addEventListener?.('error', () => {
        if (disposed) return;
        pauseScore();
        scoreFailed = true;
        blocked = true;
        notify();
      });
      scoreFailed = false;
      return score;
    } catch {
      score = null;
      scoreFailed = true;
      return null;
    }
  }

  function reconcile(retry = false) {
    if (!mayPlayScore()) {
      pauseScore();
      notify();
      return Promise.resolve(false);
    }
    const audio = ensureScore();
    if (!audio) { notify(); return Promise.resolve(false); }
    const track = selectedTrack();
    audio.volume = settings.musicVolume;
    if (scoreSrc !== track.src) {
      pauseScore();
      audio.src = track.src;
      scoreSrc = track.src;
      blocked = false;
    }
    if (scorePlaying || scorePending || (blocked && !retry)) {
      notify();
      return Promise.resolve(scorePlaying);
    }
    const generation = ++playGeneration;
    scorePending = true;
    scoreFailed = false;
    blocked = false;
    let result;
    try { result = audio.play(); } catch (error) { result = Promise.reject(error); }
    return Promise.resolve(result).then(() => {
      if (generation !== playGeneration || !mayPlayScore()) {
        if (!mayPlayScore()) { try { audio.pause(); } catch { /* Safe after teardown. */ } }
        return false;
      }
      scorePending = false;
      scorePlaying = true;
      blocked = false;
      notify();
      return true;
    }, error => {
      if (generation !== playGeneration) return false;
      scorePending = false;
      scorePlaying = false;
      scoreFailed = error?.name === 'NotSupportedError' || error?.name === 'EncodingError';
      blocked = true;
      try { audio.pause(); } catch { /* Playback denial is already reflected in state. */ }
      notify();
      return false;
    });
  }

  function ensureContext() {
    if (context) return context;
    try {
      context = createContext();
      if (!context || typeof context.createGain !== 'function' || typeof context.createOscillator !== 'function') {
        context = null;
        return null;
      }
      masterGain = context.createGain();
      masterGain.gain.value = settings.effectsVolume;
      masterGain.connect(context.destination);
      return context;
    } catch {
      try { masterGain?.disconnect(); } catch { /* Optional context is unavailable. */ }
      context = null;
      masterGain = null;
      return null;
    }
  }

  function finishVoice(voice, stop = false) {
    if (!voices.delete(voice)) return;
    voice.oscillator.onended = null;
    if (stop) { try { voice.oscillator.stop(); } catch { /* It may already have ended. */ } }
    try { voice.oscillator.disconnect(); } catch { /* Safe during teardown. */ }
    try { voice.gain.disconnect(); } catch { /* Safe during teardown. */ }
  }

  function stopEffects() {
    effectGeneration++;
    clipGeneration = 0;
    for (const voice of [...voices]) finishVoice(voice, true);
    try { clip?.pause(); } catch { /* Optional clip is unavailable. */ }
    try { if (clip) clip.currentTime = 0; } catch { /* Metadata may not yet be loaded. */ }
  }

  function synthesize(name, options = {}) {
    const specification = EFFECTS[name];
    const activeContext = ensureContext();
    if (!specification || !activeContext || (activeContext.state && activeContext.state !== 'running')) return false;
    while (voices.size >= MAX_EFFECT_VOICES) finishVoice(voices.values().next().value, true);
    let oscillator;
    let gain;
    try {
      oscillator = activeContext.createOscillator();
      gain = activeContext.createGain();
      const start = activeContext.currentTime;
      const weight = name === 'swing' && ['mace', 'axe', 'greatsword', 'halberd'].includes(options.weapon) ? 0.7
        : name === 'swing' && options.weapon === 'dagger' ? 1.4 : 1;
      oscillator.type = specification.wave;
      oscillator.frequency.setValueAtTime(specification.from * weight, start);
      oscillator.frequency.exponentialRampToValueAtTime(specification.to * weight, start + specification.duration);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(specification.gain, start + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + specification.duration);
      oscillator.connect(gain);
      gain.connect(masterGain);
      const voice = { oscillator, gain };
      voices.add(voice);
      oscillator.onended = () => finishVoice(voice);
      oscillator.start(start);
      oscillator.stop(start + specification.duration + 0.02);
      return true;
    } catch {
      const voice = [...voices].find(entry => entry.oscillator === oscillator);
      if (voice) finishVoice(voice, true);
      else {
        try { oscillator?.disconnect(); } catch { /* Optional effects fail silently. */ }
        try { gain?.disconnect(); } catch { /* Optional effects fail silently. */ }
      }
      return false;
    }
  }

  function playVictory() {
    if (!manifest?.victory) return synthesize('victory');
    try {
      clip ??= createAudio();
      if (!clip || typeof clip.play !== 'function' || typeof clip.pause !== 'function') return synthesize('victory');
      clip.pause();
      clip.src = manifest.victory.src;
      clip.loop = false;
      clip.preload = 'metadata';
      clip.volume = settings.effectsVolume;
      try { clip.currentTime = 0; } catch { /* An unloaded clip begins at zero anyway. */ }
      const generation = ++effectGeneration;
      clipGeneration = generation;
      Promise.resolve(clip.play()).then(() => {
        if (generation !== effectGeneration || !mayPlayEffects()) {
          if (!mayPlayEffects() || clipGeneration === 0) { try { clip.pause(); } catch { /* Safe after teardown. */ } }
        }
      }, () => {
        if (generation === effectGeneration && mayPlayEffects()) synthesize('victory');
      });
      return true;
    } catch { return synthesize('victory'); }
  }

  function saveSettings() {
    try { storage?.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* Private browsing can deny storage. */ }
  }

  function load() {
    if (disposed) return Promise.resolve(false);
    if (loadPromise) return loadPromise;
    loadFailed = false;
    notify();
    const pending = (async () => {
      try {
        if (!MANIFEST_PATH.test(manifestUrl)) throw new Error('Invalid soundtrack manifest path.');
        const response = await fetcher(manifestUrl, { credentials: 'same-origin' });
        if (!response || response.ok === false || typeof response.json !== 'function') throw new Error('No soundtrack manifest.');
        const candidate = validateManifest(await response.json(), manifestUrl);
        if (disposed) return false;
        manifest = candidate;
        loadFailed = false;
        await reconcile();
        return true;
      } catch {
        if (disposed) return false;
        loadFailed = true;
        pauseScore();
        notify();
        return false;
      }
    })();
    loadPromise = pending;
    void pending.then(completed => {
      if (!completed && loadPromise === pending) loadPromise = null;
    });
    return pending;
  }

  function unlock() {
    if (disposed) return Promise.resolve(false);
    unlocked = true;
    const activeContext = ensureContext();
    let resumed;
    try { resumed = activeContext?.state === 'suspended' ? activeContext.resume() : undefined; }
    catch { resumed = Promise.reject(new Error('Effects blocked.')); }
    // Invoke both browser operations before awaiting either, preserving this gesture.
    const played = reconcile(true);
    // Retry a failed manifest only on an explicit load/gesture, never on rerenders.
    const loading = !manifest ? load() : Promise.resolve(false);
    return Promise.all([played, Promise.resolve(resumed).catch(() => undefined), loading])
      .then(([started, , loaded]) => started || (loaded && scorePlaying));
  }

  function setScene(next = {}) {
    if (disposed) return;
    const kind = SCENES.has(next.kind) ? next.kind : 'silent';
    const battleKey = kind === 'battle' ? String(next.battleKey ?? 'current-battle').slice(0, 200) : null;
    scene = { kind, battleKey };
    if (!mayPlayEffects()) stopEffects();
    void reconcile();
  }

  function setMuted(value) {
    if (disposed) return;
    settings.muted = !!value;
    saveSettings();
    if (settings.muted) stopEffects();
    void reconcile();
  }

  function setMusicVolume(value) {
    const volume = boundedVolume(value);
    if (disposed || volume === null) return;
    settings.musicVolume = volume;
    if (score) score.volume = volume;
    saveSettings();
    void reconcile();
  }

  function setEffectsVolume(value) {
    const volume = boundedVolume(value);
    if (disposed || volume === null) return;
    settings.effectsVolume = volume;
    if (masterGain) masterGain.gain.value = volume;
    if (clip) clip.volume = volume;
    if (volume === 0) stopEffects();
    saveSettings();
    notify();
  }

  function setVisible(value) {
    if (disposed) return;
    visible = !!value;
    if (!visible) stopEffects();
    void reconcile();
  }

  function playEffect(name, options) {
    if (!mayPlayEffects() || !Object.hasOwn(EFFECTS, name)) return false;
    return name === 'victory' ? playVictory() : synthesize(name, options);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    if (!disposed) subscribers.add(listener);
    try { listener(getState()); } catch { /* A UI listener cannot interrupt initialization. */ }
    return () => subscribers.delete(listener);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    pauseScore();
    stopEffects();
    for (const audio of [score, clip]) {
      try { audio?.removeAttribute?.('src'); audio?.load?.(); } catch { /* Release browser-owned media when available. */ }
    }
    try { masterGain?.disconnect(); } catch { /* Safe after a lost context. */ }
    try { Promise.resolve(context?.close?.()).catch(() => undefined); } catch { /* An already closed context is harmless. */ }
    notify();
    subscribers.clear();
  }

  return Object.freeze({ load, unlock, setScene, playEffect, setMuted, setMusicVolume, setEffectsVolume,
    getState, subscribe, setVisible, stopEffects, dispose });
}
