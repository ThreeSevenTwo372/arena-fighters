const percent = value => Math.round(value * 100);
const text = (node, value) => { if (node.textContent !== value) node.textContent = value; };

/** This panel lives outside the game render tree, so sliders retain focus and position. */
export function mountAudioControls(host, audio) {
  if (!host || !audio) return () => {};
  host.innerHTML = `<div class="audio-bar"><button type="button" class="audio-toggle" data-audio-toggle aria-pressed="false">Enable sound</button><details class="audio-options"><summary>Sound options</summary><div class="audio-settings"><label for="arena-music-volume">Music <output data-audio-music-value>35%</output></label><input id="arena-music-volume" data-audio-volume="music" type="range" min="0" max="100" step="1" value="35"><label for="arena-effects-volume">Effects <output data-audio-effects-value>50%</output></label><input id="arena-effects-volume" data-audio-volume="effects" type="range" min="0" max="100" step="1" value="50"><p class="audio-status" data-audio-status role="status" aria-live="polite">Sound starts when you interact.</p><p class="audio-now-playing" data-audio-track></p></div></details></div>`;
  const toggle = host.querySelector('[data-audio-toggle]');
  const music = host.querySelector('[data-audio-volume="music"]');
  const effects = host.querySelector('[data-audio-volume="effects"]');
  const status = host.querySelector('[data-audio-status]');
  const track = host.querySelector('[data-audio-track]');
  const update = state => {
    const needsGesture = !state.unlocked || ['blocked', 'unavailable'].includes(state.status);
    text(toggle, state.muted ? 'Unmute' : state.status === 'unavailable' ? 'Retry sound' : needsGesture ? 'Enable sound' : 'Mute');
    toggle.setAttribute('aria-pressed', String(state.unlocked && !state.muted));
    toggle.setAttribute('aria-label', state.muted ? 'Unmute game sound' : state.status === 'unavailable' ? 'Retry game sound' : needsGesture ? 'Enable game sound' : 'Mute game sound');
    if (host.ownerDocument?.activeElement !== music) music.value = String(percent(state.musicVolume));
    if (host.ownerDocument?.activeElement !== effects) effects.value = String(percent(state.effectsVolume));
    text(host.querySelector('[data-audio-music-value]'), `${percent(state.musicVolume)}%`);
    text(host.querySelector('[data-audio-effects-value]'), `${percent(state.effectsVolume)}%`);
    text(status, state.status === 'unavailable' ? 'Music could not load. You can keep playing.'
      : state.muted ? 'Sound muted.' : state.status === 'blocked' ? 'Select Enable sound to start playback.'
        : !state.unlocked ? 'Sound starts when you interact.' : state.kind === 'cinematic' ? 'The arrival plays in silence.'
          : state.status === 'playing' ? 'Game sound on.' : 'Sound ready.');
    text(track, state.trackTitle && state.kind !== 'cinematic' && state.kind !== 'silent' ? `Music: ${state.trackTitle}` : '');
  };
  const unsubscribe = audio.subscribe(update);
  const onClick = event => {
    if (!event.target.closest('[data-audio-toggle]')) return;
    const state = audio.getState();
    if (state.muted || !state.unlocked || ['blocked', 'unavailable'].includes(state.status)) {
      audio.setMuted(false);
      void audio.unlock();
    } else audio.setMuted(true);
  };
  const onInput = event => {
    const kind = event.target.dataset?.audioVolume;
    if (!['music', 'effects'].includes(kind)) return;
    const value = Number(event.target.value) / 100;
    if (!Number.isFinite(value)) return;
    if (kind === 'music') audio.setMusicVolume(value); else audio.setEffectsVolume(value);
  };
  host.addEventListener('click', onClick);
  host.addEventListener('input', onInput);
  return () => {
    unsubscribe();
    host.removeEventListener('click', onClick);
    host.removeEventListener('input', onInput);
  };
}
