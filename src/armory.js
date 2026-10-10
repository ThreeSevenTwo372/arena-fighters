import { WEAPONS, ARMORS, HELMETS } from './combat.js';
import { renderCleanAvatar } from './current-avatar.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
// Native silhouettes from the current arena catalog, not the full 192×160
// alignment frames. Their registered copies stay untouched for combat.
export const ARMORY_WEAPON_DISPLAY = Object.freeze({
  trident: Object.freeze({ width: 26, height: 92 }),
  dagger: Object.freeze({ width: 16, height: 36 }),
  sword: Object.freeze({ width: 24, height: 63 }),
  spear: Object.freeze({ width: 14, height: 95 }),
  axe: Object.freeze({ width: 30, height: 58 }),
  flail: Object.freeze({ width: 44, height: 65 }),
  halberd: Object.freeze({ width: 32, height: 98 }),
  mace: Object.freeze({ width: 17, height: 60 }),
  greatsword: Object.freeze({ width: 34, height: 82 }),
});
const armorWidths = Object.freeze({ light: 49, medium: 47, heavy: 59 });
const helmetWidths = Object.freeze({ closed_bascinet: 29, barbute: 26, greathelm: 27 });
const rackOrder = Object.freeze(['sword', 'spear', 'halberd', 'trident', 'greatsword', 'dagger', 'axe', 'mace', 'flail']);
const chosen = (value, catalog, fallback) => Object.hasOwn(catalog, value) ? value : fallback;
const check = selected => `<span class="armory-choice-check" aria-hidden="true">${selected ? '✓' : '+'}</span>`;
const weaponDescription = id => ({ sword: 'Strength and Dexterity share strike power. Its Feint slips through Guard.', spear: 'Dexterity favors precise strikes. Quick Thrust has higher move priority than Strike.', axe: 'Strength favors heavy strikes. Guard Break bypasses Guard but acts at lower priority.', flail: 'A swinging chain sweeps around Guard. Strength favors strikes; Dexterity favors its technique.', halberd: 'A hooked blade pressures armor. Hook Thrust acts at lower move priority.', mace: 'Strength favors crushing blows. Armor Crush ignores equipment armor.', greatsword: 'Strength favors powerful strikes. Its lower-priority Cleaving Arc demands stamina.', dagger: 'Dexterity favors light strikes. Riposte readies before attacks and counters an ordinary Strike.', trident: 'Dexterity favors trident strikes. Entangle adds a brief next-round stamina tax.' }[id]);
const armorDescription = id => ({ light: 'No equipment protection or attack surcharge. Personal Defense still protects.', medium: 'Blocks 2 plus 1 damage per 4 Defense. No attack surcharge.', heavy: 'Blocks 4 plus 1 damage per 2 Defense. Each attack costs 1 extra stamina.' }[id]) + ' Choice time determines initiative; Dexterity determines round-end stamina restoration.';
const weaponButton = (id, current, index) => {
  const weapon = WEAPONS[id], frame = ARMORY_WEAPON_DISPLAY[id], selected = id === current;
  const texture = id === 'dagger' ? '/assets/clean-gladiator/v014-equipment/weapons/dagger.png' : id === 'trident' ? '/assets/clean-gladiator/v015-equipment/weapons/trident.png' : `/assets/clean-gladiator/v003/weapons/${id}.png`;
  return `<button type="button" class="armory-weapon armory-weapon--${id}${selected ? ' is-selected' : ''}" data-action="weapon" data-index="${index}" data-value="${id}" aria-pressed="${selected}" aria-label="${escape(`${weapon.name}. ${weaponDescription(id)} Technique: ${weapon.technique.name}. ${weapon.technique.description}`)}" title="${escape(weaponDescription(id))}">
    <span class="armory-weapon-hook" aria-hidden="true"></span><span class="armory-weapon-silhouette" aria-hidden="true"><img src="${texture}" width="${frame.width}" height="${frame.height}" alt="" draggable="false"></span>
    <span class="armory-nameplate">${escape(weapon.name)}${check(selected)}</span></button>`;
};
const armorButton = (id, current, sex, index) => {
  const armor = ARMORS[id], selected = id === current;
  return `<button type="button" class="armory-armor${selected ? ' is-selected' : ''}" data-action="armor" data-index="${index}" data-value="${id}" aria-pressed="${selected}" aria-label="${escape(`${armor.name}. ${armorDescription(id)}`)}" title="${escape(armorDescription(id))}">
    <span class="armory-mannequin" aria-hidden="true"><span class="armory-neck-cap"></span><img src="/assets/armory/v001/armor-${sex}-${id}.png" width="${armorWidths[id]}" height="70" alt="" draggable="false"><span class="armory-stand"></span></span>
    <span class="armory-nameplate">${id === 'light' ? 'Light' : id === 'medium' ? 'Medium' : 'Heavy'}${check(selected)}</span><span class="armory-armor-short">${id === 'light' ? 'Unburdened' : id === 'medium' ? 'Balance' : 'Protection'}</span></button>`;
};
const helmetButton = (id, current, index) => {
  const helmet = HELMETS[id], selected = id === current;
  const image = id === 'none' ? '<span class="armory-open-head" aria-hidden="true">∅</span>' : `<img src="/assets/armory/v001/helmet-${id}.png" width="${helmetWidths[id]}" height="35" alt="" draggable="false">`;
  const short = { none: 'Uncovered', closed_bascinet: 'Bascinet', barbute: 'Barbute', greathelm: 'Greathelm' }[id];
  return `<button type="button" class="armory-helmet${selected ? ' is-selected' : ''}" data-action="helmet" data-index="${index}" data-value="${id}" aria-pressed="${selected}" aria-label="${escape(`${helmet.name}. ${helmet.description}`)}" title="${escape(helmet.description)}"><span class="armory-helmet-object" aria-hidden="true">${image}</span><span class="armory-nameplate">${short}${check(selected)}</span></button>`;
};

/** Equipment buttons use the app's existing delegated handlers. The preview
 * reads the exact same appearance/loadout cache used in creation and combat. */
export function renderArmory({ character, gear, index = 0 }) {
  const loadout = {
    weapon: chosen(gear?.weapon, WEAPONS, 'sword'),
    armor: chosen(gear?.armor, ARMORS, 'medium'),
    helmet: chosen(gear?.helmet, HELMETS, 'none'),
  };
  const picker = Number.isInteger(index) && index >= 0 && index <= 1 ? index : 0;
  const sex = character?.appearance?.sex === 'female' ? 'female' : 'male';
  const weapon = WEAPONS[loadout.weapon], armor = ARMORS[loadout.armor];
  const helmetName = HELMETS[loadout.helmet].name;
  return `<section class="armory-room" aria-label="Arena preparation room">
    <div class="armory-room-heading"><span class="armory-room-kicker">Beneath the arena</span><h2>The arming chamber</h2><p>Take a weapon from the rack. Choose armor from a stand.</p></div>
    <div class="armory-scene">
      <section class="armory-rack-zone" aria-labelledby="armory-weapons-${picker}"><h3 id="armory-weapons-${picker}" class="armory-zone-title"><span>01</span> Weapon rack</h3><div class="armory-weapon-rack">${rackOrder.map(id => weaponButton(id, loadout.weapon, picker)).join('')}</div></section>
      <figure class="armory-fighter"><div class="armory-fighter-light" aria-hidden="true"></div><div class="armory-live-avatar">${renderCleanAvatar(character?.appearance, 'battle', loadout, { alt: `${character?.name ?? 'Your fighter'}, equipped with ${weapon.name}, ${armor.name} and ${helmetName}` })}</div><div class="armory-fighter-floor" aria-hidden="true"></div><figcaption><span class="armory-fighter-kicker">Your fighter</span><strong>${escape(character?.name ?? 'Your fighter')}</strong><span>${escape(weapon.name)} · ${escape(armor.name)}</span><small>${escape(helmetName)}</small></figcaption></figure>
      <div class="armory-wardrobe-zone"><section aria-labelledby="armory-armor-${picker}"><h3 id="armory-armor-${picker}" class="armory-zone-title"><span>02</span> Armor stands</h3><div class="armory-armor-stands">${Object.keys(ARMORS).map(id => armorButton(id, loadout.armor, sex, picker)).join('')}</div></section><section class="armory-helmet-zone" aria-labelledby="armory-helmets-${picker}"><h3 id="armory-helmets-${picker}" class="armory-zone-title"><span>03</span> Helmet shelf <small>Cosmetic</small></h3><div class="armory-helmet-shelf">${Object.keys(HELMETS).map(id => helmetButton(id, loadout.helmet, picker)).join('')}</div></section></div>
    </div>
    <div class="armory-selected-details" aria-live="polite" aria-atomic="true"><section class="armory-selected-weapon"><span class="armory-detail-label">Weapon in hand</span><h3>${escape(weapon.name)} <small>${escape(weapon.technique.name)}</small></h3><div class="armory-properties"><span>Faster choice at equal priority</span><span>Base Strike ${weapon.strikeCost} stamina</span><span>Base Technique ${weapon.technique.cost} stamina</span></div><p>${escape(weaponDescription(loadout.weapon))}</p><p class="armory-technique"><strong>${escape(weapon.technique.name)}:</strong> ${escape(weapon.technique.description)}</p></section><section class="armory-selected-armor"><span class="armory-detail-label">Armor equipped</span><h3>${escape(armor.name)}</h3><div class="armory-properties"><span>${armor.mitigation} base protection</span><span>No initiative modifier</span>${armor.attackSurcharge ? `<span>+${armor.attackSurcharge} stamina / attack</span>` : ''}</div><p>${escape(armorDescription(loadout.armor))}</p><p class="armory-helmet-note">${loadout.helmet === 'none' ? 'Your face and hair remain visible.' : `${escape(helmetName)} conceals your face and hair.`} Your identity stays saved. Helmets do not change combat stats.</p></section></div>
  </section>`;
}
