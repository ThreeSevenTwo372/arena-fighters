/** Deterministic, shared duel rules. These numbers are prototype tuning values. */
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export const RULES = freeze({
  VERSION: 3,
  POINT_BUDGET: 20,
  STAT_CAP: 8,
  MAX_ROUNDS: 24,
  TURN_SECONDS: 20,
  BASE_HP: 90,
  HP_PER_DEFENSE: 2,
  BASE_STAMINA: 14,
  TECHNIQUE_PER_INTELLIGENCE: 0.25,
  MIN_STRIKE_COST: 2,
  MIN_TECHNIQUE_COST: 3,
  GUARD_COST: 2,
  GUARD_REDUCTION: 0.65,
  description: 'Choose secretly, reveal together. Priority acts first, then speed. Equal speed alternates its first player each round. At 24 rounds, remaining health percentage, then stamina percentage decides; an exact tie is a draw.',
});

export const ATTRIBUTE_LABELS = freeze({ strength: 'Strength', dexterity: 'Dexterity', speed: 'Speed', defense: 'Defense', intelligence: 'Intelligence' });
export const ATTRIBUTE_HELP = freeze({
  strength: 'Stronger ordinary strikes, especially with heavy weapons; easier heavy weapon handling.',
  dexterity: 'More precise strikes and techniques, especially with swords and spears.',
  speed: 'Higher initiative when actions have equal priority; +2 stamina recovery per 4 Speed.',
  defense: 'More health, personal protection, and stronger armor protection.',
  intelligence: 'Efficient physical techniques and a small, deterministic fortune bonus to attack, initiative, health, stamina, recovery, and protection.',
});

export const WEAPONS = freeze({
  sword: {
    name: 'Sword',
    description: 'Strength and Dexterity share strike power. Dexterity favors a precise feint that slips through guarding.',
    scaling: { strength: 1, dexterity: 1 }, heavyHandling: false,
    attack: 9, speedBonus: 0, strikeCost: 3,
    technique: { name: 'Feint', description: 'Ignores Guard and half of armor protection. Favors Dexterity, with Strength and Intelligence support.', scaling: { strength: 0.5, dexterity: 1.5 }, cost: 4, priority: 0, multiplier: 0.75, ignoresGuard: true, armorFactor: 0.5 },
  },
  spear: {
    name: 'Spear',
    description: 'Dexterity favors its strikes and techniques. Quick initiative; its thrust acts before ordinary attacks, but Guard stops it.',
    scaling: { strength: 0.75, dexterity: 1.25 }, heavyHandling: false,
    attack: 8, speedBonus: 1, strikeCost: 3,
    technique: { name: 'Quick Thrust', description: 'Higher priority than Strike. Favors Dexterity, with Strength and Intelligence support. Guard still blocks it.', scaling: { strength: 0.5, dexterity: 1.5 }, cost: 4, priority: 1, multiplier: 0.75, ignoresGuard: false, armorFactor: 1 },
  },
  axe: {
    name: 'Axe',
    description: 'Strength favors heavy strikes and handling. A slow, costly guard breaker rewards predicting defense.',
    scaling: { strength: 1.5, dexterity: 0.5 }, heavyHandling: true,
    attack: 12, speedBonus: -2, strikeCost: 4,
    technique: { name: 'Guard Break', description: 'Ignores Guard. Strength and Dexterity share power, with Intelligence support. Acts after ordinary attacks and costs more stamina.', scaling: { strength: 1, dexterity: 1 }, cost: 7, priority: -1, multiplier: 1.1, ignoresGuard: true, armorFactor: 1 },
  },
  flail: {
    name: 'Flail',
    description: 'Strength favors strikes; Dexterity favors the sweep. Heavy handling and a swinging head trade stamina and initiative for guard pressure.',
    scaling: { strength: 1.25, dexterity: 0.75 }, heavyHandling: true,
    attack: 11, speedBonus: -1, strikeCost: 4,
    technique: { name: 'Chain Sweep', description: 'Sweep around Guard at ordinary priority. Favors Dexterity, with Strength and Intelligence support. Armor still protects the target; costs more than a sword feint.', scaling: { strength: 0.75, dexterity: 1.25 }, cost: 6, priority: 0, multiplier: 1, ignoresGuard: true, armorFactor: 1 },
  },
  halberd: {
    name: 'Halberd',
    description: 'Strength favors strikes and heavy handling. A hooked blade pressures armor; its committed technique is slow and can be guarded.',
    scaling: { strength: 1.25, dexterity: 0.75 }, heavyHandling: true,
    attack: 11, speedBonus: -1, strikeCost: 4,
    technique: { name: 'Hook Thrust', description: 'Leaves one quarter of armor protection effective. Strength and Dexterity share power, with Intelligence support. Acts after ordinary attacks; Guard reduces it.', scaling: { strength: 1, dexterity: 1 }, cost: 5, priority: -1, multiplier: 0.9, ignoresGuard: false, armorFactor: 0.25 },
  },
  mace: {
    name: 'Mace',
    description: 'Strength favors deliberate blows and heavy handling. Armor Crush ignores armor, but a readied guard absorbs it.',
    scaling: { strength: 1.5, dexterity: 0.5 }, heavyHandling: true,
    attack: 10, speedBonus: -2, strikeCost: 3,
    technique: { name: 'Armor Crush', description: 'Ignores armor protection completely; personal Defense still protects. Strength and Dexterity share power, with Intelligence support. Acts after ordinary attacks; Guard reduces it.', scaling: { strength: 1, dexterity: 1 }, cost: 5, priority: -1, multiplier: 0.8, ignoresGuard: false, armorFactor: 0 },
  },
  greatsword: {
    name: 'Greatsword',
    description: 'Strength strongly favors strikes and heavy handling. Low initiative and high stamina costs balance its power; Guard counters its arc.',
    scaling: { strength: 1.75, dexterity: 0.25 }, heavyHandling: true,
    attack: 14, speedBonus: -4, strikeCost: 5,
    technique: { name: 'Cleaving Arc', description: 'Ignores half of armor protection. Favors Strength, with Dexterity and Intelligence support. Acts after ordinary attacks and drains stamina; Guard reduces it.', scaling: { strength: 1.25, dexterity: 0.75 }, cost: 8, priority: -1, multiplier: 1.1, ignoresGuard: false, armorFactor: 0.5 },
  },
  dagger: {
    name: 'Dagger',
    description: 'Dexterity favors quick, lighter strikes. Riposte rewards predicting an ordinary Strike; techniques, Guard and Recover counter the stance.',
    scaling: { strength: 0.5, dexterity: 1.5 }, heavyHandling: false,
    attack: 7, speedBonus: 2, strikeCost: 3,
    technique: { name: 'Riposte', description: 'Ready a counter before attacks. Halve an ordinary Strike, then counter once if you survive. Weapon Techniques bypass the stance; Guard, Recover and another Riposte cause no counter. Enemy armor protects fully. Pay stamina even when it misses.', scaling: { strength: 0.5, dexterity: 1.5 }, cost: 5, priority: 2, multiplier: 1, ignoresGuard: false, armorFactor: 1, conditional: 'riposte', trigger: 'strike', reduction: 0.5 },
  },
  trident: {
    name: 'Trident & Net',
    description: 'Dexterity favors trident strikes. Entangle trades damage for a brief stamina tax; Guard or Recover counters its net.',
    scaling: { strength: 0.75, dexterity: 1.25 }, heavyHandling: false,
    attack: 9, speedBonus: 0, strikeCost: 4,
    technique: { name: 'Entangle', description: 'Deal light damage and net a surviving rival: Strike and Technique cost +3 stamina next round only. Guard prevents the net and clears it; Recover clears it. Full armor protects, and Guard reduces damage. Nets never stack.', scaling: { strength: 0.25, dexterity: 0.5 }, cost: 6, priority: 0, multiplier: 0.25, ignoresGuard: false, armorFactor: 1, statusEffect: 'entangle', attackSurcharge: 3 },
  },
});

/** Public bot approaches have no stat bonuses and never receive secret commitments. */
export const BOT_STYLES = freeze({
  aggressive: { label: 'Aggressive', description: 'Keeps pressure and spends stamina for damage.' },
  cautious: { label: 'Cautious', description: 'Mixes protection with attacks and watches its stamina.' },
  patient: { label: 'Patient', description: 'Keeps a stamina reserve and responds to revealed habits.' },
});

export const ARMORS = freeze({
  light: { name: 'Light Armor', description: 'No armor protection or speed penalty. Base recovery 8; Speed and Intelligence improve it. Personal Defense still protects.', mitigation: 0, defenseScaling: 0, speedPenalty: 0, attackSurcharge: 0, recovery: 8 },
  medium: { name: 'Medium Armor', description: 'Blocks 2 plus 1 damage per 4 Defense; costs 2 initiative. Base recovery 7, improved by Speed and Intelligence.', mitigation: 2, defenseScaling: 0.25, speedPenalty: 2, attackSurcharge: 0, recovery: 7 },
  heavy: { name: 'Heavy Armor', description: 'Blocks 4 plus 1 damage per 2 Defense; costs 4 initiative and 1 stamina per attack. Base recovery 6, improved by Speed and Intelligence.', mitigation: 4, defenseScaling: 0.5, speedPenalty: 4, attackSurcharge: 1, recovery: 6 },
});

/** Helmets are cosmetic loadout choices; their protection is included in the armor choice. */
export const HELMETS = freeze({
  none: { name: 'No Helmet', description: 'Show the gladiator’s hair and face. This cosmetic choice has no combat effect.' },
  closed_bascinet: { name: 'Closed Bascinet', description: 'A pointed steel helm with a closed visor that conceals the hair and face. Cosmetic; no stat changes.' },
  barbute: { name: 'Visored Barbute', description: 'A rounded enclosed helm with deep cheek plates and a narrow visor. Conceals the hair and face; no stat changes.' },
  greathelm: { name: 'Greathelm', description: 'A heavy, fully enclosed steel helm with narrow eye slits. Conceals the hair and face; no stat changes.' },
});

const creationTrait = (name, description, modifiers) => ({
  name, description, hpBonus: 0, staminaBonus: 0, attackBonus: 0, speedBonus: 0,
  strikeBonus: 0, techniqueBonus: 0, protectionBonus: 0, recoveryBonus: 0,
  strikeCostBonus: 0, techniqueCostBonus: 0, ...modifiers,
});

export const TRAITS = freeze({
  // These three IDs retain their original effects for surviving fighters.
  balanced: creationTrait('Measured', 'Maximum stamina +2.', { staminaBonus: 2 }),
  relentless: creationTrait('Relentless', 'Attack power +2; maximum stamina -2.', { staminaBonus: -2, attackBonus: 2 }),
  steadfast: creationTrait('Steadfast', 'Maximum health +6; initiative -1.', { hpBonus: 6, speedBonus: -1 }),
  berserker: creationTrait('Berserker', 'Attack power +4; maximum health -10; attack costs +1.', { hpBonus: -10, attackBonus: 4, strikeCostBonus: 1, techniqueCostBonus: 1 }),
  fleetfoot: creationTrait('Fleetfoot', 'Initiative +4; maximum health -8.', { hpBonus: -8, speedBonus: 4 }),
  ironhide: creationTrait('Ironhide', 'Personal protection +2; initiative -3; stamina recovery -2.', { protectionBonus: 2, speedBonus: -3, recoveryBonus: -2 }),
  vigorous: creationTrait('Vigorous', 'Maximum stamina +5; stamina recovery +2; attack power -2.', { staminaBonus: 5, recoveryBonus: 2, attackBonus: -2 }),
  brawler: creationTrait('Brawler', 'Strike power +4; Strike cost +1; technique power -3.', { strikeBonus: 4, strikeCostBonus: 1, techniqueBonus: -3 }),
  specialist: creationTrait('Specialist', 'Technique power +4; technique cost +1; Strike power -3.', { strikeBonus: -3, techniqueBonus: 4, techniqueCostBonus: 1 }),
  efficient: creationTrait('Efficient', 'Attack costs -1; attack power -2. Minimum costs still apply.', { attackBonus: -2, strikeCostBonus: -1, techniqueCostBonus: -1 }),
});

const has = (object, key) => typeof key === 'string' && Object.hasOwn(object, key);
const copy = (value) => structuredClone(value);

export function validateCharacter(character) {
  const errors = [];
  if (!character || typeof character !== 'object' || Array.isArray(character)) return { valid: false, errors: ['A character is required.'] };
  if (typeof character.name !== 'string' || character.name.trim().length < 1 || character.name.trim().length > 24) errors.push('Name must contain 1 to 24 characters.');
  const stats = character.stats;
  let total = 0;
  let legalStats = !!stats && typeof stats === 'object' && !Array.isArray(stats);
  if (legalStats && Object.keys(stats).some(key => !has(ATTRIBUTE_LABELS, key))) errors.push('Choose only Strength, Dexterity, Speed, Defense, and Intelligence.');
  for (const key of Object.keys(ATTRIBUTE_LABELS)) {
    const value = stats?.[key];
    if (!Number.isInteger(value) || value < 0 || value > RULES.STAT_CAP) {
      errors.push(`${key} must be a whole number from 0 to ${RULES.STAT_CAP}.`);
      legalStats = false;
    } else total += value;
  }
  if (legalStats && total !== RULES.POINT_BUDGET) errors.push(`Allocate exactly ${RULES.POINT_BUDGET} attribute points.`);
  if (!has(TRAITS, character.trait)) errors.push('Choose one valid creation trait.');
  if (character.color !== undefined && (typeof character.color !== 'string' || !/^#[\da-f]{6}$/i.test(character.color))) errors.push('Character color must be a six digit hex color.');
  return { valid: errors.length === 0, errors };
}

/** Public equipment preview and the exact derived values used by the shared rules. */
export function deriveFighterStats(character, loadout) {
  const check = validateCharacter(character);
  if (!check.valid) throw new Error(check.errors.join(' '));
  if (!has(WEAPONS, loadout?.weapon)) throw new Error('Choose a valid weapon.');
  if (!has(ARMORS, loadout?.armor)) throw new Error('Choose valid armor.');
  if (!has(HELMETS, loadout?.helmet ?? 'none')) throw new Error('Choose a valid helmet.');
  const { strength, dexterity, speed, defense, intelligence } = character.stats;
  const weapon = WEAPONS[loadout.weapon];
  const armor = ARMORS[loadout.armor];
  const trait = TRAITS[character.trait];
  const handlingSpeed = weapon.heavyHandling ? Math.min(-weapon.speedBonus, Math.floor(strength / 4)) : 0;
  const handlingDiscount = weapon.heavyHandling && strength >= 6 ? 1 : 0;
  const tacticalDiscount = Math.floor(intelligence / 6);
  // Fortune is visible and deterministic: no hidden rolls or random misses.
  const fortuneBonus = Math.floor(intelligence / 6);
  const personalProtection = Math.max(0, Math.floor(defense / 4) + fortuneBonus + trait.protectionBonus);
  const armorProtection = armor.mitigation + Math.floor(defense * armor.defenseScaling);
  // Traits change the payable cost after attribute discounts. A Berserker
  // always pays its extra point; Efficient can never pass the action floor.
  const strikeCost = Math.max(RULES.MIN_STRIKE_COST, weapon.strikeCost + armor.attackSurcharge - handlingDiscount - tacticalDiscount);
  const techniqueCost = Math.max(RULES.MIN_TECHNIQUE_COST, weapon.technique.cost + armor.attackSurcharge - handlingDiscount - tacticalDiscount);
  return freeze({
    fortuneBonus,
    maxHp: RULES.BASE_HP + RULES.HP_PER_DEFENSE * defense + fortuneBonus + trait.hpBonus,
    maxStamina: RULES.BASE_STAMINA + fortuneBonus + trait.staminaBonus,
    speed: speed * 2 + weapon.speedBonus + handlingSpeed + fortuneBonus - armor.speedPenalty + trait.speedBonus,
    personalProtection, armorProtection, mitigation: personalProtection + armorProtection,
    strikeCost: Math.max(RULES.MIN_STRIKE_COST, strikeCost + trait.strikeCostBonus),
    techniqueCost: Math.max(RULES.MIN_TECHNIQUE_COST, techniqueCost + trait.techniqueCostBonus),
    recovery: Math.max(1, armor.recovery + fortuneBonus + trait.recoveryBonus + 2 * Math.floor(speed / 4)),
    strikePower: Math.max(1, weapon.attack + Math.floor(strength * weapon.scaling.strength + dexterity * weapon.scaling.dexterity) + fortuneBonus + trait.attackBonus + trait.strikeBonus),
    techniquePower: Math.max(1, Math.floor(weapon.attack * weapon.technique.multiplier + strength * weapon.technique.scaling.strength + dexterity * weapon.technique.scaling.dexterity + intelligence * RULES.TECHNIQUE_PER_INTELLIGENCE) + fortuneBonus + trait.attackBonus + trait.techniqueBonus),
  });
}

/** Entries are {character, weapon: a WEAPONS key, armor: an ARMORS key, helmet?: a cosmetic HELMETS key}. */
export function createDuel(entries, { maxRounds = RULES.MAX_ROUNDS } = {}) {
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error('A duel requires exactly two gladiators.');
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > RULES.MAX_ROUNDS) throw new Error(`The round limit must be from 1 to ${RULES.MAX_ROUNDS}.`);
  const fighters = entries.map((entry, index) => {
    const check = validateCharacter(entry?.character);
    if (!check.valid) throw new Error(check.errors.join(' '));
    if (!has(WEAPONS, entry.weapon)) throw new Error('Choose a valid weapon.');
    if (!has(ARMORS, entry.armor)) throw new Error('Choose valid armor.');
    const helmet = entry.helmet ?? 'none';
    if (!has(HELMETS, helmet)) throw new Error('Choose a valid helmet.');
    const character = copy(entry.character);
    character.name = character.name.trim();
    const derived = deriveFighterStats(character, entry);
    return {
      id: `p${index + 1}`, character, weapon: entry.weapon, armor: entry.armor, helmet,
      ...derived, hp: derived.maxHp, stamina: derived.maxStamina,
    };
  });
  return freeze({ version: RULES.VERSION, round: 1, maxRounds, status: 'active', fighters, log: [], lastRound: null, result: null });
}

function checkState(state, index) {
  if (!state || state.version !== RULES.VERSION || !Array.isArray(state.fighters) || state.fighters.length !== 2) throw new Error('Invalid duel state.');
  if (index !== 0 && index !== 1) throw new Error('Fighter index must be 0 or 1.');
}

function actionDamage(attacker, defender, action, guarded = false) {
  const technique = WEAPONS[attacker.weapon].technique;
  const damage = action === 'technique' ? attacker.techniquePower : attacker.strikePower;
  const protection = defender.personalProtection + Math.floor(defender.armorProtection * (action === 'technique' ? technique.armorFactor : 1));
  const afterArmor = Math.max(1, damage - protection);
  if (guarded && !(action === 'technique' && technique.ignoresGuard)) return Math.max(1, Math.floor(afterArmor * (1 - RULES.GUARD_REDUCTION)));
  return afterArmor;
}

/** A visible, bounded next-round status. Historical duel states need no migration. */
export function getFighterStatus(state, index) {
  checkState(state, index);
  const effect = state.fighters[index].entangle;
  if (state.status !== 'active' || effect?.round !== state.round) return null;
  return freeze({ id: 'entangled', label: 'Entangled', attackSurcharge: effect.attackSurcharge,
    clearsWith: ['guard', 'recover'], expiresAfterRound: effect.round });
}

/** Riposte damage is a possible counter, never a promise about a secret rival choice. */
export function getActionOptions(state, index) {
  checkState(state, index);
  const fighter = state.fighters[index];
  const weapon = WEAPONS[fighter.weapon];
  const opponent = state.fighters[1 - index];
  const pressure = getFighterStatus(state, index)?.attackSurcharge ?? 0;
  const options = [
    { id: 'strike', name: 'Strike', description: 'An ordinary attack, scaled by this weapon’s Strength and Dexterity affinities. Guard reduces its damage by 65%.', cost: fighter.strikeCost + pressure, priority: 0, damage: actionDamage(fighter, opponent, 'strike'), guardedDamage: actionDamage(fighter, opponent, 'strike', true), ...(pressure ? { statusSurcharge: pressure } : {}) },
    { id: 'technique', name: weapon.technique.name, description: weapon.technique.description, cost: fighter.techniqueCost + pressure, priority: weapon.technique.priority, damage: actionDamage(fighter, opponent, 'technique'), guardedDamage: weapon.technique.conditional === 'riposte' ? 0 : actionDamage(fighter, opponent, 'technique', true), ...(weapon.technique.conditional === 'riposte' ? { conditional: 'riposte', trigger: weapon.technique.trigger, reduction: weapon.technique.reduction } : {}), ...(weapon.technique.statusEffect ? { statusEffect: weapon.technique.statusEffect, attackSurcharge: weapon.technique.attackSurcharge, statusDuration: 1 } : {}), ...(pressure ? { statusSurcharge: pressure } : {}) },
    { id: 'guard', name: 'Guard', description: 'Act first and reduce most attacks by 65% this round. Feint, Guard Break, and Chain Sweep bypass it.', cost: RULES.GUARD_COST, priority: 3, damage: 0, guardedDamage: 0 },
    { id: 'recover', name: 'Recover', description: `Restore up to ${fighter.recovery} stamina, including Intelligence. Acts last, leaving you open to attack.`, cost: 0, priority: -2, damage: 0, guardedDamage: 0, recovery: fighter.recovery },
  ];
  return freeze(options.map((option) => ({ ...option, enabled: state.status === 'active' && fighter.hp > 0 && fighter.stamina >= option.cost })));
}

function roundLimitResult(fighters) {
  // Integer cross multiplication avoids rounding different health percentages to an artificial tie.
  const healthDifference = fighters[0].hp * fighters[1].maxHp - fighters[1].hp * fighters[0].maxHp;
  const staminaDifference = fighters[0].stamina * fighters[1].maxStamina - fighters[1].stamina * fighters[0].maxStamina;
  const difference = healthDifference || staminaDifference;
  return difference === 0
    ? { winner: null, reason: 'draw' }
    : { winner: difference > 0 ? 0 : 1, reason: 'round-limit' };
}

/** Only the authoritative session service should decide absence or forfeiture. */
export function forfeitDuel(state, loserIndex) {
  checkState(state, 0);
  if (state.status !== 'active') throw new Error('This duel has already ended.');
  if (loserIndex !== null && loserIndex !== 0 && loserIndex !== 1) throw new Error('Forfeit index must be 0, 1, or null.');
  const next = copy(state);
  const winner = loserIndex === null ? null : 1 - loserIndex;
  next.status = 'complete';
  next.result = { winner, reason: loserIndex === null ? 'abandoned' : 'forfeit' };
  for (const fighter of next.fighters) delete fighter.entangle;
  const event = {
    round: state.round, type: 'result', actor: winner,
    text: winner === null ? 'Both fighters left the duel. No victory is awarded.' : `${next.fighters[winner].character.name} wins by forfeit.`,
  };
  next.log.push(event);
  next.lastRound = { round: state.round, actions: [], order: [], events: [event] };
  return freeze(next);
}

/** Both choices must be committed before calling. Never pass one player's secret choice to CPU. */
export function resolveRound(state, actions) {
  checkState(state, 0);
  if (state.status !== 'active') throw new Error('This duel has already ended.');
  if (!Array.isArray(actions) || actions.length !== 2) throw new Error('Two simultaneous action choices are required.');
  const selected = actions.map((id, index) => {
    const option = getActionOptions(state, index).find((candidate) => candidate.id === id);
    if (!option) throw new Error(`Unknown action for ${state.fighters[index].character.name}.`);
    if (!option.enabled) throw new Error(`${state.fighters[index].character.name} cannot afford ${option.name}; choose Recover.`);
    return option;
  });
  const next = copy(state);
  const events = [];
  const add = (type, actor, text, details = {}) => events.push({ round: state.round, type, actor, text, ...details });
  const tieFirst = (state.round - 1) % 2;
  const order = [0, 1].sort((a, b) => selected[b].priority - selected[a].priority || next.fighters[b].speed - next.fighters[a].speed || (a === tieFirst ? -1 : 1));
  const first = next.fighters[order[0]];
  const second = next.fighters[order[1]];
  const samePriority = selected[0].priority === selected[1].priority;
  const orderReason = !samePriority ? 'action priority' : first.speed !== second.speed ? 'speed' : 'the alternating speed tie';
  add('reveal', null, `${next.fighters[0].character.name}: ${selected[0].name}. ${next.fighters[1].character.name}: ${selected[1].name}.`, { actions: [...actions] });
  add('initiative', order[0], `${first.character.name} acts before ${second.character.name} by ${orderReason}.`, { order: [...order], reason: orderReason });
  const guarded = [false, false], riposteReady = [false, false];
  for (const index of order) {
    const fighter = next.fighters[index];
    const opponent = next.fighters[1 - index];
    const option = selected[index];
    if (fighter.hp <= 0) {
      add('skipped', index, `${fighter.character.name} was defeated before acting.`);
      continue;
    }
    fighter.stamina -= option.cost;
    if (option.id === 'guard') {
      guarded[index] = true;
      add('guard', index, `${fighter.character.name} guards, spending ${option.cost} stamina.`);
      if (fighter.entangle) { delete fighter.entangle; add('entangle-clear', index, `${fighter.character.name} clears the net with Guard.`, { action: 'guard' }); }
    } else if (option.id === 'recover') {
      const restored = Math.min(option.recovery, fighter.maxStamina - fighter.stamina);
      fighter.stamina += restored;
      add('recover', index, `${fighter.character.name} recovers ${restored} stamina.`, { restored });
      if (fighter.entangle) { delete fighter.entangle; add('entangle-clear', index, `${fighter.character.name} clears the net with Recover.`, { action: 'recover' }); }
    } else if (option.conditional === 'riposte') {
      riposteReady[index] = true;
      add('riposte', index, `${fighter.character.name} readies Riposte, spending ${option.cost} stamina.`);
      // Both choices have already been revealed and validated. No private
      // selection changes whether this command is offered or can be afforded.
      if (selected[1 - index].id !== option.trigger) {
        add('riposte-miss', index, `${fighter.character.name}'s Riposte finds no ordinary Strike to counter.`);
      }
    } else {
      const target = 1 - index;
      const parried = option.id === 'strike' && riposteReady[target];
      let damage = actionDamage(fighter, opponent, option.id, guarded[target]);
      if (parried) {
        damage = Math.max(1, Math.floor(damage * (1 - selected[target].reduction)));
        riposteReady[target] = false;
      }
      const bypassed = guarded[1 - index] && option.id === 'technique' && WEAPONS[fighter.weapon].technique.ignoresGuard;
      opponent.hp = Math.max(0, opponent.hp - damage);
      add('attack', index, `${fighter.character.name} uses ${option.name} for ${damage} damage${bypassed ? ', bypassing Guard' : guarded[1 - index] ? ' against Guard' : parried ? ' against Riposte' : ''}, spending ${option.cost} stamina.`, { action: option.id, damage, target, bypassedGuard: bypassed, ...(parried ? { parried: true } : {}) });
      if (option.statusEffect === 'entangle' && opponent.hp > 0) {
        if (guarded[target]) add('entangle-blocked', target, `${opponent.character.name}'s Guard keeps the net away.`);
        else { opponent.entangle = { round: state.round + 1, attackSurcharge: option.attackSurcharge };
          add('entangle', index, `${opponent.character.name} is netted: attacks cost +${option.attackSurcharge} stamina next round. Guard or Recover clears it.`, { target, attackSurcharge: option.attackSurcharge, expiresAfterRound: state.round + 1 }); }
      }
      if (opponent.hp === 0) {
        next.status = 'complete';
        next.result = { winner: index, reason: 'knockout' };
        add('result', index, `${fighter.character.name} wins the duel. ${opponent.character.name} is defeated.`);
      } else if (parried) {
        // The counter is the already paid Riposte action, not a second turn.
        // It never triggers another counter and armor retains its full effect.
        const counterDamage = actionDamage(opponent, fighter, 'technique');
        fighter.hp = Math.max(0, fighter.hp - counterDamage);
        add('attack', target, `${opponent.character.name} counters with Riposte for ${counterDamage} damage.`, { action: 'technique', counter: true, target: index, damage: counterDamage });
        if (fighter.hp === 0) {
          next.status = 'complete';
          next.result = { winner: target, reason: 'knockout' };
          add('result', target, `${opponent.character.name} wins the duel. ${fighter.character.name} is defeated.`);
        }
      }
    }
  }
  for (const fighter of next.fighters) if (fighter.entangle?.round <= state.round) delete fighter.entangle;
  if (next.status === 'active' && state.round >= state.maxRounds) {
    next.status = 'complete';
    next.result = roundLimitResult(next.fighters);
    add('result', next.result.winner, next.result.winner === null
      ? `The ${state.maxRounds} round limit is reached. Equal health and stamina percentages make this a draw.`
      : `${next.fighters[next.result.winner].character.name} wins at the ${state.maxRounds} round limit by remaining health percentage, then stamina percentage.`);
  }
  if (next.status === 'complete') for (const fighter of next.fighters) delete fighter.entangle;
  next.lastRound = { round: state.round, actions: [...actions], order, events };
  next.log.push(...events);
  if (next.status === 'active') next.round += 1;
  return freeze(next);
}

/** A deterministic practice opponent. Reads only public fighter state and revealed past actions. */
export function chooseCpuAction(state, index, style) {
  checkState(state, index);
  if (state.status !== 'active') throw new Error('This duel has already ended.');
  const options = getActionOptions(state, index);
  const legal = (id) => options.find((option) => option.id === id && option.enabled);
  const fighter = state.fighters[index];
  const opponent = state.fighters[1 - index];
  const strike = legal('strike');
  const technique = legal('technique');
  const directTechnique = technique?.conditional ? null : technique;
  if (!strike || fighter.stamina <= (strike?.cost ?? 0) + 1) return 'recover';
  if (directTechnique && directTechnique.priority > 0 && directTechnique.damage >= opponent.hp) return 'technique';
  if (strike.damage >= opponent.hp) return 'strike';
  const lastOpponentAction = state.lastRound?.actions[1 - index];
  if (has(BOT_STYLES, style)) {
    const guard = legal('guard'), rhythm = (state.round + index) % 5;
    if (getFighterStatus(state, index) && style !== 'aggressive') return 'recover';
    if (style === 'patient' && fighter.stamina < Math.min(fighter.maxStamina, strike.cost * 2 + 2)) return 'recover';
    if (style === 'cautious' && guard && rhythm === 3 && opponent.stamina >= opponent.strikeCost) return 'guard';
    if (technique?.conditional === 'riposte' && lastOpponentAction === 'strike'
      && opponent.stamina >= opponent.strikeCost && rhythm === (style === 'patient' ? 2 : 1)) return 'technique';
    if (directTechnique?.statusEffect === 'entangle' && !getFighterStatus(state, 1 - index)
      && lastOpponentAction !== 'guard' && lastOpponentAction !== 'recover' && rhythm === (style === 'aggressive' ? 0 : 2)) return 'technique';
    if (directTechnique && !directTechnique.statusEffect && (directTechnique.damage > strike.damage
      || lastOpponentAction === 'guard' && WEAPONS[fighter.weapon].technique.ignoresGuard)) return 'technique';
    if (style === 'cautious' && fighter.stamina < fighter.maxStamina / 2 && rhythm === 4) return 'recover';
    return 'strike';
  }
  if (lastOpponentAction === 'guard' && technique && WEAPONS[fighter.weapon].technique.ignoresGuard) return 'technique';
  if (opponent.stamina < opponent.strikeCost) return 'strike';
  if (directTechnique && directTechnique.damage > strike.damage + 1) return 'technique';
  const rhythm = (state.round + index) % 5;
  if (WEAPONS[fighter.weapon].technique.conditional === 'riposte') {
    // Keep pressure between occasional predictions. Mirrored dagger opponents
    // must not endlessly repeat the same stance after seeing the same Strike.
    if (technique && (lastOpponentAction === 'strike' && rhythm === 1
      || rhythm === 0 && fighter.stamina >= technique.cost + strike.cost)) return 'technique';
    return 'strike';
  }
  if (rhythm === 0 && directTechnique) return 'technique';
  if (rhythm === 3 && legal('guard') && opponent.stamina >= 6) return 'guard';
  if (rhythm === 4 && fighter.stamina < fighter.maxStamina / 2) return 'recover';
  return 'strike';
}
