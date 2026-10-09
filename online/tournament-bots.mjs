import { randomInt, randomUUID } from 'node:crypto';
import { normalizePresetAppearance } from '../src/face-presets.js';
import { BOT_STYLES } from '../src/combat.js';

export const LOBBY_BOT_INTERVAL_MS = 20000;
export const BOT_ACTION_DELAY_MS = 3000;

// Fictional names inspired by Roman gladiators; never guest accounts.
const NAMES = [
  'Lucius Ferox', 'Titus Corvinus', 'Gaius Vindex', 'Marcus Aegis',
  'Aulus Drusus', 'Decimus Lupus', 'Quintus Falcus', 'Cassius Silvanus',
  'Aelia Bellona', 'Sabina Falco', 'Livia Valeria', 'Flavia Aquila',
  'Aurelia Nerva', 'Cassia Vindex', 'Octavia Ferox', 'Marcia Corvina',
];
const BUILDS = [
  { stats: [5, 5, 4, 4, 2], trait: 'balanced' },
  { stats: [3, 6, 6, 3, 2], trait: 'fleetfoot' },
  { stats: [8, 2, 2, 6, 2], trait: 'relentless' },
  { stats: [6, 4, 2, 6, 2], trait: 'steadfast' },
  { stats: [3, 6, 3, 2, 6], trait: 'specialist' },
  { stats: [4, 4, 4, 4, 4], trait: 'efficient' },
];
const SKINS = ['porcelain', 'ivory', 'sand', 'copper', 'umber', 'ebony'];
const HAIR = ['raven', 'chestnut', 'auburn', 'ashen', 'silver', 'wheat'];
const BANNERS = ['#ad5944', '#5f8793', '#7c895b', '#99749b', '#b38b4c', '#687b9e'];
const pick = values => values[randomInt(values.length)];

export function createTournamentBot(players) {
  const taken = new Set(players.map(player => player.character.name.trim().toLowerCase()));
  const available = NAMES.filter(name => !taken.has(name.toLowerCase()));
  const name = pick(available);
  const build = pick(BUILDS);
  const sex = NAMES.indexOf(name) < 8 ? 'male' : 'female';
  const facePreset = `p${String(randomInt(1, 11)).padStart(2, '0')}`;
  return {
    playerId: `bot:${randomUUID()}`,
    profile: {
      bot: true, botStyle: pick(Object.keys(BOT_STYLES)), alive: true, duelWins: 0, tournamentWins: 0,
      character: {
        id: randomUUID(), name, trait: build.trait, color: pick(BANNERS),
        stats: Object.fromEntries(['strength', 'dexterity', 'speed', 'defense', 'intelligence'].map((key, index) => [key, build.stats[index]])),
        appearance: normalizePresetAppearance({ sex, facePreset, skin: pick(SKINS), hairColor: pick(HAIR) }),
      },
    },
  };
}

export function chooseTournamentBotLoadout(character) {
  const { strength, dexterity, speed } = character.stats;
  const weapon = strength >= 6 ? pick(['axe', 'greatsword', 'halberd']) : dexterity > strength ? pick(['sword', 'spear', 'dagger', 'trident']) : pick(['sword', 'flail', 'trident']);
  return { weapon, armor: speed >= 6 ? 'light' : character.stats.defense >= 6 ? 'heavy' : 'medium', helmet: 'none' };
}
