// First-person presentation reads the same public fighter/loadout as the stands.
// The opponent is the existing complete identity assembly. These new foreground
// parts have their own fixed grip at [0, 0]; no preserved sprite is transformed.
import { avatarChoices } from './avatar.js';
import { renderArena, renderFighterArt } from './arena.js';
import { FIRST_PERSON_PIXEL_CATALOG as pixelCatalog } from './first-person-pixel-catalog.js';
import { FIRST_PERSON_WHOLE_CATALOG as wholeCatalog } from './first-person-whole-catalog.js';
import { FIRST_PERSON_AXE_CATALOG as axeCatalog } from './first-person-axe-catalog.js';

let illustrationId = 0;
const weapons = new Set(['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword', 'dagger', 'trident']);
const twoHandedWeapons = new Set(['halberd', 'greatsword']);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const itemId = (value, fallback) => String(typeof value === 'object' ? value?.id ?? fallback : value ?? fallback);
const numeric = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const loadoutFor = fighter => fighter?.loadout ?? { weapon: fighter?.weapon, armor: fighter?.armor, helmet: fighter?.helmet };

function shade(hex, amount) {
  const rgb = hex.slice(1).match(/.{2}/g).map(value => parseInt(value, 16));
  return `#${rgb.map(value => Math.max(0, Math.min(255, value + amount)).toString(16).padStart(2, '0')).join('')}`;
}

function palette(fighter, armor) {
  const skinId = fighter?.character?.appearance?.skin;
  const skin = avatarChoices.skin.find(entry => entry.id === skinId)?.color ?? '#dbb798';
  const metal = armor === 'heavy';
  const cloth = armor === 'light';
  return { skin, skinLight: shade(skin, 22), skinShadow: shade(skin, -38),
    bracer: metal ? '#737b79' : cloth ? '#63594b' : '#654532',
    bracerLight: metal ? '#a6ada4' : cloth ? '#918372' : '#a17a4b',
    bracerDark: metal ? '#424b4a' : '#352a25', ink: '#262421' };
}

// Every weapon's handle passes through the same grip. Fingers are drawn last,
// so they visibly wrap the handle instead of sitting behind a floating blade.
function weaponArt(weapon) {
  const gripEnd = weapon === 'greatsword' ? 59 : 21;
  const grip = `<path d="M-4 ${gripEnd} H4 V-22 H-4 Z" fill="#583c29" stroke="#252724" stroke-width="2"/><path d="M-2 13 H3 M-2 4 H3 M-2 -5 H3 M-2 -14 H3${weapon === 'greatsword' ? ' M-2 23 H3 M-2 33 H3 M-2 43 H3 M-2 53 H3' : ''}" stroke="#b58a57" stroke-width="2"/><path d="M-6 ${gripEnd - 1} H6 V${gripEnd + 4} H-6 Z" fill="#bd9d58" stroke="#30332c" stroke-width="2"/>`;
  const shaft = (length = 100, end = 25) => `<path d="M-3 ${end} V-${length} H3 V${end} Z" fill="#725234" stroke="#282a25" stroke-width="2"/><path d="M-1 -${length - 5} V${end - 8}" stroke="#b28a50" stroke-width="2"/><path d="M-5 -24 H5 M-5 -34 H5" stroke="#ae9255" stroke-width="3"/>`;
  const guard = (width = 20) => `<path d="M-${width} -23 H${width} V-17 H7 L5 -13 H-5 L-7 -17 H-${width} Z" fill="#b99a56" stroke="#2f3027" stroke-width="2"/><path d="M-${width - 3} -22 H${width - 3}" stroke="#e0c98d" stroke-width="2"/>`;
  let art;
  switch (weapon) {
    case 'spear':
      art = `${shaft(107)}<path d="M0 -130 L-10 -108 L-4 -95 H4 L10 -108 Z" fill="#b7c0b7" stroke="#2e3634" stroke-width="2"/><path d="M0 -130 V-97 L6 -107 Z" fill="#e9e6cd"/><path d="M-5 -96 H5 V-91 H-5 Z" fill="#b59c5c"/>`;
      break;
    case 'trident':
      art = `${shaft(101)}<path d="M-17 -131 L-23 -117 L-21 -99 L-6 -90 V-82 H6 V-90 L21 -99 L23 -117 L17 -131 L15 -115 L15 -104 L4 -98 L4 -118 L0 -137 L-4 -118 V-98 L-15 -104 V-115 Z" fill="#b3bdb7" stroke="#2c3330" stroke-width="2"/><path d="M0 -131 V-94 M18 -122 V-102 L7 -96 M-18 -122 V-103" fill="none" stroke="#eee7cb" stroke-width="2"/><path d="M-6 -89 H6 V-82 H-6 Z" fill="#bba26a"/>`;
      break;
    case 'axe':
      art = `${shaft(76)}<path d="M-10 -83 L5 -84 L15 -90 L31 -87 L35 -80 L35 -60 L29 -53 L15 -54 L6 -64 L-10 -65 Z" fill="#89968f" stroke="#252f2c" stroke-width="2"/><path d="M31 -87 L35 -80 V-60 L29 -53 L26 -56 V-83 Z" fill="#dedfc6"/><path d="M-7 -78 H6 V-67 H-7 Z" fill="#b8a46e"/>`;
      break;
    case 'flail':
      art = `${shaft(57)}<path d="M0 -59 L3 -68 L12 -74 L23 -76 L33 -72" fill="none" stroke="#2b302b" stroke-width="5"/><path d="M0 -59 L3 -68 L12 -74 L23 -76 L33 -72" fill="none" stroke="#a1a89a" stroke-width="2" stroke-dasharray="3 3"/><g class="fp-flail-head"><path d="M35 -90 L41 -82 L49 -85 L48 -76 L56 -71 L47 -67 L46 -57 L38 -62 L30 -56 L28 -66 L21 -69 L26 -76 L24 -85 L33 -82 Z" fill="#929b8b" stroke="#282f28" stroke-width="2"/><path d="M33 -81 L41 -79 L44 -72 L40 -65 L32 -67 L28 -73 Z" fill="#bbc0a5"/><path d="M35 -78 L39 -73 L35 -69" fill="none" stroke="#f0e5bf" stroke-width="2"/></g>`;
      break;
    case 'halberd':
      art = `${shaft(108, 59)}<path d="M0 -132 L-6 -115 L-4 -101 H4 L6 -115 Z M4 -113 L15 -116 L29 -112 L33 -106 L32 -92 L27 -85 L14 -87 L4 -98 Z M-4 -109 L-20 -108 L-24 -99 L-13 -102 L-4 -101 Z" fill="#9ca79e" stroke="#2c3430" stroke-width="2"/><path d="M29 -112 L33 -106 L32 -92 L27 -85 L24 -89 L26 -108 Z M0 -128 V-103 H3 V-115 Z" fill="#e5e2c7"/><path d="M-6 -98 H6 V-91 H-6 Z" fill="#b79b5a"/>`;
      break;
    case 'mace':
      art = `${shaft(60)}<path d="M-6 -84 H6 L10 -76 H15 V-58 H10 L5 -51 H-5 L-10 -58 H-15 V-76 H-10 Z" fill="#8f9d91" stroke="#283029" stroke-width="2"/><path d="M-3 -81 H3 V-54 H-3 Z" fill="#e0e1bd"/><path d="M-12 -72 V-61 M11 -73 V-61" stroke="#bfc7af" stroke-width="3"/><path d="M-5 -50 H5 V-45 H-5 Z" fill="#bba465"/>`;
      break;
    case 'greatsword':
      art = `${grip}<path d="M-9 -23 V-110 L0 -134 L9 -110 V-23 Z" fill="#aebbb4" stroke="#2b3533" stroke-width="2"/><path d="M0 -130 V-25 H7 V-109 Z" fill="#e2e5d0"/><path d="M0 -124 V-28" stroke="#78918d" stroke-width="2"/>${guard(26)}`;
      break;
    case 'dagger':
      art = `${grip}<path d="M-6 -21 L-5 -52 L1 -69 L7 -52 L6 -21 Z" fill="#b4bfb5" stroke="#2b3330" stroke-width="2"/><path d="M1 -65 V-23 H5 V-52 Z" fill="#eee8d0"/>${guard(13)}`;
      break;
    default:
      art = `${grip}<path d="M-6 -23 V-91 L0 -110 L6 -91 V-23 Z" fill="#a9b8b0" stroke="#2d3531" stroke-width="2"/><path d="M0 -105 V-24 H4 V-91 Z" fill="#e8e6cf"/><path d="M-3 -88 V-30" stroke="#778d87" stroke-width="2"/>${guard()}`;
  }
  return `<g class="fp-weapon" data-weapon-art="${weapon}">${art}</g>`;
}

function forearm(p, left = false) {
  // A fixed wrist overlaps hand and cuff. These points are shared across armor;
  // material changes cannot move the hand relative to the equipment grip.
  return `<g class="fp-forearm${left ? ' fp-forearm--left' : ''}"><path d="M-12 10 H12 L42 63 H-14 L-20 39 Z" fill="${p.skin}" stroke="${p.ink}" stroke-width="2"/><path d="M8 14 L35 60 H19 L-3 18 Z" fill="${p.skinLight}"/><path d="M-16 27 L3 23 L21 63 H-14 L-20 39 Z" fill="${p.skinShadow}"/><path d="M-18 32 L19 22 L40 58 L42 65 H-14 L-22 42 Z" fill="${p.bracer}" stroke="${p.ink}" stroke-width="2"/><path d="M-17 34 L18 25 L23 33 L-15 43 Z" fill="${p.bracerLight}"/><path d="M-15 47 L27 38 L31 46 L-11 56 Z" fill="${p.bracerDark}"/><path d="M-11 50 L28 41" stroke="${p.bracerLight}" stroke-width="2"/><path d="M4 30 L19 62" stroke="${p.bracerLight}" stroke-width="2" opacity=".65"/><path d="M-13 36 H-9 V40 H-13 Z M18 28 H22 V32 H18 Z" fill="#cab179"/></g>`;
}

function grippingHand(p) {
  return `<g class="fp-gripping-hand"><path d="M-16 -13 L-8 -17 H6 L15 -12 L18 -5 V7 L10 16 H-7 L-17 10 L-20 2 V-6 Z" fill="${p.skin}" stroke="${p.ink}" stroke-width="2"/><path d="M-15 -12 L-7 -15 H5 L10 -11 V-7 H-9 L-15 -5 Z" fill="${p.skinLight}"/><path d="M-15 -5 H10 V0 H-17 Z M-16 1 H9 V6 H-15 Z M-12 7 H6 V12 H-8 Z" fill="${p.skinShadow}"/><path d="M-14 -4 H8 M-14 2 H8 M-10 8 H5" stroke="${p.skinLight}" stroke-width="2"/><path d="M12 -10 L18 -5 V7 L12 11 L6 8 L5 2 L9 -2 V-8 Z" fill="${p.skinLight}" stroke="${p.skinShadow}" stroke-width="2"/><path d="M10 2 L15 4 V8" fill="none" stroke="${p.skin}" stroke-width="2"/></g>`;
}

function supportingHand(p) {
  // The left arm enters from below the camera and grips the long lower handle.
  // It belongs to the same motion node as the right hand and the entire weapon.
  return `<g class="fp-supporting-hand" data-grip="0 36"><path d="M-11 41 L9 43 L-77 108 H-116 L-119 83 Z" fill="${p.skin}" stroke="${p.ink}" stroke-width="2"/><path d="M-5 44 L7 44 L-78 104 L-93 104 Z" fill="${p.skinLight}"/><path d="M-29 50 L-13 66 L-77 113 H-120 L-122 83 Z" fill="${p.bracer}" stroke="${p.ink}" stroke-width="2"/><path d="M-31 52 L-17 66 L-24 72 L-40 59 Z" fill="${p.bracerLight}"/><path d="M-53 69 L-38 84 L-46 89 L-63 76 Z" fill="${p.bracerDark}"/><path d="M-56 73 L-42 87 M-90 95 L-49 67" stroke="${p.bracerLight}" stroke-width="2"/><path d="M-32 57 H-28 V61 H-32 Z M-23 66 H-19 V70 H-23 Z" fill="#cab179"/><g transform="translate(0 36) scale(-1 1)">${grippingHand(p)}</g></g>`;
}

function shieldArt(p) {
  return `<g class="fp-shield"><path d="M-51 -57 L-13 -69 L22 -52 L27 -3 L12 27 L-12 44 L-42 25 L-57 -8 Z" fill="#3f3024" stroke="#272622" stroke-width="3"/><path d="M-48 -53 L-13 -64 L17 -49 L22 -5 L7 25 L-12 37 L-38 21 L-52 -10 Z" fill="#715337" stroke="#b9995b" stroke-width="3"/><path d="M-39 -51 L-33 18 M-25 -57 L-19 31 M-10 -57 L-6 29 M3 -50 L8 15" stroke="#382e25" stroke-width="2"/><path d="M-43 -45 L-29 -50 M-25 -52 L-17 -55 M-37 9 L-27 17" stroke="#aa8250" stroke-width="2"/><path d="M-39 -21 L17 -12 L16 -2 L-39 -10 Z M-32 12 L10 15 L6 24 L-27 21 Z" fill="#33312b" stroke="#9b8c64" stroke-width="2"/><path d="M-10 -28 L6 -25 L9 14 L-5 17 Z" fill="#36281f" stroke="#b68b51" stroke-width="3"/><path d="M-5 -21 H3 V10 H-3 Z" fill="#906643"/>${grippingHand(p)}</g>`;
}

function netArt(p) {
  return `<g class="fp-net"><path d="M-39 -57 L-10 -69 L20 -50 L31 -13 L8 19 L-35 16 L-52 -16 Z" fill="#927b4a" fill-opacity=".16" stroke="#bca16b" stroke-width="3"/><path d="M-39 -57 L8 19 M-22 -63 L21 0 M-9 -67 L28 -20 M-48 -28 L-2 19 M-45 -45 L17 -56 M-50 -24 L26 -35 M-45 -5 L30 -15 M-33 14 L19 0 M-34 -59 L-48 -14 M-17 -65 L-31 16 M0 -60 L-14 18 M16 -48 L3 18" fill="none" stroke="#c4ad79" stroke-width="2"/><path d="M-35 16 L-12 23 L2 12 L2 1 M8 19 L12 29 L26 31 L30 23" fill="none" stroke="#d0b983" stroke-width="3"/><path d="M-6 -9 L4 -14 L12 -7 L5 3 L-6 6 Z" fill="#bca16b" stroke="#504733" stroke-width="2"/>${grippingHand(p)}</g>`;
}

function pixelImage(part, url, layer) {
  const [x, y] = part.grip;
  return `<image class="pixel-sprite fp-pixel-part" data-pixel-layer="${layer}" href="${escape(url)}" x="${-x}" y="${-y}" width="${part.width}" height="${part.height}" preserveAspectRatio="none"/>`;
}

function pixelArm(skin, armor) {
  const { hand, bracer } = pixelCatalog.parts;
  return `<g class="fp-forearm" data-skin="${skin}" data-armor="${armor}">${pixelImage(hand, hand.variants[skin], 'skin-arm')}${pixelImage(bracer, bracer.variants[armor], 'armor-cuff')}</g>`;
}

function pixelFingers(skin) {
  const { fingers } = pixelCatalog.parts;
  return `<g class="fp-gripping-hand">${pixelImage(fingers, fingers.variants[skin], 'front-fingers')}</g>`;
}

function pixelMainhand(weapon, skin, armor) {
  const item = pixelCatalog.weapons[weapon];
  const supporting = item.secondGrip ? (() => {
    const [x, y] = item.secondGrip.map((value, index) => value - item.grip[index]);
    return `<g class="fp-supporting-hand" data-grip="${x} ${y}" transform="translate(${x} ${y}) scale(-.75 .75)">${pixelArm(skin, armor)}${pixelFingers(skin)}</g>`;
  })() : '';
  return `${pixelArm(skin, armor)}<g class="fp-weapon-depth"><g class="fp-weapon" data-weapon-art="${weapon}" data-grip="0 0">${pixelImage(item, item.url, 'weapon')}</g>${supporting}</g>${pixelFingers(skin)}`;
}

function pixelOffhand(weapon, skin, armor) {
  const name = weapon === 'trident' ? 'net' : 'shield', item = pixelCatalog.offhands[name];
  return `<g transform="scale(-1 1)">${pixelArm(skin, armor)}</g><g class="fp-${name}">${pixelImage(item, item.url, name)}<g transform="scale(-1 1)">${pixelFingers(skin)}</g></g>`;
}

function renderWholeHold(hold, skin, weapon) {
  const offset = hold.cameraOffset ?? [0, 0];
  const completeImage = (part, side) => {
    const [x, y] = part.pivot, [originX, originY] = part.frameOrigin;
    // Animation pivots belong to the camera-side sleeve entry, while the
    // authored grip, full image frame and outer registration stay intact.
    const [rootX, rootY] = hold.mode === 'both' ? [270, 235] : side === 'main' ? [450, 145] : [10, 235];
    const art = `<image class="pixel-sprite fp-whole-hold" data-pixel-layer="whole-${side}" href="${escape(part.variants[skin])}" x="${originX - x}" y="${originY - y}" width="${part.width}" height="${part.height}" preserveAspectRatio="none"/>`;
    const held = side === 'main' ? `<g class="fp-weapon" data-weapon-art="${weapon}">${art}</g>`
      : `<g class="fp-${weapon === 'trident' ? 'net' : 'shield'}">${art}</g>`;
    return `<g transform="translate(${x * 2 + offset[0]} ${y * 2 + offset[1]}) scale(2)"><g class="fp-${side === 'main' ? 'mainhand' : 'offhand'}"><g class="fp-motion-root" data-motion-root="${rootX} ${rootY}" transform="translate(${rootX - x} ${rootY - y})"><g class="fp-${side === 'main' ? 'mainhand' : 'offhand'}-motion"><g transform="translate(${x - rootX} ${y - rootY})">${held}</g></g></g></g></g>`;
  };
  return `${hold.mode === 'paired' ? completeImage(hold.off, 'off') : ''}${completeImage(hold.main, 'main')}`;
}

/** Invalid/missing ownership keeps the existing public third-person arena. */
export function renderFirstPersonArena(duel = {}, { viewerIndex, fit = 'meet', artVersion = 'v004' } = {}) {
  if ((viewerIndex !== 0 && viewerIndex !== 1) || !Array.isArray(duel.fighters) || duel.fighters.length !== 2) return renderArena(duel, { fit });
  const player = duel.fighters[viewerIndex] ?? {}, opponentIndex = 1 - viewerIndex;
  const opponent = duel.fighters[opponentIndex] ?? {}, loadout = loadoutFor(player);
  const requestedWeapon = itemId(loadout.weapon, 'sword'), weapon = weapons.has(requestedWeapon) ? requestedWeapon : 'sword';
  const twoHanded = twoHandedWeapons.has(weapon);
  const requestedArmor = itemId(loadout.armor, 'light');
  const armor = ({ cloth: 'light', leather: 'medium', plate: 'heavy' })[requestedArmor] ?? (['light', 'medium', 'heavy'].includes(requestedArmor) ? requestedArmor : 'light');
  const p = palette(player, armor), id = `first-person-${++illustrationId}`;
  const correctedAxe = artVersion === 'v004' && weapon === 'axe' ? axeCatalog.holds.axe?.[armor] : null;
  const candidate = correctedAxe ?? wholeCatalog.holds[weapon]?.[armor];
  const wholeHold = artVersion !== 'v001' && artVersion !== 'v002' && candidate
    && (twoHanded ? candidate.mode === 'both' : candidate.mode === 'paired' && candidate.off) ? candidate : null;
  const usePixels = !wholeHold && artVersion !== 'v001' && Boolean(pixelCatalog.weapons[weapon]);
  const viewmodelVersion = wholeHold ? wholeHold === correctedAxe ? 'v004' : 'v003' : usePixels ? 'v002' : 'v001';
  const requestedSkin = player.character?.appearance?.skin;
  const skin = Object.hasOwn(pixelCatalog.parts.hand.variants, requestedSkin) ? requestedSkin : 'ivory';
  const mainPosition = usePixels && weapon === 'halberd' ? '650 340'
    : usePixels && weapon === 'flail' ? '755 354'
      : usePixels && twoHanded ? '600 340' : `685 ${twoHanded ? 334 : 354}`;
  const offPosition = usePixels && weapon === 'trident' ? '215 235' : '235 356';
  const round = Math.max(1, numeric(duel.round, 1));
  const playerDefeated = numeric(player.hp, 1) <= 0, opponentDefeated = numeric(opponent.hp, 1) <= 0;
  return `<svg class="arena-svg first-person-arena" data-perspective="first-person" data-viewer-index="${viewerIndex}" data-viewmodel-version="${viewmodelVersion}" viewBox="0 0 920 440" preserveAspectRatio="xMidYMid ${fit === 'slice' ? 'slice' : 'meet'}" role="img" aria-labelledby="${id}-title ${id}-description">
    <title id="${id}-title">${escape(player.character?.name ?? 'Your fighter')} — first-person arena, round ${round}</title>
    <desc id="${id}-description">${twoHanded ? `Both hands grip your ${weapon}.` : `Your ${escape(weapon)} and ${weapon === 'trident' ? 'net' : 'shield'} are visible in your hands.`} ${escape(opponent.character?.name ?? 'Your opponent')} stands ahead on the sand.</desc>
    <defs><linearGradient id="${id}-shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121316" stop-opacity=".05"/><stop offset="1" stop-color="#141317" stop-opacity=".5"/></linearGradient><radialGradient id="${id}-vignette"><stop offset=".3" stop-color="#090d13" stop-opacity="0"/><stop offset="1" stop-color="#090d13" stop-opacity=".4"/></radialGradient><radialGradient id="${id}-hit"><stop offset=".3" stop-color="#a63b30" stop-opacity="0"/><stop offset="1" stop-color="#a63b30" stop-opacity=".7"/></radialGradient></defs>
    <g class="fp-camera">
      <image href="/assets/arena/dark-arena-v001.png" width="920" height="440" preserveAspectRatio="xMidYMid slice" class="pixel-sprite arena-backdrop"/>
      <rect width="920" height="440" fill="url(#${id}-shade)"/>
      <ellipse cx="460" cy="348" rx="87" ry="14" fill="#161e20" opacity=".35"/>
      <g class="arena-fighter fp-opponent fp-effects-mirrored" data-fighter-index="${opponentIndex}"${opponentDefeated ? ' data-defeated="true"' : ''} transform="translate(460 347) scale(-1 1)">${renderFighterArt(opponent.character, loadoutFor(opponent), '#436f70', opponentDefeated)}</g>
      <g class="arena-fighter fp-viewmodel" data-fighter-index="${viewerIndex}" data-weapon="${weapon}" data-armor="${armor}" data-two-handed="${twoHanded}"${wholeHold ? ` data-hold-mode="${wholeHold.mode}"` : ''}${playerDefeated ? ' data-defeated="true"' : ''}>
        ${wholeHold ? renderWholeHold(wholeHold, skin, weapon) : `${twoHanded ? '' : `<g transform="translate(${offPosition}) scale(2)"><g class="fp-offhand"><g class="fp-offhand-motion">${usePixels ? pixelOffhand(weapon, skin, armor) : `<g transform="scale(-1 1)">${forearm(p, true)}</g>${weapon === 'trident' ? netArt(p) : shieldArt(p)}`}</g></g></g>`}<g transform="translate(${mainPosition}) scale(2)"><g class="fp-mainhand"><g class="fp-mainhand-motion">${usePixels ? pixelMainhand(weapon, skin, armor) : `<g transform="rotate(14)">${forearm(p)}${weaponArt(weapon)}${twoHanded ? supportingHand(p) : ''}${grippingHand(p)}</g>`}</g></g></g>`}
        <g class="fighter-effects" transform="translate(460 330)"></g>
      </g>
    </g>
    <rect width="920" height="440" fill="url(#${id}-vignette)" pointer-events="none"/>
    <g class="fp-impact" aria-hidden="true" pointer-events="none"><rect class="fp-hit-flash" width="920" height="440" fill="url(#${id}-hit)" opacity="0"/><path class="fp-block-flash" d="M373 197 L407 224 L392 229 L423 260 M546 197 L513 224 L528 229 L497 260" fill="none" stroke="#e5d497" stroke-width="5" opacity="0"/></g>
  </svg>`;
}
