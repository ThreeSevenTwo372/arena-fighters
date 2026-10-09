/** The preserved Flux flight is played once in each browser tab before creation. */
export const ARRIVAL_SEEN_KEY = 'arena-fighters.arrival-v001.seen';
export const ARRIVAL_VIDEO = '/public/cinematics/arrival-v001/sky-to-arena.mp4';
export const ARRIVAL_POSTER = '/public/cinematics/arrival-v001/poster.jpg';
export const ARRIVAL_STILL = '/public/cinematics/arrival-v001/arena-still.jpg';

let seenWithoutStorage = false;

export function isArrivalReview(search = '') {
  const params = new URLSearchParams(search);
  return params.get('face-presets-review') === '1' || params.get('spectator-frame-review') === '1';
}

/** Dependency overrides allow testing real completion and blocked-play behavior. */
export function createArrivalController(options = {}) {
  const browser = options.window ?? globalThis.window;
  const search = options.search ?? browser?.location?.search ?? '';
  const onComplete = options.onComplete ?? (() => {});
  let storage;
  try { storage = options.storage ?? browser?.sessionStorage; } catch { /* Private browsing can deny storage. */ }
  const motionPreference = options.reducedMotion ?? browser?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let host, video, previousFocus, complete = false, disposed = false, active = false, reduced = motionPreference;
  let attempt = 0;
  const listeners = [];
  const listen = (element, name, handler) => {
    element.addEventListener(name, handler);
    listeners.push(() => element.removeEventListener(name, handler));
  };
  const hasSeen = () => {
    try { return storage ? storage.getItem(ARRIVAL_SEEN_KEY) === '1' : seenWithoutStorage; }
    catch { return seenWithoutStorage; }
  };
  const remember = () => {
    seenWithoutStorage = true;
    try { storage?.setItem(ARRIVAL_SEEN_KEY, '1'); } catch { /* The intro still works without storage. */ }
  };
  function cleanup() {
    attempt += 1;
    for (const remove of listeners.splice(0)) remove();
    video?.pause();
    // Removing the source and calling load releases an in-flight media request.
    video?.removeAttribute('src');
    video?.load();
    video = undefined;
    active = false;
  }
  function finish(reason) {
    if (!active || complete || disposed) return;
    complete = true;
    remember();
    cleanup();
    host?.classList.remove('arrival-active');
    onComplete({ reason });
  }
  function setState(state) {
    if (!active) return;
    const scene = host.querySelector('.arrival-screen');
    scene.dataset.state = state;
    const start = host.querySelector('[data-arrival="play"]');
    const enter = host.querySelector('[data-arrival="enter"]');
    const status = host.querySelector('.arrival-status');
    start.hidden = state !== 'blocked' && state !== 'reduced';
    enter.hidden = state !== 'error' && state !== 'reduced';
    start.textContent = state === 'reduced' ? 'Watch the arrival' : 'Begin the journey';
    status.textContent = state === 'error' ? 'The arena awaits.' : state === 'reduced' ? 'The arena awaits.' : state === 'blocked' ? 'Begin your journey to the arena.' : '';
    if (state === 'blocked') start.focus({ preventScroll: true });
  }
  async function play() {
    if (!active || !video) return;
    reduced = false;
    host.querySelector('.arrival-screen').classList.remove('arrival-reduced');
    video.poster = ARRIVAL_POSTER;
    video.src = ARRIVAL_VIDEO;
    setState('loading');
    const currentAttempt = ++attempt;
    try {
      await video.play();
      if (active && currentAttempt === attempt) setState('playing');
    } catch {
      if (active && currentAttempt === attempt) setState('blocked');
    }
  }
  function mount(target, force = false) {
    if (!target || active || (!force && !controller.shouldShow()) || isArrivalReview(search)) return false;
    disposed = false;
    complete = false;
    reduced = motionPreference;
    host = target;
    previousFocus = browser?.document?.activeElement;
    host.classList.add('arrival-active');
    host.innerHTML = `<main class="arrival-screen${reduced ? ' arrival-reduced' : ''}" aria-label="Arrival at the arena" data-state="${reduced ? 'reduced' : 'loading'}">
      <video class="arrival-video" poster="${reduced ? ARRIVAL_STILL : ARRIVAL_POSTER}" muted playsinline preload="${reduced ? 'none' : 'auto'}" aria-label="A flight over the city and through its gates into the arena"${reduced ? '' : ` src="${ARRIVAL_VIDEO}"`}></video>
      <div class="arrival-shade" aria-hidden="true"></div>
      <header class="arrival-header"><span class="arrival-wordmark">Arena Fighters</span><button type="button" class="arrival-skip" data-arrival="skip">Skip intro <span aria-hidden="true">→</span></button></header>
      <section class="arrival-invitation" aria-label="Journey controls"><p class="arrival-status" role="status">${reduced ? 'The arena awaits.' : ''}</p><div class="arrival-buttons"><button type="button" class="arrival-enter" data-arrival="enter"${reduced ? '' : ' hidden'}>Enter the arena <span aria-hidden="true">→</span></button><button type="button" class="arrival-play" data-arrival="play"${reduced ? '' : ' hidden'}>${reduced ? 'Watch the arrival' : 'Begin the journey'}</button></div></section>
    </main>`;
    video = host.querySelector('.arrival-video');
    // Set properties as well as attributes: muted autoplay must be established before play().
    video.muted = true;
    video.playsInline = true;
    active = true;
    listen(video, 'ended', () => finish('ended'));
    listen(video, 'error', () => setState('error'));
    listen(host.querySelector('[data-arrival="skip"]'), 'click', () => finish('skip'));
    listen(host.querySelector('[data-arrival="enter"]'), 'click', () => finish(reduced ? 'reduced-motion' : 'media-error'));
    listen(host.querySelector('[data-arrival="play"]'), 'click', play);
    listen(host, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); finish('skip'); } });
    host.querySelector('[data-arrival="skip"]').focus({ preventScroll: true });
    if (!reduced) void play();
    return true;
  }
  const controller = {
    shouldShow: () => !active && !isArrivalReview(search) && !hasSeen(),
    mount,
    replay: target => mount(target, true),
    get active() { return active; },
    dispose() {
      disposed = true;
      cleanup();
      host?.classList.remove('arrival-active');
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    },
  };
  return controller;
}
