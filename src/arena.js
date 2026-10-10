// Dark-fantasy arena with registered identity and equipment sprites.
import { getAvatarImage } from './avatar.js';
import { getCleanAvatarImage } from './current-avatar.js';
let illustrationId = 0;
let handRegistrationId = 0;

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

const number = (value, fallback = 4) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const equipmentId = (value, fallback) => String(typeof value === 'object' ? value?.id ?? fallback : value ?? fallback).toLowerCase();
const clothColor = (value, fallback) => /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(String(value ?? '')) ? value : fallback;

function equippedSprite(weapon, mirror = 1) {
  const sprite = (item, origin, anchor) => `<image href="${escape(item.url)}" x="${origin[0] - anchor[0]}" y="${origin[1] - anchor[1]}" width="${item.width}" height="${item.height}" class="pixel-sprite"/>`;
  if (weapon.parts?.handle && weapon.parts.chain && weapon.parts.head && weapon.chainPivot && weapon.headPivot) {
    const { handle, chain, head } = weapon.parts;
    const [cx, cy] = weapon.chainPivot, [hx, hy] = weapon.headPivot;
    return `<g transform="scale(${-mirror} 1)">${sprite(handle, handle.origin, weapon.grip)}<g transform="translate(${cx - weapon.grip[0]} ${cy - weapon.grip[1]})"><g class="fighter-flail-chain-motion">${sprite(chain, chain.origin, weapon.chainPivot)}<g transform="translate(${hx - cx} ${hy - cy})"><g class="fighter-flail-head-motion">${sprite(head, head.origin, weapon.headPivot)}</g></g></g></g></g>`;
  }
  return `<image href="${escape(weapon.url)}" x="${-weapon.grip[0]}" y="${-weapon.grip[1]}" width="${weapon.width}" height="${weapon.height}" transform="scale(${-mirror} 1)" class="pixel-sprite"/>`;
}

function weaponArt(weapon) {
  if (weapon.includes('spear')) {
    return `<g class="equipped-weapon"><path d="M37 -35 L72 -189" stroke="#654025" stroke-width="7" stroke-linecap="round"/><path d="M70 -180 L74 -209 L83 -183 L77 -172 Z" fill="#dce0d6" stroke="#383d35" stroke-width="2"/><path d="M72 -189 L74 -209" stroke="#fcf8e7" stroke-width="2"/><path d="M66 -162 L78 -159" stroke="#b49559" stroke-width="5"/></g>`;
  }
  if (weapon.includes('axe')) {
    return `<g class="equipped-weapon"><path d="M39 -34 L67 -151" stroke="#654025" stroke-width="8" stroke-linecap="round"/><path d="M60 -140 Q36 -143 38 -163 Q49 -183 72 -170 L81 -169 Q94 -170 99 -153 L78 -146 Z" fill="#aab8ac" stroke="#383d35" stroke-width="2"/><path d="M38 -162 Q49 -183 71 -170" stroke="#f3efd6" stroke-width="4" fill="none"/><path d="M63 -147 L67 -163" stroke="#dec68b" stroke-width="5"/></g>`;
  }
  return `<g class="equipped-weapon"><path d="M41 -42 L62 -102" stroke="#69452b" stroke-width="7" stroke-linecap="round"/><path d="M58 -93 L84 -161 L89 -169 L93 -157 L69 -88 Z" fill="#c9d1c1" stroke="#3d4338" stroke-width="2"/><path d="M63 -94 L89 -167" stroke="#faf5da" stroke-width="2"/><path d="M53 -97 L75 -90" stroke="#bfa261" stroke-width="6" stroke-linecap="round"/><circle cx="41" cy="-43" r="5" fill="#bfa261"/></g>`;
}

export function renderFighterArt(character = {}, loadout = {}, fallbackColor = '#9e493b', defeated = false) {
  const clean = getCleanAvatarImage(character.appearance, 'battle', loadout);
  if (clean) {
    const [px, py] = clean.pivot;
    const [gx, gy] = clean.mainhandGrip;
    const [sx, sy] = clean.offhandGrip;
    const weapon = clean.weaponImage;
    const shield = clean.shieldImage;
    const shieldArt = shield ? `<g class="fighter-shield-pivot" transform="translate(${px - sx} ${sy - py})"><g class="fighter-shield-motion"><image href="${escape(shield.url)}" x="${-shield.grip[0]}" y="${-shield.grip[1]}" width="${shield.width}" height="${shield.height}" class="pixel-sprite"/></g></g>` : '';
    const weaponArt = weapon ? `<g class="fighter-weapon-pivot" transform="translate(${px - gx} ${gy - py})"><g class="fighter-weapon-motion"><g class="fighter-weapon-art" transform="rotate(${-clean.weaponAngle})">${equippedSprite(weapon, clean.weaponMirror)}</g></g></g>` : '';
    const handId = `arena-mainhand-${++handRegistrationId}`;
    // The preserved overlay contains only the authored main hand. Its body copy is
    // hidden only during an execution swing; ordinary resting composition is exact.
    // Convert nonzero source alpha to binary ownership without rectangular erasure.
    const ownershipAlpha = ['0', ...Array(255).fill('1')].join(' ');
    const handMask = clean.handsImage ? `<defs><filter id="${handId}-ownership" filterUnits="userSpaceOnUse" x="${-px}" y="${-py}" width="${clean.width}" height="${clean.height}" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0"/><feComponentTransfer><feFuncA type="discrete" tableValues="${ownershipAlpha}"/></feComponentTransfer></filter><mask id="${handId}-mask" maskUnits="userSpaceOnUse" mask-type="luminance" x="${-px}" y="${-py}" width="${clean.width}" height="${clean.height}"><rect x="${-px}" y="${-py}" width="${clean.width}" height="${clean.height}" fill="white"/><image href="${escape(clean.handsImage.url)}" x="${-px}" y="${-py}" width="${clean.width}" height="${clean.height}" filter="url(#${handId}-ownership)" class="pixel-sprite fighter-hand-ownership" image-rendering="pixelated"/></mask></defs>` : '';
    const frontHand = clean.handsImage ? `<g class="fighter-front-hand-pivot" transform="translate(${px - gx} ${gy - py})"><g class="fighter-front-hand-motion"><image href="${escape(clean.handsImage.url)}" x="${-gx}" y="${-gy}" width="${clean.width}" height="${clean.height}" transform="scale(-1 1)" class="pixel-sprite fighter-front-hand"/></g></g>` : '';
    return `<g class="gladiator pixel-gladiator clean-gladiator${defeated ? ' defeated' : ''}" transform="scale(2)"><ellipse cx="0" cy="1" rx="25" ry="4" fill="#453925" opacity=".28"/><g class="fighter-motion">${handMask}${shieldArt}<image href="${escape(clean.url)}" x="${-px}" y="${-py}" width="${clean.width}" height="${clean.height}" transform="scale(-1 1)" class="pixel-sprite fighter-body"${clean.handsImage ? ` style="--fighter-hand-mask:url(#${handId}-mask)"` : ''}/>${weaponArt}${frontHand}<g class="fighter-effects" transform="translate(0 -74)"></g></g></g>`;
  }
  const avatar = getAvatarImage(character.appearance, 'battle', loadout);
  if (avatar) {
    const [pivotX, pivotY] = avatar.pivot || [96, 152];
    const sourceFlip = avatar.sourceFacing === 'W' ? -1 : 1;
    const grip = avatar.mainhandGrip || [65, 104];
    const gripX = (grip[0] - pivotX) * sourceFlip;
    const gripY = grip[1] - pivotY;
    const weapon = equipmentId(loadout.weapon, 'sword');
    return `<g class="gladiator pixel-gladiator${defeated ? ' defeated' : ''}" transform="scale(1.65)${defeated ? ' rotate(12)' : ''}"><ellipse cx="0" cy="1" rx="30" ry="5" fill="#453925" opacity=".28"/><image href="${escape(avatar.url)}" x="${-pivotX}" y="${-pivotY}" width="${avatar.width}" height="${avatar.height}" transform="scale(${sourceFlip} 1)" class="pixel-sprite"/>${avatar.nativeWeapon ? '' : `<g class="pixel-weapon" transform="translate(${gripX} ${gripY}) rotate(30) scale(.55) translate(-41 43)">${weaponArt(weapon)}</g>`}</g>`;
  }
  const stats = character.stats ?? {};
  const might = clamp(number(stats.might), 1, 10);
  const agility = clamp(number(stats.agility), 1, 10);
  const vitality = clamp(number(stats.vitality), 1, 10);
  const width = 24 + might * 1.3 + vitality * .4 - agility * .35;
  const stature = .93 + vitality * .012;
  const color = clothColor(character.color, fallbackColor);
  const armor = equipmentId(loadout.armor, 'medium');
  const weapon = equipmentId(loadout.weapon, 'sword');
  const heavy = armor.includes('heavy') || armor.includes('plate');
  const light = armor.includes('light') || armor.includes('cloth');
  const torso = heavy ? '#747d72' : light ? '#b7855c' : '#77533c';
  const skin = '#be8965';
  const shoulder = heavy ? width + 10 : width + 4;

  return `<g class="gladiator${defeated ? ' defeated' : ''}" transform="scale(1 ${stature})${defeated ? ' rotate(9)' : ''}">
    <ellipse cx="0" cy="3" rx="49" ry="9" fill="#3c2f1b" opacity=".24"/>
    <path d="M-${width - 5} -108 L-${width + 17} -42 L-15 -39 L6 -116 Z" fill="${color}" stroke="#5e352c" stroke-width="2"/>
    <path d="M-${width - 1} -104 L-${width + 6} -53 M-${width - 8} -91 L-19 -49" stroke="#edd8b2" stroke-width="2" opacity=".25"/>
    <path d="M-17 -56 L-21 -28 L-27 -8 L-13 -5 L-6 -24 L0 -48 M9 -55 L18 -32 L27 -8 L40 -9 L29 -39 L23 -59" fill="${skin}" stroke="#48392a" stroke-width="3" stroke-linejoin="round"/>
    <path d="M-26 -14 L-10 -11 L-9 1 L-35 1 L-35 -5 Z M25 -15 L40 -14 L49 -2 L45 2 L22 2 Z" fill="#49382a" stroke="#322a22" stroke-width="2"/>
    ${!light ? '<path d="M-23 -31 L-9 -28 L-12 -13 L-26 -15 Z M21 -31 L32 -35 L38 -17 L25 -14 Z" fill="#8e977f" stroke="#4a4c3d" stroke-width="2"/>' : ''}
    <path d="M-${width} -115 Q0 -123 ${width} -113 L${width - 7} -61 Q0 -54 -${width - 6} -62 Z" fill="${torso}" stroke="#41372d" stroke-width="3"/>
    ${heavy ? `<path d="M-${width - 5} -110 Q0 -94 ${width - 5} -108 M0 -113 L0 -70" stroke="#bdc0a3" stroke-width="3" fill="none"/><path d="M-22 -66 L-27 -44 L-9 -41 L0 -58 L9 -41 L28 -44 L23 -66 Z" fill="#697365" stroke="#373d32" stroke-width="2"/>` : `<path d="M-${width - 3} -107 L${width - 8} -68" stroke="#d6af76" stroke-width="7"/><path d="M-24 -62 L-26 -40 Q0 -47 27 -40 L23 -62 Z" fill="${color}" stroke="#4a362b" stroke-width="2"/>`}
    <path d="M-${width} -111 Q-${shoulder + 6} -111 -${shoulder + 5} -95 L-${shoulder + 3} -64 L-31 -56 L-27 -72 L-${width - 6} -94 M${width - 2} -110 Q${shoulder + 4} -104 ${shoulder + 5} -91 L39 -62 L44 -47 L34 -43 L28 -59 L${width - 7} -90" fill="${skin}" stroke="#49382b" stroke-width="3" stroke-linejoin="round"/>
    ${heavy ? `<path d="M-${width + 9} -116 Q-${width - 2} -125 -${width - 4} -101 L-${width + 13} -98 Z M${width - 9} -117 Q${width + 11} -122 ${width + 12} -98 L${width - 2} -100 Z" fill="#939a7f" stroke="#444c3e" stroke-width="2"/>` : ''}
    <path d="M-11 -129 L-9 -113 L12 -113 L13 -128" fill="${skin}" stroke="#49382b" stroke-width="2"/>
    <path d="M-17 -151 Q-17 -170 3 -171 Q22 -167 20 -145 L15 -129 Q3 -121 -11 -131 Z" fill="${skin}" stroke="#49382b" stroke-width="2"/>
    <path d="M-20 -150 Q-25 -175 1 -180 Q28 -178 24 -150 L12 -157 L3 -152 L-4 -142 L-15 -135 L-19 -150 Z" fill="#b2a475" stroke="#4c4636" stroke-width="3"/>
    <path d="M-12 -177 Q-5 -198 15 -191 L27 -178 L15 -178 L7 -183 L0 -176" fill="${color}" stroke="#613b2c" stroke-width="2"/>
    <path d="M1 -156 L21 -151 L16 -144 L1 -148 Z" fill="#292d27"/>
    <path d="M-11 -168 Q3 -174 15 -167" stroke="#e6d69f" stroke-width="3" fill="none"/>
    <path d="M-24 -66 L24 -66" stroke="#453a2b" stroke-width="8"/>
    <rect x="-5" y="-71" width="12" height="10" rx="2" fill="#c7a36a" stroke="#55412b" stroke-width="2"/>
    <ellipse cx="-37" cy="-71" rx="21" ry="31" fill="${color}" stroke="#c6ab74" stroke-width="5"/>
    <ellipse cx="-37" cy="-71" rx="14" ry="23" fill="none" stroke="#e9cc8d" stroke-width="1" opacity=".5"/>
    <circle cx="-37" cy="-71" r="7" fill="#b6a77a" stroke="#4a4634" stroke-width="2"/>
    ${weaponArt(weapon)}
    <path d="M32 -58 Q38 -63 44 -54 L42 -44 L33 -46 Z" fill="${skin}" stroke="#49382b" stroke-width="2"/>
  </g>`;
}

function spectatorRow(y, start, end, step, row) {
  let result = '';
  const colors = ['#5c4a35', '#856b4b', '#5c5541', '#9a724f', '#615344', '#8c6041'];
  for (let x = start, index = 0; x <= end; x += step, index++) {
    if ((index + row * 3) % 13 === 0) continue;
    const bend = Math.pow((x - 460) / 460, 2) * 39;
    const yy = y + bend;
    const color = colors[(index + row * 2) % colors.length];
    const arms = (index + row) % 7 === 0
      ? `<path d="M${x - 5} ${yy + 6} L${x - 12} ${yy - 6} M${x + 5} ${yy + 6} L${x + 11} ${yy - 7}" stroke="${color}" stroke-width="4" stroke-linecap="round"/>`
      : '';
    result += `<g opacity="${.55 + row * .12}"><circle cx="${x}" cy="${yy}" r="4.6" fill="${color}"/><path d="M${x - 7} ${yy + 17} Q${x - 8} ${yy + 5} ${x} ${yy + 5} Q${x + 8} ${yy + 5} ${x + 7} ${yy + 17}" fill="${color}"/>${arms}</g>`;
  }
  return result;
}

export function renderArena(duel = {}, { perspective, fit = 'slice' } = {}) {
  const id = `arena-${++illustrationId}`;
  const fighters = duel.fighters ?? [];
  const left = fighters[0] ?? {};
  const right = fighters[1] ?? {};
  const loadout = fighter => fighter.loadout ?? { weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet };
  const round = Math.max(1, number(duel.round, 1));
  // The stands camera scales each complete assembly, keeping all head and equipment registrations intact.
  const stands = perspective === 'stands';
  const height = stands ? 580 : 440;
  const leftTransform = stands ? 'translate(340 365) scale(.5)' : 'translate(320 378)';
  const rightTransform = stands ? 'translate(580 365) scale(-.5 .5)' : 'translate(600 378) scale(-1 1)';
  return `<svg class="arena-svg" viewBox="0 0 920 ${height}" preserveAspectRatio="xMidYMid ${fit === 'meet' ? 'meet' : 'slice'}" role="img" aria-labelledby="${id}-title ${id}-description">
    <title id="${id}-title">Arena Fighters arena, round ${round}</title>
    <desc id="${id}-description">${escape(left.character?.name || 'First gladiator')} faces ${escape(right.character?.name || 'Second gladiator')} on the sand, surrounded by seated spectators.</desc>
    <image href="/assets/arena/dark-arena-v001.png" width="920" height="${height}" preserveAspectRatio="xMidYMid slice" class="pixel-sprite arena-backdrop"/>
    <g class="arena-fighter" data-fighter-index="0" ${number(left.hp, 1) <= 0 ? 'data-defeated="true"' : ''} transform="${leftTransform}">${renderFighterArt(left.character, loadout(left), '#9e493b', number(left.hp, 1) <= 0)}</g>
    <g class="arena-fighter" data-fighter-index="1" ${number(right.hp, 1) <= 0 ? 'data-defeated="true"' : ''} transform="${rightTransform}">${renderFighterArt(right.character, loadout(right), '#436f70', number(right.hp, 1) <= 0)}</g>
    <g${stands ? ' visibility="hidden" aria-hidden="true"' : ''} font-family="Consolas, monospace" font-size="12" font-weight="bold" letter-spacing="2" fill="#fff4c8" stroke="#3a302b" stroke-width="4" paint-order="stroke fill"><text x="280" y="${stands ? 402 : 418}" text-anchor="middle">WEST GATE</text><text x="640" y="${stands ? 402 : 418}" text-anchor="middle">EAST GATE</text></g>
  </svg>`;
}
