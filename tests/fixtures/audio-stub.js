// Historical app harnesses replace browser/media boundaries while exercising gameplay.
export const audioBindings = {
  createGameAudio: () => ({
    setScene() {}, setVisible() {}, stopEffects() {}, dispose() {}, playEffect() {},
    setMuted() {}, setMusicVolume() {}, setEffectsVolume() {}, load: async () => {},
    unlock: async () => {},
    startMusic: async () => {},
    getState: () => ({ muted: false, musicVolume: .45, effectsVolume: .65, unlocked: false, status: 'ready', trackTitle: '', kind: 'menu' }),
    subscribe: () => () => {},
  }),
  mountAudioControls: () => () => {},
};
