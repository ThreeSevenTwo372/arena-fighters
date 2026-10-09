// The current game admits v013 presets without rewriting surviving v006 recipes.
// Isolated renderer instances keep their catalogs and render caches independent.
import * as preset from './arena-avatar.js?current-presets-v013';
import * as legacy from './arena-avatar.js?current-legacy-v006';

const CURRENT_CATALOG = '/assets/clean-gladiator/v013/manifest.json';
const LEGACY_CATALOG = '/assets/clean-gladiator/v006/manifest.json';
const EQUIPMENT_CATALOG = '/assets/clean-gladiator/v015-equipment/manifest.json';
let sourceConfig = { equipmentManifestUrl: EQUIPMENT_CATALOG };
const hasPreset = appearance => typeof appearance?.facePreset === 'string' && /^p(?:0[1-9]|10)$/.test(appearance.facePreset);
const rendererFor = appearance => hasPreset(appearance) ? preset : legacy;

export async function preloadCleanArt(config = {}) {
  sourceConfig = { ...sourceConfig, ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }) };
  return preset.preloadCleanArt({ ...sourceConfig, manifestUrl: CURRENT_CATALOG });
}

export async function prepareCleanAvatar(appearance, kind = 'battle', loadout = {}) {
  const renderer = rendererFor(appearance);
  await renderer.preloadCleanArt({ ...sourceConfig, manifestUrl: hasPreset(appearance) ? CURRENT_CATALOG : LEGACY_CATALOG });
  return renderer.prepareCleanAvatar(appearance, kind, loadout);
}

export function getCleanAvatarImage(appearance, kind = 'battle', loadout = {}) {
  return rendererFor(appearance).getCleanAvatarImage(appearance, kind, loadout);
}

export function renderCleanAvatar(appearance, kind = 'world', loadout = {}, config = {}) {
  return rendererFor(appearance).renderCleanAvatar(appearance, kind, loadout, config);
}

export function getCleanArtDiagnostics() {
  const current = preset.getCleanArtDiagnostics(), preserved = legacy.getCleanArtDiagnostics();
  return {
    loaded: current.loaded || preserved.loaded,
    textures: current.textures + preserved.textures,
    textureBytes: current.textureBytes + preserved.textureBytes,
    renders: current.renders + preserved.renders,
    pendingRenders: current.pendingRenders + preserved.pendingRenders,
    current, legacy: preserved,
  };
}
