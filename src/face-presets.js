// Complete arena identities replace interchangeable face / hair controls.
// Keep the original fields in saved recipes so legacy characters remain portable.
import { normalizeAppearance } from './avatar.js';

const DEFINITIONS = [
  ['p01', 'Tousled', 'Tousled hair and a steady, serious gaze.', 'shag'],
  ['p02', 'Side swept', 'Swept hair and a reserved expression.', 'short_swept'],
  ['p03', 'Close cropped', 'Cropped hair and a battle-ready face.', 'cropped'],
  ['p04', 'Shaved', 'A shaved head with clear, stern features.', 'none'],
  ['p05', 'Braided', 'A gathered braid and a focused gaze.', 'braided_ponytail'],
  ['p06', 'High tied', 'A high ponytail and a determined expression.', 'high_ponytail'],
  ['p07', 'Center parted', 'Parted hair and a solemn face.', 'center_part_medium'],
  ['p08', 'Slicked back', 'An undercut with swept-back hair.', 'swept_back_undercut'],
  ['p09', 'Long loose', 'Loose shoulder-length hair and a quiet gaze.', 'shoulder_length_loose'],
  ['p10', 'Veteran', 'An experienced fighter with weathered features.', 'shag'],
];

const PRESETS = Object.freeze(DEFINITIONS.map(([id, label, description, legacyHairstyle]) => Object.freeze({ id, label, description, legacyHairstyle })));
const IDS = new Set(PRESETS.map(preset => preset.id));
const LEGACY_IDS = new Map(PRESETS.slice(0, 9).map(preset => [preset.legacyHairstyle, preset.id]));

// Indexes deliberately match across sexes: changing sex retains the choice.
export function facePresetChoices(sex = 'male') {
  return PRESETS;
}

export function normalizePresetAppearance(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) value = {};
  const appearance = normalizeAppearance(value);
  const hasLegacyHair = ['hairstyle', 'hairStyle', 'hair'].some(field => Object.hasOwn(value, field));
  const facePreset = Object.hasOwn(value, 'facePreset')
    ? (IDS.has(value.facePreset) ? value.facePreset : 'p01')
    : hasLegacyHair ? LEGACY_IDS.get(appearance.hairstyle) ?? 'p01' : 'p01';
  return { ...appearance, facePreset };
}

export function presetAppearanceSignature(value) {
  const appearance = normalizePresetAppearance(value);
  return [appearance.sex, appearance.facePreset, appearance.skin, appearance.hairColor, appearance.eyes].join('/');
}
