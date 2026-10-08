import { RULES, WEAPONS, ARMORS, HELMETS, TRAITS, ATTRIBUTE_LABELS, deriveFighterStats, validateCharacter, createDuel, getActionOptions, resolveRound, chooseCpuAction } from './combat.js';
import { OnlineClient } from './online-client.js';
import { TournamentClient } from './tournament-client.js';
import { createArrivalController } from './arrival.js';
import { renderArmory } from './armory.js';
import { renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentEntrance } from './tournament-view.js';
import { renderArena } from './arena.js';
import { avatarChoices, normalizeAppearance } from './avatar.js';
import { facePresetChoices, normalizePresetAppearance } from './face-presets.js';
import { preloadCleanArt, prepareCleanAvatar, renderCleanAvatar } from './current-avatar.js';
import { buildAnimationSteps, playBattleAnimation } from './battle-animation.js';
import { buildExecutionEvent, playExecutionAnimation } from './execution-animation.js';
import { renderMercyPanel, playLoserOutcome } from './mercy-presentation.js';
import { battlePhase, fighterReadiness, roundSummary, actionPreview, outcomeReason } from './battle-presentation.js';

const app = document.querySelector('#app');
const presetReview = new URLSearchParams(globalThis.location.search).get('face-presets-review') === '1';
const spectatorReview = new URLSearchParams(globalThis.location.search).get('spectator-frame-review') === '1';
const tournamentEnabled = !presetReview && !spectatorReview && new URLSearchParams(globalThis.location.search).get('duel-mode') !== '1' && typeof TournamentClient === 'function';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const STAT_LABELS = ATTRIBUTE_LABELS;
const COLORS = ['#b45143', '#5f8795', '#7b8b57', '#99739b', '#b88a45', '#697a9a'];
const DEFAULT_STATS = { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 };
const defaults = () => [
  { name: presetReview ? 'Cassian' : '', stats: { ...DEFAULT_STATS }, trait: 'balanced', color: COLORS[0], appearance: normalizePresetAppearance({ sex: 'male', facePreset: 'p05', hairstyle: 'braided_ponytail', hairColor: 'chestnut', eyes: 'amber' }) },
  { name: 'Mira', stats: { ...DEFAULT_STATS }, trait: 'balanced', color: COLORS[1], appearance: normalizePresetAppearance({ sex: 'female', facePreset: 'p05', hairstyle: 'braided_ponytail', hairColor: 'chestnut', eyes: 'jade' }) }
];
const state = {
  screen: 'creator', mode: presetReview ? 'cpu' : 'online', drafts: defaults(), profiles: [], locked: [false, false],
  creatorStep: presetReview ? 'customize' : 'name', creatorIndex: 0, nameIndex: 0,
  loadouts: [{ weapon: 'sword', armor: 'medium', helmet: 'none' }, { weapon: 'spear', armor: 'light', helmet: 'none' }],
  picker: 0, duel: null, actionTurn: 0, pending: [null, null], phase: 'select',
  cpuAction: null, decision: null, reaction: null, error: '', handoff: null, practiceDuels: 0
};
state.turnDeadline = null;
state.previewAction = 'strike';
let reactionTimer;
let localTurnTimer;
let localTurnClock = null;
let renderVersion = 0;
let renderBusy = false;
let renderedArena = null;
let roundPlayback = null;
let executionPlayback = null, queuedExecutionView = null;
const observedExecutions = new Set();
let outcomePlayback = null, queuedOutcomeView = null, verdictReveal = null, queuedVerdictView = null;
const observedOutcomes = new Set(), revealedWinners = new Set(), fallbackDeathReceipts = new Map();
let verdictTimer, localMercyTimer, localCrowdTimer, deathRetryTimer;
let localDuelId = 0;
const onlineClient = spectatorReview ? null : typeof TournamentClient === 'function' ? new TournamentClient({ duelMode: !tournamentEnabled }) : new OnlineClient();
let arrival = null, arrivalComplete = true, appReady = false;
let tournamentView = null;
let spectatorPlayback = null, queuedSpectatorView = null;
let onlineView = null;
let onlineSession = null;
let onlineSessionNeedsRefresh = false;
let onlineBusy = false;
let onlineOffline = false;
let onlineReplacement = false;
let roomCodeDraft = '';
let polling = false;
let queuedOnlineView = null;
let onlineEpoch = 0;
let lastTemporaryHeartbeat = 0;
const onlineMode = () => state.mode === 'online';
const creatorValid = () => (onlineMode() ? [state.drafts[0]] : state.drafts).every(character => validateCharacter(character).valid);
const nameValid = index => typeof state.drafts[index]?.name === 'string' && state.drafts[index].name.trim().length >= 1 && state.drafts[index].name.trim().length <= 24;

const APPEARANCE_LABELS = { sex: 'Sex', skin: 'Skin tone', hairColor: 'Hair color' };
const LEGACY_APPEARANCE_LABELS = { sex: 'Sex', hairstyle: 'Hairstyle', skin: 'Skin tone', hairColor: 'Hair color', eyes: 'Eye color', eyeStyle: 'Expression', beard: 'Facial hair' };
const EXPRESSION_LABELS = { classic: 'Solemn', sharp: 'Intense' };
const IDENTITY_GEAR = Object.freeze({ weapon: 'sword', armor: 'medium', helmet: 'none' });
const appearanceLabel = id => String(id).split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
function appearanceEditor(character, index, locked) {
  if (!character.appearance.facePreset) return legacyAppearanceEditor(character, index, locked);
  const appearance = normalizePresetAppearance(character.appearance);
  return `<fieldset class="appearance-fields" ${locked ? 'disabled' : ''}><legend>Your appearance</legend>${Object.entries(APPEARANCE_LABELS).map(([field, label]) => {
    const options = avatarChoices[field] || [];
    return `<label for="appearance-${index}-${field}">${label}<select id="appearance-${index}-${field}" data-appearance="${field}" data-index="${index}">${options.map(option => { const id = typeof option === 'string' ? option : option.id; return `<option value="${esc(id)}" ${appearance[field] === id ? 'selected' : ''}>${esc(option.label || appearanceLabel(id))}</option>`; }).join('')}</select></label>`;
  }).join('')}</fieldset>`;
}
function legacyAppearanceEditor(character, index, locked) {
  const appearance = normalizeAppearance(character.appearance);
  return `<fieldset class="appearance-fields" ${locked ? 'disabled' : ''}><legend>Your appearance</legend>${Object.entries(LEGACY_APPEARANCE_LABELS).map(([field, label]) => {
    if (field === 'beard' && appearance.sex !== 'male') return '';
    const options = avatarChoices[field] || [];
    return `<label for="appearance-${index}-${field}">${label}<select id="appearance-${index}-${field}" data-appearance="${field}" data-index="${index}">${options.map(option => { const id = typeof option === 'string' ? option : option.id; const text = field === 'eyeStyle' ? EXPRESSION_LABELS[id] : option.label; return `<option value="${esc(id)}" ${appearance[field] === id ? 'selected' : ''}>${esc(text || appearanceLabel(id))}</option>`; }).join('')}</select></label>`;
  }).join('')}</fieldset><p class="appearance-note">This is the gladiator you will see in the arena. Appearance has no effect on combat.</p>`;
}

function header() {
  return `<header class="masthead"><a class="brand" href="/" aria-label="Arena Fighters home"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13 27C2 23 3 9 11 4m8 23C30 23 29 9 21 4M12 27h8"/><path d="M7 9C1 7 1 14 6 15m0-2c-5 0-4 7 2 7m0-3c-4 2-2 7 4 7M25 9c6-2 6 5 1 6m0-2c5 0 4 7-2 7m0-3c4 2 2 7-4 7"/><path d="m16 9 3 6-3 6-3-6Z"/></svg></span> ARENA FIGHTERS</a><span class="badge">${onlineMode() ? `${tournamentEnabled ? 'Tournament' : 'Online duel'}${onlineView ? ` · ${esc(onlineView.code)}` : ''}` : state.mode === 'cpu' ? 'Practice' : 'Pass & play'}</span></header>`;
}
function statChips(character) {
  return `<div class="rule-strip">${Object.entries(STAT_LABELS).map(([key, label]) => `<span><strong>${character.stats[key]}</strong> ${label}</span>`).join('')}<span>${esc(TRAITS[character.trait]?.name || character.trait)}</span></div>`;
}
function bannerChip(character, label) {
  const colorIndex = Math.max(0, COLORS.indexOf(character.color));
  return `<span class="banner-chip color-${colorIndex}">${esc(label)}</span>`;
}
function choiceList(items, selected, action, index, extraClass = '') {
  return `<div class="option-grid ${extraClass}">${Object.entries(items).map(([id, item]) => `<button type="button" class="choice-card ${selected === id ? 'selected' : ''}" data-action="${action}" data-index="${index}" data-value="${id}" aria-pressed="${selected === id}"><span class="choice-title">${esc(item.name || id)}</span><span class="choice-description">${esc(item.description || '')}</span></button>`).join('')}</div>`;
}
function editor(index) {
  const character = state.drafts[index];
  const used = Object.values(character.stats).reduce((sum, value) => sum + value, 0);
  const left = RULES.POINT_BUDGET - used;
  const locked = state.locked[index];
  const preset = character.appearance.facePreset;
  const presetArrow = direction => `<button type="button" class="preset-arrow ${direction < 0 ? 'previous' : 'next'}" data-action="face-cycle" data-index="${index}" data-delta="${direction}" aria-label="${direction < 0 ? 'Previous' : 'Next'} preset for ${esc(character.name)}" ${locked ? 'disabled' : ''}><svg viewBox="0 0 40 32" aria-hidden="true"><path d="M23 3 6 16 23 29V21H35V11H23Z"/></svg></button>`;
  const avatar = renderCleanAvatar(character.appearance, 'world', IDENTITY_GEAR);
  return `<section class="panel fighter-editor compact-editor${preset ? ' preset-editor' : ''}" aria-label="Customize ${esc(character.name)}">
    <div class="creator-identity"><div class="arena-identity-preview"><figure class="arena-identity-figure">${preset ? `<div class="preset-character">${presetArrow(-1)}${avatar}${presetArrow(1)}</div>` : avatar}<figcaption>${esc(character.name)}${preset ? `<span class="preset-number" role="status" aria-label="Preset ${esc(preset.slice(1))}" aria-live="polite">${esc(preset.slice(1))}</span>` : ''}</figcaption></figure></div>
      <span class="field-label">Banner</span><div class="color-choices" aria-label="Banner color">${COLORS.map((color, colorIndex) => `<button class="color-choice color-${colorIndex} ${character.color === color ? 'selected' : ''}" data-action="color" data-index="${index}" data-value="${color}" aria-label="${['Red', 'Blue', 'Green', 'Purple', 'Gold', 'Slate'][colorIndex]} banner for ${esc(character.name)}" aria-pressed="${character.color === color}" ${locked ? 'disabled' : ''}>${character.color === color ? '✓' : ''}</button>`).join('')}</div></div>
    <div class="creator-appearance">${appearanceEditor(character, index, locked)}</div>
    <div class="creator-values"><div class="attribute-heading"><h2>Attributes</h2><span class="badge" role="status">${locked ? 'Fixed' : `${left} points left`}</span></div>
      <div class="attribute-limit">${RULES.POINT_BUDGET} points · ${RULES.STAT_CAP} max</div>
      ${Object.entries(STAT_LABELS).map(([key, label]) => `<div class="stat-row"><strong class="stat-label">${label}</strong><div class="stat-controls"><button data-action="stat" data-index="${index}" data-stat="${key}" data-delta="-1" aria-label="Decrease ${label} for ${esc(character.name)}" ${locked || character.stats[key] === 0 ? 'disabled' : ''}>−</button><span class="stat-value">${character.stats[key]}</span><button data-action="stat" data-index="${index}" data-stat="${key}" data-delta="1" aria-label="Increase ${label} for ${esc(character.name)}" ${locked || left <= 0 || character.stats[key] >= RULES.STAT_CAP ? 'disabled' : ''}>+</button></div></div>`).join('')}
      <label class="field-label" for="trait-${index}">Trait</label><select id="trait-${index}" data-trait="${index}" aria-describedby="trait-description-${index}" ${locked ? 'disabled' : ''}>${Object.entries(TRAITS).map(([id, trait]) => `<option value="${id}" ${character.trait === id ? 'selected' : ''}>${esc(trait.name)}</option>`).join('')}</select><p class="trait-description" id="trait-description-${index}">${esc(TRAITS[character.trait].description)}</p>
    </div>
  </section>`;
}
function buildPreview(character, gear = { weapon: 'sword', armor: 'medium', helmet: 'none' }) {
  if (!validateCharacter(character).valid) return '<p class="build-note">Allocate all points to preview your combat values.</p>';
  const values = deriveFighterStats(character, gear);
  return `<div class="build-preview" aria-label="Equipment effectiveness"><span><strong>${values.maxHp}</strong> Health</span><span><strong>${values.maxStamina}</strong> Stamina</span><span><strong>${values.speed}</strong> Initiative</span><span><strong>${values.mitigation}</strong> Protection</span><span><strong>${values.strikeCost} / ${values.techniqueCost}</strong> Attack costs</span><span><strong>+${values.recovery}</strong> Recovery</span></div><p class="build-note">${esc(WEAPONS[gear.weapon].name)} · ${esc(ARMORS[gear.armor].name)} · Fortune +${values.fortuneBonus}. Intelligence’s small all-round bonus is included in these values.</p>`;
}
function onlineSetupPanel() {
  if (onlineSessionNeedsRefresh) return '<section class="panel online-setup" role="status"><div class="panel-header"><h2>Reconnecting your fighter…</h2></div><div class="online-setup-body"><p>Your saved fighter will be ready when the connection returns.</p></div></section>';
  if (onlineSession?.pendingMercyTournament) return `<section class="panel online-setup"><div class="panel-header"><h2>Awaiting the verdict</h2><span class="badge">Lobby ${esc(onlineSession.pendingMercyTournament)}</span></div><div class="online-setup-body"><p>You withdrew from that tournament. Your fighter can enter another lobby after the scheduled match and mercy verdict resolve.</p>${onlineSession.pendingMercyTournamentDeadline ? `<p class="duel-deadline"><span data-deadline="${onlineSession.pendingMercyTournamentDeadline}">${Math.max(0, Math.ceil((onlineSession.pendingMercyTournamentDeadline - Date.now()) / 1000))}</span>s remaining · timeout: spare</p>` : ''}<p class="build-note">Your character and record update here automatically.</p></div></section>`;
  if (tournamentEnabled) return `<section class="creator-actions" aria-label="Enter a tournament">${onlineSession?.character && !onlineSession.alive ? `<p class="memorial-note">${esc(onlineSession.character.name)} · Final record: ${onlineSession.duelWins} duel wins · ${onlineSession.tournamentWins || 0} tournament wins</p>` : ''}<button class="button primary" data-action="online-create" ${creatorValid() && !onlineBusy ? '' : 'disabled'}>${state.locked[0] ? 'Enter another tournament' : 'Enter tournament'} <span aria-hidden="true">→</span></button><details class="tournament-invite-join"><summary>Join friends with a lobby code</summary><div class="compact-room-join"><label class="sr-only" for="room-code">Lobby code</label><input id="room-code" data-room-code maxlength="6" value="${esc(roomCodeDraft)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="LOBBY CODE"><button class="button secondary" data-action="online-join" ${creatorValid() && roomCodeDraft.trim().length === 6 && !onlineBusy ? '' : 'disabled'}>Join lobby</button></div></details><p class="build-note tournament-entry-note">Eight fighters. One duel at a time. Watch from the stands until your match.</p></section>`;
  if (onlineSession?.pendingMercyRoom) return `<section class="panel online-setup"><div class="panel-header"><h2>Awaiting the verdict</h2><span class="badge">Room ${esc(onlineSession.pendingMercyRoom)}</span></div><div class="online-setup-body"><p>You forfeited the duel. Your rival has a brief window to choose mercy before this gladiator can enter another room.</p><p class="duel-deadline"><span data-deadline="${onlineSession.pendingMercyDeadline}">${Math.max(0, Math.ceil((onlineSession.pendingMercyDeadline - Date.now()) / 1000))}</span>s remaining · timeout: spare</p><p class="build-note">The verdict and your character’s record will update here automatically.</p></div></section>`;
  return `<section class="creator-actions" aria-label="Enter a duel">${onlineSession?.character && !onlineSession.alive ? `<p class="memorial-note">${esc(onlineSession.character.name)} · Final record: ${onlineSession.duelWins} wins</p>` : ''}${onlineReplacement ? `<button class="button primary" data-action="online-replacement" ${creatorValid() && !onlineBusy ? '' : 'disabled'}>Ready for rematch</button>` : `<button class="button primary" data-action="online-create" ${creatorValid() && !onlineBusy ? '' : 'disabled'}>Create room</button><div class="compact-room-join"><label class="sr-only" for="room-code">Room code</label><input id="room-code" data-room-code maxlength="6" value="${esc(roomCodeDraft)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ROOM CODE"><button class="button secondary" data-action="online-join" ${creatorValid() && roomCodeDraft.trim().length === 6 && !onlineBusy ? '' : 'disabled'}>Join room</button></div>`}</section>`;
}
function modePicker() {
  return `<div class="mode-toggle" aria-label="Game mode"><button data-action="mode" data-value="online" aria-pressed="${onlineMode()}" class="${onlineMode() ? 'selected' : ''}">${tournamentEnabled ? 'Tournament' : 'Online duel'}</button><button data-action="mode" data-value="cpu" aria-pressed="${state.mode === 'cpu'}" class="${state.mode === 'cpu' ? 'selected' : ''}">Practice</button><button data-action="mode" data-value="hotseat" aria-pressed="${state.mode === 'hotseat'}" class="${state.mode === 'hotseat' ? 'selected' : ''}">Pass & play</button></div>`;
}
function nameScreen() {
  const index = state.nameIndex;
  return `${header()}<section class="name-screen"><span class="eyebrow">${state.mode === 'hotseat' ? `Player ${index + 1} · ` : ''}1 / 2</span><h1>NAME YOUR FIGHTER.</h1><form class="name-form"><label class="sr-only" for="name-${index}">Fighter name</label><input id="name-${index}" name="name-${index}" maxlength="24" value="${esc(state.drafts[index].name)}" data-name="${index}" autocomplete="off" placeholder="Your fighter’s name" autofocus><button type="submit" class="button primary" data-action="name-next" data-index="${index}" ${nameValid(index) ? '' : 'disabled'}>Continue <span aria-hidden="true">→</span></button></form>${index === 1 || state.creatorStep === 'name' && state.drafts[index].name ? '<button class="button ghost" data-action="name-back">Back</button>' : ''}${onlineReplacement ? '' : `<div class="onboarding-modes">${modePicker()}</div>`}</section>`;
}
function creator() {
  if (!presetReview && state.creatorStep === 'name') return nameScreen();
  const valid = creatorValid();
  const index = onlineMode() ? 0 : state.creatorIndex;
  return `${header()}${presetReview ? '<aside class="preset-review-notice" role="note"><strong>Appearance preset review</strong><span>Ten male and ten female identities. Choose a face to inspect the complete gladiator.</span></aside>' : ''}<section class="creator-heading"><div><span class="eyebrow">2 / 2 · ${state.locked[index] ? 'Returning fighter' : 'Create your fighter'}</span><h1>${esc(state.drafts[index].name)}</h1></div>${state.locked[index] ? '' : `<button class="button ghost" data-action="rename" data-index="${index}">Change name</button>`}</section>
    ${!onlineMode() ? `<div class="creator-player-tabs" aria-label="Choose fighter"><button class="button ${index === 0 ? 'secondary' : 'ghost'}" data-action="creator-player" data-index="0" aria-pressed="${index === 0}">${state.mode === 'hotseat' ? 'Player one' : 'Your fighter'}</button><button class="button ${index === 1 ? 'secondary' : 'ghost'}" data-action="creator-player" data-index="1" aria-pressed="${index === 1}">${state.mode === 'hotseat' ? 'Player two' : 'Practice rival'}</button></div>` : ''}
    <div class="${presetReview ? 'review-creator-layout' : 'compact-creator-layout'}">${presetReview ? `${editor(0)}${editor(1)}` : editor(index)}</div>
    ${onlineMode() ? onlineSetupPanel() : `<div class="creator-actions"><button class="button primary" data-action="create" ${valid ? '' : 'disabled'}>Choose equipment <span aria-hidden="true">→</span></button></div>`}${presetReview || onlineReplacement ? '' : `<details class="creator-game-mode"><summary>Game mode</summary>${modePicker()}</details>`}`;
}
function loadout() {
  const index = state.picker;
  const character = state.profiles[index].character;
  const rival = state.profiles[1 - index].character;
  const gear = state.loadouts[index];
  if (onlineMode() && onlineView.ready[index]) return `${header()}${onlineRoomBar()}<section class="secret-screen panel online-wait"><span class="eyebrow">Your equipment is locked</span><h1>Waiting for ${esc(rival.name)}.</h1><p>Your loadout stays private. Both fighters enter the arena when the second loadout commits.</p><div class="arena-identity-preview"><figure class="arena-identity-figure">${renderCleanAvatar(character.appearance, 'battle', gear)}<figcaption>${esc(WEAPONS[gear.weapon].name)} · ${esc(ARMORS[gear.armor].name)} · visible only to you</figcaption></figure></div>${deadlineMarkup()}</section>`;
  return `${header()}${onlineMode() ? onlineRoomBar() : ''}<section class="preparation-heading"><span class="eyebrow">${tournamentView ? esc(tournamentView.bracket[tournamentView.currentMatchIndex]?.label || 'Tournament') : 'Before the duel'} · ${state.mode === 'hotseat' ? `Player ${index + 1}` : 'Your preparation'}</span><h1>Equip ${esc(character.name)}.</h1><p>Facing <strong>${esc(rival.name)}</strong>. Choose your equipment before the gates open.</p>${onlineMode() ? deadlineMarkup() : ''}<details class="preparation-rival"><summary>${esc(rival.name)}’s attributes</summary>${statChips(rival)}</details></section>
    ${renderArmory({ character, gear, index })}
    <div class="setup-footer preparation-footer"><div>${buildPreview(character, gear)}<p>Health and stamina refill for each duel. Equipment stays private until both fighters are ready.</p></div><button class="button primary" data-action="lock-loadout" ${onlineBusy ? 'disabled' : ''}>Ready for battle <span aria-hidden="true">→</span></button></div>${tournamentView ? renderTournamentBracket(tournamentView) : ''}`;
}
function fighterCard(index) {
  const fighter = state.duel.fighters[index];
  const record = state.profiles[index];
  const readiness = fighterReadiness(index, battleContext());
  const lowHp = fighter.hp <= fighter.maxHp * .25;
  return `<section class="combatant-card fighter-status ${onlineMode() && index === onlineView.you ? 'your-fighter' : ''} ${lowHp ? 'critical-health' : ''}"><div class="status-heading"><h2 class="fighter-name">${esc(fighter.character.name)}</h2>${bannerChip(fighter.character, onlineMode() ? index === onlineView.you ? 'You' : 'Rival' : index === 0 ? 'West' : 'East')}</div><p>${esc(WEAPONS[fighter.weapon].name)} · ${esc(ARMORS[fighter.armor].name)} <span class="status-record">· ${record.duelWins} ${record.duelWins === 1 ? 'win' : 'wins'}</span></p>
    <div class="meter-label"><span><abbr title="Health">HP</abbr>${lowHp && fighter.hp > 0 ? '<span class="critical-label"> Low</span>' : ''}</span><strong>${fighter.hp} / ${fighter.maxHp}</strong></div><progress class="meter health" max="${fighter.maxHp}" value="${fighter.hp}" aria-label="${esc(fighter.character.name)} health"></progress>
    <div class="meter-label"><span><abbr title="Stamina">SP</abbr></span><strong>${fighter.stamina} / ${fighter.maxStamina}</strong></div><progress class="meter stamina" max="${fighter.maxStamina}" value="${fighter.stamina}" aria-label="${esc(fighter.character.name)} stamina"></progress><div class="fighter-readiness"><span>${esc(readiness)}</span><small class="initiative-note">Initiative ${fighter.speed}</small></div></section>`;
}
function battleContext() {
  return { duel: state.duel, mode: state.mode, phase: state.phase, viewer: onlineMode() ? onlineView.you : state.actionTurn, pending: onlineMode() ? onlineView.pending : state.pending.map(Boolean), busy: onlineBusy, offline: onlineOffline };
}
function actionHint(option, fighter) {
  if (option.id === 'strike') return 'Reliable damage. Guard reduces it.';
  if (option.id === 'guard') return 'Block most attacks. Feints, guard breaks, and flail sweeps get through.';
  if (option.id === 'recover') return 'Restore stamina. Acts last, leaving you exposed.';
  return {
    sword: 'Bypass Guard and half of armor.',
    spear: 'Act before ordinary attacks. Guard can stop it.',
    axe: 'Break through Guard. Acts after ordinary attacks.',
    flail: 'Sweep around Guard. Armor still protects the target.',
    halberd: 'Only a quarter of armor protects. Acts late; Guard reduces it.',
    mace: 'Ignore equipment armor. Personal Defense and Guard still protect.',
    greatsword: 'Powerful sweep through half of armor. Acts late; Guard reduces it.',
  }[fighter.weapon];
}
function actionPanel() {
  if (state.phase === 'execution') return `<div class="control-panel execution-status" role="status">${esc(executionPlayback?.event.text)}</div>`;
  if (state.phase === 'outcome') return '<div class="control-panel" role="status">Final verdict</div>';
  if (state.phase === 'playback') {
    const names = state.pending.map((id, index) => getActionOptions(state.beforeRound, index).find(option => option.id === id)?.name || id);
    return `<div class="control-panel resolution-panel"><span class="eyebrow">Round ${state.beforeRound.round} · Choices revealed</span><h2>${esc(names[0])} <span class="versus">vs</span> ${esc(names[1])}</h2><p>Moves resolve by priority, then initiative.</p><div class="resolution-status" role="status"><span aria-hidden="true">◆</span> Resolving the round…</div><small>The next round begins automatically.</small></div>`;
  }
  if (state.duel.status !== 'active') return onlineMode() ? onlineResultPanel() : resultPanel();
  const index = state.actionTurn;
  const fighter = state.duel.fighters[index];
  const options = getActionOptions(state.duel, index);
  const committed = onlineMode() && onlineView.pending[index];
  const phase = battlePhase(battleContext());
  const preview = options.find(option => option.id === state.previewAction) || options[0];
  const available = !committed && !onlineBusy && !onlineOffline;
  const detail = available ? commandPreviewMarkup(preview, fighter) : `<strong>${esc(phase.label)}</strong><span>${committed ? 'Both moves will reveal together.' : onlineOffline ? 'Your duel will update when the connection returns.' : 'Your choice is being sent to the arena.'}</span>`;
  return `<div class="control-panel command-panel"><div class="command-heading"><span class="eyebrow">${esc(fighter.character.name)} · Battle commands</span><h2>${esc(phase.label)}</h2></div>${choiceTimerMarkup()}<div class="action-grid">${options.map((option, optionIndex) => `<button class="action-card command-${option.id} ${available && option.id === preview.id ? 'previewed' : ''}" title="${esc(option.description)}" aria-describedby="command-preview" data-action="fight" data-value="${option.id}" ${option.enabled && available ? '' : 'disabled'}><span class="command-top"><span class="choice-title"><kbd>${optionIndex + 1}</kbd> ${esc(option.name)}</span><span class="command-cost">${option.cost} SP</span></span><span class="choice-description">${esc(actionPreview(option).label)}</span>${option.enabled ? '' : '<span class="unavailable">Not enough stamina</span>'}</button>`).join('')}</div><div class="command-preview" id="command-preview">${detail}</div><small>${committed ? 'Choices reveal together when your rival is ready.' : 'Keys 1–4 · Higher priority acts first'}</small></div>`;
}
function commandPreviewMarkup(option, fighter) {
  const preview = actionPreview(option);
  return `<strong>${esc(option.name)}</strong><span>${esc(actionHint(option, fighter))}</span><small>${esc(preview.detail)} · Priority ${option.priority > 0 ? '+' : ''}${option.priority}</small>`;
}
function updateCommandPreview(value) {
  if (renderBusy || state.screen !== 'battle' || state.phase !== 'select' || state.duel?.status !== 'active') return;
  if (onlineMode() && (onlineBusy || onlineOffline || onlineView.pending[state.actionTurn])) return;
  const fighter = state.duel.fighters[state.actionTurn];
  const option = getActionOptions(state.duel, state.actionTurn).find(item => item.id === value);
  if (!option) return;
  state.previewAction = value;
  const detail = app.querySelector('.command-preview');
  if (detail) detail.innerHTML = commandPreviewMarkup(option, fighter);
  app.querySelectorAll('[data-action="fight"]').forEach(button => button.classList.toggle('previewed', button.dataset.value === value));
}
function onlineResultPanel() {
  const result = state.duel.result;
  const winner = result.winner;
  const own = onlineView.players[onlineView.you];
  if (['mercy', 'crowd'].includes(onlineView.phase)) return renderMercyPanel({
    phase: verdictReveal ? 'winner' : onlineView.phase, winnerName: state.duel.fighters[winner].character.name,
    isWinner: winner === onlineView.you, deadline: onlineView.deadline, crowdVote: onlineView.crowdVote, now: Date.now(),
    disabled: onlineBusy || onlineOffline || Date.now() < (onlineView.mercyOpensAt || 0),
  });
  const decision = onlineView.decision?.decision;
  const retired = !own.alive;
  const departed = onlineView.players.some(player => player.left);
  return `<div class="control-panel result-banner"><span class="eyebrow">Duel complete · ${own.duelWins} ${own.duelWins === 1 ? 'win' : 'wins'}</span><h2>${winner === null ? 'A draw. Both leave alive.' : decision === 'execute' ? `${esc(onlineView.players[1 - winner].character.name)} is retired.` : 'Mercy granted.'}</h2><p>${retired ? 'Your final record is preserved. Create a replacement to fight again.' : 'Your gladiator survives with the same identity and attributes.'}</p>${departed ? '<p>Your rival left the room. Leave this room to find another duel.</p>' : `<button class="button primary" data-action="rematch" ${onlineBusy || onlineView.rematchReady[onlineView.you] ? 'disabled' : ''}>${onlineView.rematchReady[onlineView.you] ? 'Ready · waiting for rival' : retired ? 'Create a replacement' : 'Ready for another duel'}</button>`}</div>`;
}
function resultPanel() {
  const result = state.duel.result;
  if (result.winner === null) return `<div class="control-panel result-banner"><span class="eyebrow">The duel ends in a draw</span><h2>Both fighters leave alive.</h2><p>After ${RULES.MAX_ROUNDS} rounds, health and stamina proportions were equal.</p><button class="button primary" data-action="rematch">Choose new equipment</button><button class="button ghost" data-action="new-session">New practice session</button></div>`;
  const winner = state.profiles[result.winner];
  const loser = state.profiles[1 - result.winner];
  const reason = result.reason === 'round-limit' ? 'The round limit was reached. Remaining health proportion, then stamina, decided the duel.' : 'Your rival is defeated. Their fate is yours to choose.';
  if (!state.decision) return renderMercyPanel({ phase: verdictReveal ? 'winner' : state.localCrowd ? 'crowd' : 'mercy',
    winnerName: winner.character.name, isWinner: !(state.mode === 'cpu' && result.winner === 1),
    deadline: state.localCrowd?.deadline || state.localMercyDeadline, crowdVote: state.localCrowd, disabled: Boolean(verdictReveal), now: Date.now(),
  });
  return `<div class="control-panel result-banner"><span class="eyebrow">${esc(winner.character.name)} · ${winner.duelWins} duel ${winner.duelWins === 1 ? 'win' : 'wins'}</span><h2>${state.decision === 'spare' ? `${esc(loser.character.name)} was spared.` : `${esc(loser.character.name)} falls for the last time.`}</h2><p>${state.decision === 'spare' ? 'Both characters can return. Choose new equipment for another duel.' : `Retired with ${loser.duelWins} duel ${loser.duelWins === 1 ? 'win' : 'wins'}. Create a new contender to face the surviving gladiator.`}</p><button class="button primary" data-action="rematch">${state.decision === 'spare' ? 'Choose new equipment' : 'Create a replacement'}</button><button class="button ghost" data-action="new-session">New practice session</button></div>`;
}
function battle() {
  const duel = state.duel;
  const entries = duel.log.slice(-14);
  const phase = battlePhase(battleContext());
  const lastMessage = state.phase === 'playback' ? 'Both choices are revealed. The round resolves automatically.' : onlineMode() && onlineOffline ? 'Connection interrupted. Reconnecting to your duel…' : onlineBusy ? 'Sending your choice…' : onlineMode() && onlineView.pending[onlineView.you] ? 'Your choice is locked. Your rival’s move stays private until both are ready.' : duel.status === 'complete' ? state.mode === 'hotseat' ? duel.result.winner === null ? 'The duel ends in a draw.' : `${duel.fighters[duel.result.winner].character.name} wins the duel.` : outcomeReason(duel, onlineMode() ? onlineView.you : 0) : roundSummary(duel);
  return `${header()}${onlineMode() ? onlineRoomBar() : ''}<div class="battle-header"><div><span class="eyebrow">${duel.status === 'active' ? `Round ${duel.round} of ${RULES.MAX_ROUNDS}` : 'Duel complete'}</span><h1>${esc(phase.label)}</h1></div><span class="badge battle-state state-${phase.id}">${state.phase === 'playback' ? 'Resolving' : duel.status === 'active' ? 'Private choices' : 'Final result'}</span></div>
    <div class="classic-battle"><section class="arena-panel"><div class="arena-stage ${state.reaction ? `reaction-${state.reaction}` : ''}"><div class="fighter-cards battle-hud">${fighterCard(0)}${fighterCard(1)}</div>${renderArena(duel, { fit: 'meet' })}${state.reaction === 'tomato' ? '<div class="tomato-effect" aria-hidden="true">🍅</div>' : ''}${state.reaction === 'cheer' ? '<div class="cheer-effect" aria-hidden="true">✦ ✦ ✦</div>' : ''}</div></section><div class="battle-console"><section class="battle-dialogue" aria-label="Battle message"><span class="eyebrow">${state.phase === 'playback' ? `Round ${duel.round} reveal` : duel.lastRound ? `Round ${duel.lastRound.round} recap` : 'The duel begins'}</span><p role="status">${esc(lastMessage)}</p><small>${state.phase === 'playback' ? 'Both moves are revealed.' : duel.status === 'complete' ? 'The duel has ended.' : onlineMode() ? 'Your rival’s chosen move stays hidden until the reveal.' : 'Both moves reveal together.'}</small></section>${actionPanel()}</div></div>
    <details class="battle-history"><summary>Battle chronicle${duel.lastRound ? ` · Round ${duel.lastRound.round}` : ''}</summary><section class="panel battle-log"><ol>${entries.length ? entries.map(entry => `<li class="log-entry ${esc(entry.type || '')}"><span class="log-round">${entry.round ? `R${entry.round}` : '•'}</span><span>${esc(entry.text || entry)}</span></li>`).join('') : '<li class="log-entry">Choose an action. Both fighters commit before the reveal.</li>'}</ol></section></details>
    <details class="help-details"><summary>Fighter attributes and counterplay</summary>${duel.fighters.map(fighter => `<h3>${esc(fighter.character.name)}</h3>${statChips(fighter.character)}`).join('')}<p>Guard acts early. Priority resolves before initiative; equal initiative alternates the first fighter. Feint, Guard Break, and Chain Sweep bypass Guard. Armor Crush ignores equipment armor, while personal Defense still helps. Recover acts late. Equipment remains locked until the duel ends.</p></details>
    ${onlineMode() ? '' : `<details class="help-details"><summary>Local crowd reactions</summary><div class="audience-controls"><button class="button ghost" data-action="reaction" data-value="cheer" aria-label="Preview crowd cheer" ${state.phase === 'playback' ? 'disabled' : ''}>Cheer</button><button class="button ghost" data-action="reaction" data-value="tomato" aria-label="Preview tomato throw" ${state.phase === 'playback' ? 'disabled' : ''}>Throw tomato</button><small>Cosmetic practice reactions.</small></div></details>`}
    `;
}
function handoff() {
  return `${header()}<section class="secret-screen panel"><span class="eyebrow">Choice locked · keep it secret</span><div class="handoff-emblem" aria-hidden="true">♜</div><h1>Pass the device to ${esc(state.profiles[state.handoff.next].character.name)}.</h1><p>${state.handoff.kind === 'loadout' ? 'The first equipment choice stays hidden until both gladiators are ready.' : 'The first combat action stays hidden until both gladiators have committed.'}</p><button class="button primary" data-action="continue-handoff">I’m ready — reveal my controls</button><small>Pass & play relies on taking turns with one device.</small></section>`;
}
function choiceTimerMarkup() {
  if (state.phase !== 'select' || state.duel?.status !== 'active') return '';
  const deadline = onlineMode() ? onlineView?.deadline : state.turnDeadline;
  if (!deadline) return '';
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const duration = (onlineMode() ? onlineView?.rules?.actionMs : RULES.TURN_SECONDS * 1000) || RULES.TURN_SECONDS * 1000;
  return `<div class="choice-clock" role="timer" data-clock-deadline="${deadline}" data-clock-duration="${duration}"><div><strong><span data-deadline="${deadline}">${seconds}</span>s</strong><span>${onlineMode() && onlineView.pending[onlineView.you] ? 'Waiting for rival' : 'Choose your move'} · timeout: Recover</span></div><progress max="${duration}" value="${Math.max(0, deadline - Date.now())}" aria-label="Time remaining to choose a move"></progress></div>`;
}
function deadlineMarkup() {
  if (!onlineView?.deadline) return '';
  const seconds = Math.max(0, Math.ceil((onlineView.deadline - Date.now()) / 1000));
  const fallback = onlineView.phase === 'equipment' ? 'default equipment' : onlineView.phase === 'mercy' ? 'spare' : 'Recover';
  return `<p class="duel-deadline" role="timer"><span data-deadline="${onlineView.deadline}">${seconds}</span>s remaining · timeout: ${fallback}</p>`;
}
function onlineRoomBar() {
  const active = ['equipment', 'entrance', 'battle'].includes(onlineView.phase);
  return `<div class="online-room-bar"><span>ROOM <strong>${esc(onlineView.code)}</strong></span><button class="button ghost" data-action="copy-room" ${['playback', 'execution'].includes(state.phase) ? 'disabled' : ''}>Copy code</button><span class="connection-status" role="status">${onlineOffline ? 'Reconnecting…' : 'Connected'}</span><button class="button ghost leave-room" data-action="online-leave" ${onlineBusy ? 'disabled' : ''}>${active ? 'Forfeit & leave' : 'Leave room'}</button></div>`;
}
function onlineLobby() {
  const own = onlineView.players[onlineView.you];
  const identityNote = onlineClient.sessionMode === 'temporary' ? 'Each fresh game tab has its own fighter. Reloading keeps it; closing the tab ends its session.' : 'Another tab in the same browser shares your guest identity. Use a separate profile, browser, or device for your rival.';
  return `${header()}${onlineRoomBar()}<section class="home-hero"><span class="eyebrow">Your challenger is on the way</span><h1>Room ${esc(onlineView.code)}</h1><p>Share this code and the game address with your rival. They create their own gladiator and choose Join room.</p></section><section class="panel room-lobby"><div class="arena-identity-preview"><figure class="arena-identity-figure">${renderCleanAvatar(own.character.appearance, 'battle', state.loadouts[onlineView.you])}<figcaption>${esc(own.character.name)} · ${own.duelWins} duel wins</figcaption></figure></div><div><span class="eyebrow">Waiting for player two</span><h2>The laurel awaits a rival.</h2>${statChips(own.character)}<p>No equipment is revealed in the lobby. Both players choose privately after joining.</p><p class="build-note">${identityNote}</p></div></section>`;
}
function updateOnlineIndicators() {
  app.querySelectorAll('[data-deadline]').forEach(element => { element.textContent = Math.max(0, Math.ceil((Number(element.dataset.deadline) - Date.now()) / 1000)); });
  const status = app.querySelector('.connection-status');
  if (status) status.textContent = onlineOffline ? 'Reconnecting…' : 'Connected';
  app.querySelectorAll('[data-clock-deadline]').forEach(clock => {
    const remaining = Math.max(0, Number(clock.dataset.clockDeadline) - Date.now());
    const bar = clock.querySelector('progress');
    if (bar) bar.value = remaining;
    clock.classList.toggle('urgent', remaining <= 5000);
  });
}
function useOnlineSession(session) {
  const wasLocked = state.locked[0];
  onlineSessionNeedsRefresh = false;
  onlineSession = session;
  if (session?.character && !session.alive && deathReceipt(session.character.id) !== 'complete' && !appReady) {
    arrival?.dispose(); arrivalComplete = true;
  }
  if (session?.character && session.alive) {
    state.drafts[0] = structuredClone(session.character);
    state.locked[0] = true;
    state.creatorStep = 'customize';
    state.creatorIndex = 0;
  } else {
    if (wasLocked || state.drafts[0].id) {
      state.drafts[0] = structuredClone(state.drafts[0]);
      delete state.drafts[0].id;
      if (session?.character && !session.alive) state.drafts[0].name = `${session.character.name.slice(0, 20)} II`;
      state.creatorStep = 'name'; state.nameIndex = 0; state.creatorIndex = 0;
    }
    state.locked[0] = false;
    if (session?.character && !session.alive && deathReceipt(session.character.id) === 'complete') {
      state.drafts[0] = defaults()[0]; state.creatorStep = 'name'; state.nameIndex = 0; state.creatorIndex = 0;
    }
  }
}
function stopSpectatorPlayback() {
  spectatorPlayback?.controller.abort();
  spectatorPlayback = null;
  queuedSpectatorView = null;
}
function newestView(current, incoming) {
  return !current || current.code !== incoming.code || incoming.revision > current.revision ? incoming : current;
}
function stopVerdictReveal() {
  clearTimeout(verdictTimer); verdictReveal = null; queuedVerdictView = null;
}
function revealWinner(key, until) {
  if (revealedWinners.has(key) || until <= Date.now()) { revealedWinners.add(key); return; }
  stopVerdictReveal(); revealedWinners.add(key);
  const reveal = { key, until }; verdictReveal = reveal;
  verdictTimer = setTimeout(() => {
    if (verdictReveal !== reveal) return;
    verdictReveal = null;
    const latest = queuedVerdictView; queuedVerdictView = null;
    if (reveal.execution) startExecutionPlayback({ ...reveal.execution, outcome: reveal.outcome }, latest);
    else if (reveal.outcome) startLoserOutcome(reveal.outcome, latest);
    else if (latest) applyOnlineView(latest, { animate: false, execution: true, outcome: true, force: true });
    else if (!onlineMode() && state.mode === 'cpu' && state.duel?.result?.winner === 1 && !state.decision) resolveLocalVerdict('spare');
    else void render();
  }, Math.max(0, until - Date.now()));
}
function ensureWinnerReveal() {
  if (state.phase !== 'select' || state.duel?.status !== 'complete' || state.decision || state.duel.result.winner === null) return;
  if (onlineMode()) {
    const view = tournamentView || onlineView, match = publicMatch(view);
    if (match?.phase === 'mercy') revealWinner(verdictKey(view), Number(match.mercyOpensAt || 0));
  }
}
function resetTemporarySession(session) {
  onlineEpoch += 1; onlineView = null; onlineReplacement = false;
  onlineClient.resetMatchContext?.();
  newSession();
  useOnlineSession(session);
  onlineOffline = false;
  state.error = session?.character ? `The arena closed. Your fighter can enter another ${tournamentEnabled ? 'tournament' : 'duel'}.` : 'Your temporary session ended. Create a new fighter.';
}
function stopLocalMercy() {
  clearTimeout(localMercyTimer); clearTimeout(localCrowdTimer);
  state.localMercyDeadline = null; state.localCrowd = null;
}
function beginLocalMercy() {
  stopLocalMercy();
  const duel = state.duel, opensAt = Date.now() + 5000;
  state.localMercyDeadline = opensAt + 20000;
  revealWinner(`local:${localDuelId}`, opensAt);
  localMercyTimer = setTimeout(() => {
    if (!onlineMode() && state.duel === duel && !state.decision && !state.localCrowd) resolveLocalVerdict('spare');
  }, Math.max(0, state.localMercyDeadline - Date.now()));
}
function beginLocalCrowd() {
  clearTimeout(localMercyTimer);
  const now = Date.now(), duel = state.duel;
  const seed = duel.fighters.reduce((sum, fighter) => [...fighter.character.name].reduce((value, letter) => value + letter.charCodeAt(0), sum), localDuelId);
  const votes = Array.from({ length: 6 }, (_, index) => ({ at: now + (3 + index * 2) * 1000,
    decision: (seed + index * 17) % 5 < 3 ? 'spare' : 'execute' }));
  const crowd = { deadline: now + 20000, eligibleCount: 6, counts: { spare: 0, execute: 0 }, yourVote: null, canVote: false, votes: 0 };
  state.localCrowd = crowd;
  const advance = () => {
    if (state.duel !== duel || state.localCrowd !== crowd || state.decision || onlineMode()) return;
    while (crowd.votes < votes.length && Date.now() >= votes[crowd.votes].at) crowd.counts[votes[crowd.votes++].decision] += 1;
    if (Date.now() >= crowd.deadline) { resolveLocalVerdict(crowd.counts.execute > crowd.counts.spare ? 'execute' : 'spare'); return; }
    void render();
    localCrowdTimer = setTimeout(advance, Math.max(0, (votes[crowd.votes]?.at || crowd.deadline) - Date.now()));
  };
  advance();
}
function resolveLocalVerdict(decision) {
  if (onlineMode() || state.duel?.status !== 'complete' || state.decision || !['spare', 'execute'].includes(decision)) return;
  const winner = state.duel.result.winner;
  if (![0, 1].includes(winner)) return;
  stopLocalMercy(); stopVerdictReveal(); state.decision = decision;
  const loser = 1 - winner;
  if (decision === 'execute') state.profiles[loser].alive = false;
  const isHumanLoser = state.mode === 'hotseat' || loser === 0;
  const outcome = isHumanLoser ? { decision, profileId: state.profiles[loser].character.id, duel: state.duel, loser, online: false } : null;
  if (decision === 'execute') {
    const event = buildExecutionEvent(state.duel, { decision, winner, loser }), key = `local:${localDuelId}`;
    if (event && !observedExecutions.has(key)) {
      observedExecutions.add(key); startExecutionPlayback({ event, duel: state.duel, outcome, online: false }); return;
    }
  }
  if (outcome) startLoserOutcome(outcome);
  else void render();
}
const publicMatch = view => view?.type === 'tournament' ? view.match : view;
const verdictKey = view => `${view?.tournamentId || view?.code}:${publicMatch(view)?.duelId}`;
const deathKey = id => `arena-fighters.death-v1:${id}`;
function deathReceipt(id) {
  if (!id) return null;
  try { return globalThis.sessionStorage?.getItem(deathKey(id)) || fallbackDeathReceipts.get(id) || null; }
  catch { return fallbackDeathReceipts.get(id) || null; }
}
function rememberDeath(id, phase) {
  if (!id) return;
  fallbackDeathReceipts.set(id, phase);
  try { globalThis.sessionStorage?.setItem(deathKey(id), phase); } catch { /* The live flow still completes without storage. */ }
}
function captureLoserOutcome(view, enabled) {
  const match = publicMatch(view), decision = match?.decision;
  const winner = match?.duel?.result?.winner;
  if (match?.duel?.status !== 'complete' || ![0, 1].includes(winner) || !['spare', 'execute'].includes(decision?.decision)
    || decision.winner !== winner || decision.loser !== 1 - winner) return null;
  const viewer = view.type === 'tournament' ? match.slots.indexOf(view.you) : view.you;
  if (viewer !== decision.loser) return null;
  const profileId = match.players[viewer]?.character?.id;
  const key = verdictKey(view);
  if (observedOutcomes.has(key) || decision.decision === 'execute' && deathReceipt(profileId) === 'complete') return null;
  if (!enabled && decision.decision !== 'execute') return null;
  observedOutcomes.add(key);
  return { decision: decision.decision, profileId, duel: structuredClone(match.duel), view: structuredClone(view), online: true };
}
// Only an observed live verdict transition earns a cinematic. Reconnecting to
// an already resolved snapshot must not repeat a character's execution.
function captureExecution(view, enabled) {
  const match = view?.type === 'tournament' ? view.match : view;
  const event = buildExecutionEvent(match?.duel, match?.decision);
  if (!event || !match.duelId) return null;
  const key = `${view.tournamentId || view.code}:${match.duelId}`;
  if (observedExecutions.has(key)) return null;
  const previous = tournamentView?.match || onlineView;
  const live = enabled && previous?.code === match.code && previous?.duelId === match.duelId && previous.decision?.decision !== 'execute';
  observedExecutions.add(key);
  return live ? { event, duel: structuredClone(match.duel), view: structuredClone(view), online: true,
    nativeScreen: view.type === 'tournament' && match.you === null ? 'tournament-spectator' : 'battle' } : null;
}
function stopExecutionPlayback() {
  executionPlayback?.controller.abort();
  if (executionPlayback) { state.phase = 'select'; state.screen = tournamentView ? 'tournament-spectator' : 'battle'; }
  executionPlayback = null;
  queuedExecutionView = null;
}
function startExecutionPlayback(candidate, latest = null) {
  if (!candidate || executionPlayback) return false;
  stopLocalTurnClock();
  clearTimeout(reactionTimer);
  state.reaction = null;
  state.duel = candidate.duel;
  state.decision = 'execute';
  state.phase = 'execution';
  state.screen = candidate.nativeScreen || 'battle';
  if (candidate.online) {
    const match = publicMatch(candidate.view);
    state.profiles = match.players.map(player => ({ ...player }));
    if (candidate.view.type === 'tournament') tournamentView = candidate.view;
    onlineView = state.screen === 'battle' ? { ...match, rematchReady: [false, false] } : candidate.view;
    queuedExecutionView = latest;
  }
  const transition = { ...candidate, controller: new AbortController() };
  executionPlayback = transition;
  void runExecutionPlayback(transition);
  return true;
}
async function runExecutionPlayback(transition) {
  try {
    await render({ keepExecution: true, retainArena: true });
    if (transition !== executionPlayback || !['battle', 'tournament-spectator'].includes(state.screen)) return;
    await playExecutionAnimation(app.querySelector('.arena-stage'), transition.event, { signal: transition.controller.signal });
  } catch (error) {
    if (transition === executionPlayback) state.error = `The verdict is final. Its animation could not finish: ${error.message}`;
  } finally {
    if (transition === executionPlayback) {
      executionPlayback = null;
      state.phase = 'select';
      const latest = queuedExecutionView;
      queuedExecutionView = null;
      if (transition.outcome) startLoserOutcome(transition.outcome, latest);
      else if (transition.online) applyOnlineView(latest || transition.view, { animate: false, force: true });
      else { state.screen = 'battle'; await render(); }
    }
  }
}
function stopLoserOutcome() {
  outcomePlayback?.controller.abort();
  outcomePlayback = null;
  queuedOutcomeView = null;
  clearTimeout(deathRetryTimer);
  if (state.phase === 'outcome') state.phase = 'select';
}
function startLoserOutcome(candidate, latest = null) {
  if (!candidate || outcomePlayback) return false;
  stopLocalTurnClock();
  state.phase = 'outcome';
  if (candidate.decision === 'execute') rememberDeath(candidate.profileId, 'pending');
  const transition = { ...candidate, controller: new AbortController(), epoch: onlineEpoch };
  outcomePlayback = transition;
  queuedOutcomeView = latest;
  void runLoserOutcome(transition);
  return true;
}
function resumeDeathSession() {
  const profileId = onlineSession?.character?.id;
  if (!onlineMode() || onlineSession?.alive !== false || !profileId || deathReceipt(profileId) === 'complete' || executionPlayback || outcomePlayback) return;
  startLoserOutcome({ decision: 'execute', profileId, online: true, view: tournamentView || onlineView });
}
async function runLoserOutcome(transition) {
  try {
    await render({ keepOutcome: true });
    if (transition !== outcomePlayback) return;
    await playLoserOutcome(app, transition.decision, { signal: transition.controller.signal, hold: transition.decision === 'execute' });
  } catch (error) {
    if (transition === outcomePlayback) state.error = `The verdict is final. ${error.message}`;
  } finally {
    if (transition === outcomePlayback) {
      if (transition.decision === 'execute') await resetAfterDeath(transition);
      else {
        outcomePlayback = null; state.phase = 'select';
        const latest = queuedOutcomeView; queuedOutcomeView = null;
        if (transition.online) applyOnlineView(latest || transition.view, { animate: false, force: true });
        else await render();
      }
    }
  }
}
async function resetAfterDeath(transition) {
  if (transition !== outcomePlayback || transition.controller.signal.aborted) return;
  try {
    if (transition.online) {
      let session = await onlineClient.session({ create: false });
      if (transition !== outcomePlayback || transition.epoch !== onlineEpoch) return;
      if (session?.alive && session.character?.id && session.character.id !== transition.profileId) {
        await adoptLivingReplacement(transition, session); return;
      }
      const code = session?.activeTournament || session?.activeRoom;
      if (code) {
        const latest = await onlineClient.room(code);
        if (transition !== outcomePlayback || transition.epoch !== onlineEpoch) return;
        const result = await onlineClient.command(latest, 'leave');
        if (!result?.left) throw new Error('The arena has not acknowledged your departure.');
      }
      session = await onlineClient.session({ create: false });
      if (transition !== outcomePlayback || transition.epoch !== onlineEpoch) return;
      if (session?.activeTournament || session?.activeRoom) throw new Error('Reconnecting before leaving the arena.');
      if (session?.character?.id && session.character.id !== transition.profileId && session.alive) {
        await adoptLivingReplacement(transition, session); return;
      }
      onlineSession = session; onlineSessionNeedsRefresh = false;
      onlineClient.resetMatchContext?.();
      onlineEpoch += 1; onlineView = null; tournamentView = null;
    }
    if (transition !== outcomePlayback) return;
    transition.controller.abort();
    rememberDeath(transition.profileId, 'complete');
    outcomePlayback = null; queuedOutcomeView = null;
    stopVerdictReveal(); stopLocalMercy(); stopSpectatorPlayback(); cancelRoundPlayback();
    state.screen = 'creator'; state.phase = 'select'; state.duel = null;
    if (!transition.online && state.mode === 'hotseat') {
      const replacement = defaults()[transition.loser]; replacement.name = '';
      state.drafts = state.profiles.map((profile, index) => index === transition.loser ? replacement : structuredClone(profile.character));
      state.locked = state.profiles.map(profile => profile.alive);
      state.nameIndex = transition.loser; state.creatorIndex = transition.loser;
    } else {
      state.profiles = []; state.drafts = defaults(); state.locked = [false, false]; state.nameIndex = 0; state.creatorIndex = 0;
    }
    state.creatorStep = 'name';
    state.pending = [null, null]; state.decision = null; state.error = ''; state.reaction = null;
    onlineReplacement = false;
    arrivalComplete = false;
    if (!arrival?.replay(app)) { arrivalComplete = true; await render(); }
  } catch (error) {
    if (transition !== outcomePlayback) return;
    state.error = `Reconnecting before your next fighter: ${error.message}`;
    deathRetryTimer = setTimeout(() => { if (transition === outcomePlayback) void resetAfterDeath(transition); }, 1000);
  }
}
async function adoptLivingReplacement(transition, session) {
  if (transition !== outcomePlayback) return;
  transition.controller.abort(); rememberDeath(transition.profileId, 'complete');
  outcomePlayback = null; queuedOutcomeView = null; state.phase = 'select'; state.screen = 'creator'; state.duel = null;
  onlineView = null; tournamentView = null; onlineEpoch += 1;
  const epoch = onlineEpoch; useOnlineSession(session);
  const code = session.activeTournament || session.activeRoom;
  if (code) {
    onlineClient.legacyRoom = !session.activeTournament && Boolean(session.activeRoom);
    try {
      const view = await onlineClient.room(code);
      if (epoch !== onlineEpoch || !onlineMode()) return;
      applyOnlineView(view, { animate: false });
    } catch (error) {
      if (epoch !== onlineEpoch || !onlineMode()) return;
      onlineSessionNeedsRefresh = true; onlineOffline = true;
      state.error = `Reconnecting your surviving fighter: ${error.message}`; await render();
    }
  } else await render();
}
function tournamentEntrance() {
  return `${header()}${renderTournamentEntrance(tournamentView)}`;
}
function mountTournamentGate() {
  const video = app.querySelector('.tournament-gate-video');
  if (!video || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  video.muted = true;
  const elapsed = Math.max(0, (Date.now() - (tournamentView.match.deadline - tournamentView.match.rules.entranceMs)) / 1000);
  video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(elapsed, Math.max(0, video.duration - .1)); }, { once: true });
  void video.play().catch(() => { const button = app.querySelector('[data-action="gate-play"]'); if (button) button.hidden = false; });
}
async function runSpectatorPlayback(transition) {
  try {
    await render();
    if (transition !== spectatorPlayback) return;
    await playBattleAnimation(app.querySelector('.arena-stage'), transition.steps, { signal: transition.controller.signal });
  } catch (error) {
    if (transition === spectatorPlayback) state.error = `The round resolved. Its animation could not finish: ${error.message}`;
  } finally {
    if (transition === spectatorPlayback) {
      spectatorPlayback = null;
      state.phase = 'select';
      state.duel = transition.after;
      const latest = queuedSpectatorView;
      queuedSpectatorView = null;
      if (transition.execution) startExecutionPlayback({ ...transition.execution, outcome: transition.outcome }, latest);
      else if (transition.outcome) startLoserOutcome(transition.outcome, latest);
      else if (latest) applyTournamentView(latest, { animate: false, execution: true, outcome: true, force: true });
      else await render();
    }
  }
}
function applyTournamentView(view, { animate = true, execution = animate, outcome = animate, force = false } = {}) {
  if (!onlineMode()) return;
  if (!force && tournamentView?.code === view.code && view.revision <= tournamentView.revision) { updateOnlineIndicators(); return; }
  if (outcomePlayback) { queuedOutcomeView = newestView(queuedOutcomeView, view); updateOnlineIndicators(); return; }
  if (executionPlayback) { queuedExecutionView = newestView(queuedExecutionView, view); updateOnlineIndicators(); return; }
  const cinematic = captureExecution(view, execution || Boolean(roundPlayback || spectatorPlayback));
  const loserOutcome = captureLoserOutcome(view, outcome || Boolean(roundPlayback || spectatorPlayback || verdictReveal));
  if (verdictReveal) { verdictReveal.execution ||= cinematic; verdictReveal.outcome ||= loserOutcome; queuedVerdictView = newestView(queuedVerdictView, view); return; }
  if (roundPlayback) { roundPlayback.execution ||= cinematic; roundPlayback.outcome ||= loserOutcome; queuedOnlineView = newestView(queuedOnlineView, view); updateOnlineIndicators(); return; }
  if (spectatorPlayback) { spectatorPlayback.execution ||= cinematic; spectatorPlayback.outcome ||= loserOutcome; queuedSpectatorView = newestView(queuedSpectatorView, view); updateOnlineIndicators(); return; }
  const previous = tournamentView;
  const before = state.duel;
  tournamentView = view;
  onlineOffline = false;
  const match = view.match;
  const duelist = match && match.you !== null && ['equipment', 'entrance', 'battle', 'mercy', 'crowd'].includes(view.phase);
  if (duelist && view.phase !== 'entrance') {
    applyOnlineView({ ...match, rematchReady: [false, false] }, { animate, execution: false, outcome: false, cinematic, loserOutcome, force: force || previous?.match?.duelId !== match.duelId });
    return;
  }
  onlineView = view;
  state.duel = match?.duel ?? null;
  state.profiles = match?.players.map(player => ({ ...player })) ?? [];
  state.phase = 'select';
  state.decision = match?.decision?.decision ?? null;
  state.screen = view.phase === 'waiting' ? 'tournament-lobby' : view.phase === 'entrance' ? 'tournament-entrance' : 'tournament-spectator';
  if (duelist) { state.picker = match.you; state.actionTurn = match.you; }
  if (animate && state.screen === 'tournament-spectator' && previous?.match?.duelId === match?.duelId && before?.status === 'active' && match?.duel?.lastRound?.round === before.round && match.duel.log.length > before.log.length) {
    state.duel = before;
    state.phase = 'playback';
    const transition = { before, after: match.duel, execution: cinematic, outcome: loserOutcome, controller: new AbortController(), steps: buildAnimationSteps(before, match.duel) };
    spectatorPlayback = transition;
    void runSpectatorPlayback(transition);
    return;
  }
  if (cinematic) { startExecutionPlayback({ ...cinematic, outcome: loserOutcome }); return; }
  if (loserOutcome) { startLoserOutcome(loserOutcome); return; }
  void render();
}
function applyOnlineView(view, { animate = true, execution = animate, outcome = animate, cinematic = null, loserOutcome = null, force = false } = {}) {
  if (view?.type === 'tournament') { applyTournamentView(view, { animate, execution, outcome, force }); return; }
  if (!onlineMode()) return;
  if (!force && onlineView?.code === view.code && view.revision <= onlineView.revision) { updateOnlineIndicators(); return; }
  if (outcomePlayback) { queuedOutcomeView = newestView(queuedOutcomeView, view); updateOnlineIndicators(); return; }
  if (executionPlayback) { queuedExecutionView = newestView(queuedExecutionView, view); updateOnlineIndicators(); return; }
  cinematic ||= captureExecution(view, execution || Boolean(roundPlayback));
  loserOutcome ||= captureLoserOutcome(view, outcome || Boolean(roundPlayback || verdictReveal));
  if (verdictReveal) { verdictReveal.execution ||= cinematic; verdictReveal.outcome ||= loserOutcome; queuedVerdictView = newestView(queuedVerdictView, view); return; }
  if (roundPlayback) { roundPlayback.execution ||= cinematic; roundPlayback.outcome ||= loserOutcome; queuedOnlineView = newestView(queuedOnlineView, view); updateOnlineIndicators(); return; }
  const previous = onlineView;
  const before = state.duel;
  const enteringBattle = state.screen !== 'battle' && view.duel;
  onlineView = view;
  onlineOffline = false;
  if (onlineReplacement && previous?.duelId === view.duelId && view.phase === 'complete') { updateOnlineIndicators(); return; }
  onlineReplacement = false;
  state.profiles = view.players.map(player => player ? ({ character: player.character, alive: player.alive, duelWins: player.duelWins }) : null);
  state.picker = view.you;
  state.actionTurn = view.you;
  if (view.yourLoadout) state.loadouts[view.you] = { ...view.yourLoadout };
  state.screen = view.phase === 'waiting' ? 'online-lobby' : view.phase === 'equipment' ? 'loadout' : 'battle';
  state.decision = view.decision?.decision ?? null;
  if (view.duel) {
    if (animate && previous?.duelId === view.duelId && before?.status === 'active' && view.duel.lastRound?.round === before.round && view.duel.log.length > before.log.length) {
      state.beforeRound = before;
      state.pending = [...view.duel.lastRound.actions];
      state.phase = 'playback';
      const transition = { before, after: view.duel, execution: cinematic, outcome: loserOutcome, controller: new AbortController(), committed: false, online: true, steps: buildAnimationSteps(before, view.duel) };
      roundPlayback = transition;
      void runRoundPlayback(transition);
      return;
    }
    state.duel = view.duel;
  } else state.duel = null;
  state.phase = 'select';
  if (cinematic) { startExecutionPlayback({ ...cinematic, outcome: loserOutcome }); return; }
  if (loserOutcome) { startLoserOutcome(loserOutcome); return; }
  void render().then(() => { if (enteringBattle && state.screen === 'battle') window.scrollTo({ top: 0, behavior: 'instant' }); });
}
async function performOnline(operation) {
  if (onlineBusy) return;
  const epoch = onlineEpoch;
  onlineBusy = true;
  state.error = '';
  await render();
  try {
    const view = await operation();
    if (epoch !== onlineEpoch || !onlineMode()) return;
    if (view?.left) {
      const own = tournamentView?.players[tournamentView.you] ?? onlineView?.players[onlineView.you];
      const savedSession = { ...onlineSession, ...own, activeRoom: null, activeTournament: null };
      onlineEpoch += 1;
      onlineView = null;
      tournamentView = null;
      stopExecutionPlayback();
      stopLoserOutcome(); stopVerdictReveal();
      stopSpectatorPlayback();
      state.duel = null;
      state.screen = 'creator';
      useOnlineSession(savedSession);
      onlineSessionNeedsRefresh = true;
      useOnlineSession(await onlineClient.session());
    } else applyOnlineView(view);
  } catch (error) {
    state.error = error.message;
    if (onlineSessionNeedsRefresh) onlineOffline = true;
    if (onlineView) {
      try {
        applyOnlineView(await onlineClient.room(onlineView.code), { animate: false, execution: true, outcome: true });
        if (executionPlayback) state.error = '';
      }
      catch { onlineOffline = true; }
    }
  } finally {
    onlineBusy = false;
    if (state.phase !== 'playback' && !spectatorPlayback && !executionPlayback && !outcomePlayback) await render();
  }
}
async function pollOnline() {
  updateOnlineIndicators();
  if (!onlineMode() || onlineBusy || polling) return;
  const temporary = onlineClient.sessionMode === 'temporary';
  const heartbeat = temporary && onlineClient.token && Date.now() - lastTemporaryHeartbeat >= 15000;
  if (!onlineView && (heartbeat || onlineSessionNeedsRefresh || onlineSession?.pendingMercyRoom || onlineSession?.pendingMercyTournament)) {
    const epoch = onlineEpoch;
    const previousToken = onlineClient.token;
    const refreshCreator = onlineSessionNeedsRefresh || onlineSession?.pendingMercyRoom || onlineSession?.pendingMercyTournament || onlineOffline;
    polling = true;
    if (temporary) lastTemporaryHeartbeat = Date.now();
    try {
      const session = await onlineClient.session({ create: temporary && Boolean(previousToken) });
      if (epoch !== onlineEpoch || !onlineMode() || onlineBusy) return;
      if (temporary && previousToken && onlineClient.token !== previousToken) {
        resetTemporarySession(session); await render(); return;
      }
      const resumeActive = onlineSessionNeedsRefresh && (session?.activeTournament || session?.activeRoom);
      const waiting = session?.pendingMercyRoom || session?.pendingMercyTournament;
      const previousVerdict = onlineSession?.pendingMercyTournamentDeadline;
      useOnlineSession(session);
      onlineOffline = false;
      if (resumeActive) {
        onlineSessionNeedsRefresh = true;
        onlineClient.legacyRoom = !session.activeTournament && Boolean(session.activeRoom);
        const view = await onlineClient.room(resumeActive);
        if (epoch !== onlineEpoch || !onlineMode() || onlineBusy) return;
        onlineSessionNeedsRefresh = false; state.error = ''; applyOnlineView(view, { animate: false });
        return;
      }
      resumeDeathSession();
      if (!waiting && refreshCreator) { state.error = ''; await render(); }
      else if (previousVerdict !== session?.pendingMercyTournamentDeadline) await render();
    } catch (error) { state.error = error.message; }
    finally { polling = false; }
    return;
  }
  if (!onlineView) return;
  const epoch = onlineEpoch;
  polling = true;
  try {
    const wasOffline = onlineOffline;
    const view = await onlineClient.room(onlineView.code);
    if (epoch !== onlineEpoch || !onlineMode() || onlineBusy) return;
    onlineOffline = false;
    applyOnlineView(view);
    if (wasOffline) { state.error = ''; if (!roundPlayback && !spectatorPlayback && !executionPlayback && !outcomePlayback) await render(); }
  } catch (error) {
    if (epoch !== onlineEpoch) return;
    if (temporary && [401, 404].includes(error.status)) {
      try {
        const session = await onlineClient.session();
        if (epoch !== onlineEpoch || !onlineMode() || onlineBusy) return;
        if (!session?.activeTournament && !session?.activeRoom) {
          resetTemporarySession(session); await render(); return;
        }
      } catch { /* Keep the current duel and reconnect after a service interruption. */ }
    }
    if (!onlineOffline) {
      onlineOffline = true;
      state.error = error.message;
      if (!roundPlayback && !spectatorPlayback && !executionPlayback && !outcomePlayback) await render();
    }
  } finally { polling = false; }
}
async function render({ keepPlayback = false, keepExecution = false, keepOutcome = false, retainArena = false } = {}) {
  if (!arrivalComplete) return;
  if (executionPlayback && !keepExecution) return;
  if (outcomePlayback && !keepOutcome) return;
  if (!keepPlayback && roundPlayback) cancelRoundPlayback({ commit: true });
  ensureWinnerReveal();
  const version = ++renderVersion;
  const arenaKey = onlineMode() ? verdictKey(tournamentView || onlineView) : `local:${localDuelId}`;
  const retained = retainArena && renderedArena?.screen === state.screen && renderedArena.key === arenaKey ? renderedArena : null;
  const focused = document.activeElement?.dataset;
  renderBusy = true;
  app.inert = true;
  app.setAttribute('aria-busy', 'true');
  const requests = state.screen === 'creator'
    ? (state.creatorStep === 'name' && !presetReview ? [] : presetReview ? state.drafts : [state.drafts[onlineMode() ? 0 : state.creatorIndex]]).map(character => prepareCleanAvatar(character.appearance, 'world', IDENTITY_GEAR))
    : state.screen === 'loadout'
      ? [prepareCleanAvatar(state.profiles[state.picker].character.appearance, 'battle', state.loadouts[state.picker])]
      : ['battle', 'tournament-spectator', 'tournament-entrance'].includes(state.screen) && state.duel
        ? state.duel.fighters.map(fighter => prepareCleanAvatar(fighter.character.appearance, 'battle', { weapon: fighter.weapon, armor: fighter.armor, helmet: fighter.helmet }))
        : state.screen === 'tournament-lobby' ? tournamentView.players.filter(player => player && !player.left).map(player => prepareCleanAvatar(player.character.appearance, 'battle', IDENTITY_GEAR))
          : state.screen === 'online-lobby' ? [prepareCleanAvatar(onlineView.players[onlineView.you].character.appearance, 'battle', state.loadouts[onlineView.you])] : [];
  try { await Promise.all(requests); }
  catch (error) { if (version === renderVersion) state.error = `Character art could not load: ${error.message}`; }
  if (version !== renderVersion) return;
  if (!onlineMode() && state.screen === 'battle' && state.phase === 'select' && state.duel?.status === 'active' && !localTurnClock) armLocalTurnClock();
  const focusSelector = focused?.name !== undefined ? `[data-name="${focused.name}"]` : focused?.trait !== undefined ? `[data-trait="${focused.trait}"]` : focused?.appearance ? `[data-appearance="${focused.appearance}"][data-index="${focused.index}"]` : focused?.action ? `[data-action="${focused.action}"]${focused.index === undefined ? '' : `[data-index="${focused.index}"]`}${focused.stat ? `[data-stat="${focused.stat}"]` : ''}${focused.delta !== undefined ? `[data-delta="${focused.delta}"]` : ''}${focused.value ? `[data-value="${focused.value}"]` : ''}` : null;
  const content = state.screen === 'creator' ? creator() : state.screen === 'loadout' ? loadout() : state.screen === 'handoff' ? handoff() : state.screen === 'online-lobby' ? onlineLobby() : state.screen === 'tournament-lobby' ? `${header()}${renderTournamentLobby(tournamentView)}` : state.screen === 'tournament-spectator' ? `${header()}${renderTournamentSpectator(spectatorPlayback ? { ...tournamentView, phase: 'battle' } : tournamentView, { playing: Boolean(spectatorPlayback), duel: state.duel, verdictPhase: verdictReveal ? 'winner' : null, verdictBusy: onlineBusy || onlineOffline, executing: Boolean(executionPlayback) })}` : state.screen === 'tournament-entrance' ? tournamentEntrance() : battle();
  const notice = state.error || (onlineMode() ? onlineClient.storageWarning : null);
  app.innerHTML = `<main class="app-shell ${state.screen === 'battle' ? 'battle-shell' : state.screen === 'creator' ? 'creator-shell' : tournamentView ? 'tournament-shell' : ''}">${content}${notice ? `<div class="toast" role="alert">${esc(notice)}</div>` : ''}<footer class="page-footer">ARENA FIGHTERS <span>v0.8.6</span></footer></main>`;
  if (retained) {
    const replacementStage = app.querySelector('.arena-stage');
    const originalHud = retained.stage.querySelector('.battle-hud');
    const replacementHud = replacementStage?.querySelector('.battle-hud');
    if (originalHud && replacementHud) originalHud.replaceWith(replacementHud);
    state.duel.fighters.forEach((fighter, index) => {
      const figure = retained.stage.querySelector(`.arena-fighter[data-fighter-index="${index}"]`);
      if (fighter.hp <= 0) figure?.setAttribute('data-defeated', 'true');
      else figure?.removeAttribute('data-defeated');
    });
    const frame = retained.frame;
    const replacement = app.querySelector(frame ? '.spectator-frame' : '.arena-stage');
    replacement?.replaceWith(frame || retained.stage);
  }
  const stage = app.querySelector('.arena-stage');
  renderedArena = stage && ['battle', 'tournament-spectator'].includes(state.screen)
    ? { stage, frame: state.screen === 'tournament-spectator' ? stage.closest('.spectator-frame') : null, screen: state.screen, key: arenaKey } : null;
  renderBusy = false;
  app.inert = false;
  app.setAttribute('aria-busy', 'false');
  if (focusSelector) app.querySelector(focusSelector)?.focus({ preventScroll: true });
  if (state.screen === 'creator' && state.creatorStep === 'name' && !presetReview) app.querySelector('[data-name]')?.focus({ preventScroll: true });
  if (state.screen === 'tournament-entrance') mountTournamentGate();
}
function cpuLoadout(character) {
  const { strength, dexterity, speed, defense } = character.stats;
  const preferred = dexterity + speed >= strength + defense ? { weapon: 'spear', armor: 'light' } : strength >= defense ? { weapon: 'axe', armor: 'medium' } : { weapon: 'sword', armor: 'heavy' };
  const weapons = [preferred.weapon, ...Object.keys(WEAPONS).filter(id => id !== preferred.weapon)];
  const armors = [preferred.armor, ...Object.keys(ARMORS).filter(id => id !== preferred.armor)];
  const helmets = Object.keys(HELMETS);
  return { weapon: weapons[state.practiceDuels % weapons.length], armor: armors[Math.floor(state.practiceDuels / weapons.length) % armors.length], helmet: helmets[state.practiceDuels % helmets.length] };
}
function startLoadouts() {
  stopExecutionPlayback();
  stopLocalTurnClock();
  state.picker = 0;
  state.decision = null;
  state.screen = 'loadout';
  if (state.mode === 'cpu') state.loadouts[1] = cpuLoadout(state.profiles[1].character);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function prepareTurn() {
  stopLocalTurnClock();
  state.pending = [null, null];
  state.actionTurn = 0;
  state.phase = 'select';
  state.cpuAction = state.mode === 'cpu' ? chooseCpuAction(state.duel, 1) : null;
  state.previewAction = 'strike';
}
function stopLocalTurnClock() {
  clearTimeout(localTurnTimer);
  localTurnTimer = null;
  localTurnClock = null;
  state.turnDeadline = null;
}
function armLocalTurnClock() {
  stopLocalTurnClock();
  if (onlineMode() || state.duel?.status !== 'active' || state.phase !== 'select' || state.screen !== 'battle') return;
  const clock = { duel: state.duel, round: state.duel.round, index: state.actionTurn, deadline: Date.now() + RULES.TURN_SECONDS * 1000 };
  localTurnClock = clock;
  state.turnDeadline = clock.deadline;
  localTurnTimer = setTimeout(() => { if (clock === localTurnClock) expireLocalTurn(); }, RULES.TURN_SECONDS * 1000);
}
function expireLocalTurn() {
  const clock = localTurnClock;
  if (!clock || clock.duel !== state.duel || clock.round !== state.duel.round || clock.index !== state.actionTurn || Date.now() < clock.deadline) return;
  commitLocalAction('recover');
}
function commitLocalAction(value) {
  if (onlineMode() || state.screen !== 'battle' || state.phase !== 'select' || state.duel?.status !== 'active' || state.pending[state.actionTurn]) return;
  if (!getActionOptions(state.duel, state.actionTurn).some(option => option.id === value && option.enabled)) return;
  stopLocalTurnClock();
  state.pending[state.actionTurn] = value;
  if (state.mode === 'cpu') { state.pending[1] = state.cpuAction; finishRound(); }
  else if (state.actionTurn === 0) { state.actionTurn = 1; state.handoff = { kind: 'action', next: 1 }; state.screen = 'handoff'; void render(); }
  else finishRound();
}
function startDuel() {
  stopExecutionPlayback();
  localDuelId += 1;
  state.duel = createDuel(state.profiles.map((profile, index) => ({ character: profile.character, ...state.loadouts[index] })));
  if (state.mode === 'cpu') state.practiceDuels += 1;
  state.screen = 'battle';
  state.decision = null;
  prepareTurn();
  if (state.mode === 'hotseat') {
    state.handoff = { kind: 'action', next: 0 };
    state.screen = 'handoff';
  }
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function commitRoundPlayback(transition) {
  if (!transition || transition !== roundPlayback || transition.committed) return false;
  transition.committed = true;
  roundPlayback = null;
  state.duel = transition.after;
  state.phase = 'select';
  if (transition.online) {
    const latest = queuedOnlineView;
    queuedOnlineView = null;
    if (transition.execution) startExecutionPlayback({ ...transition.execution, outcome: transition.outcome }, latest);
    else if (transition.outcome) startLoserOutcome(transition.outcome, latest);
    else if (latest) applyOnlineView(latest, { animate: false, execution: true, outcome: true, force: true });
  } else if (state.duel.status === 'complete' && state.duel.result.winner !== null) {
    const winner = state.duel.result.winner;
    state.profiles[winner].duelWins += 1;
    beginLocalMercy();
  } else if (state.duel.status === 'active') {
    prepareTurn();
    if (state.mode === 'hotseat') { stopLocalTurnClock(); state.handoff = { kind: 'action', next: 0 }; state.screen = 'handoff'; }
  }
  return true;
}
function cancelRoundPlayback({ commit = false } = {}) {
  const transition = roundPlayback;
  if (!transition) return;
  transition.controller.abort();
  if (commit) commitRoundPlayback(transition);
  else { roundPlayback = null; queuedOnlineView = null; }
}
async function runRoundPlayback(transition) {
  try {
    await render({ keepPlayback: true });
    if (transition !== roundPlayback || state.screen !== 'battle') return;
    await playBattleAnimation(app.querySelector('.arena-stage'), transition.steps, { signal: transition.controller.signal });
  } catch (error) {
    if (transition === roundPlayback) state.error = `Combat animation could not play: ${error.message}`;
  } finally {
    if (commitRoundPlayback(transition)) await render();
  }
}
function finishRound() {
  if (roundPlayback || state.phase !== 'select') return;
  const before = state.duel;
  const after = resolveRound(before, state.pending);
  clearTimeout(reactionTimer);
  state.reaction = null;
  state.beforeRound = before;
  state.phase = 'playback';
  const transition = {
    before, after, controller: new AbortController(), committed: false,
    steps: buildAnimationSteps(before, after),
  };
  roundPlayback = transition;
  void runRoundPlayback(transition);
}
function newSession() {
  cancelRoundPlayback();
  stopExecutionPlayback();
  stopLoserOutcome(); stopVerdictReveal(); stopLocalMercy();
  stopSpectatorPlayback();
  tournamentView = null;
  stopLocalTurnClock();
  clearTimeout(reactionTimer);
  state.screen = 'creator'; state.profiles = []; state.drafts = defaults(); state.locked = [false, false];
  if (state.mode === 'hotseat') state.drafts[1].name = '';
  state.creatorStep = presetReview ? 'customize' : 'name'; state.creatorIndex = 0; state.nameIndex = 0;
  state.duel = null; state.error = ''; state.decision = null; state.practiceDuels = 0;
  state.phase = 'select'; state.pending = [null, null]; state.cpuAction = null; state.beforeRound = null; state.reaction = null; render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

app.addEventListener('input', event => {
  if (renderBusy) return;
  if (event.target.hasAttribute('data-room-code')) {
    roomCodeDraft = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    event.target.value = roomCodeDraft;
    const join = app.querySelector('[data-action="online-join"]');
    if (join) join.disabled = !creatorValid() || roomCodeDraft.length !== 6 || onlineBusy;
    return;
  }
  if (event.target.dataset.name === undefined) return;
  const index = Number(event.target.dataset.name);
  if (state.locked[index]) return;
  state.drafts[index].name = event.target.value;
  const nextName = app.querySelector('[data-action="name-next"]');
  if (nextName) nextName.disabled = !nameValid(index);
  const createButton = app.querySelector('[data-action="create"]');
  if (createButton) createButton.disabled = !creatorValid();
  app.querySelectorAll('[data-action="online-create"], [data-action="online-replacement"]').forEach(button => { button.disabled = !creatorValid() || onlineBusy; });
  const join = app.querySelector('[data-action="online-join"]');
  if (join) join.disabled = !creatorValid() || roomCodeDraft.length !== 6 || onlineBusy;
});
app.addEventListener('change', event => {
  if (renderBusy) return;
  if (event.target.dataset.trait !== undefined) {
    const index = Number(event.target.dataset.trait);
    if ([0, 1].includes(index) && !state.locked[index] && Object.hasOwn(TRAITS, event.target.value)) {
      state.drafts[index].trait = event.target.value;
      state.error = ''; render();
    }
    return;
  }
  const { appearance: field, index: indexValue } = event.target.dataset;
  const index = Number(indexValue);
  if (![0, 1].includes(index) || state.locked[index]) return;
  const previous = state.drafts[index].appearance;
  if (!Object.hasOwn(previous.facePreset ? APPEARANCE_LABELS : LEGACY_APPEARANCE_LABELS, field)) return;
  state.drafts[index].appearance = (previous.facePreset ? normalizePresetAppearance : normalizeAppearance)({ ...previous, [field]: event.target.value, ...(field === 'sex' ? { body: event.target.value } : {}) });
  state.error = '';
  render();
});
app.addEventListener('submit', event => {
  if (!event.target.matches('.name-form')) return;
  event.preventDefault();
  if (!renderBusy && nameValid(state.nameIndex)) app.querySelector('[data-action="name-next"]')?.click();
});
app.addEventListener('pointerover', event => {
  const button = event.target.closest('[data-action="fight"]');
  if (button) updateCommandPreview(button.dataset.value);
});
app.addEventListener('focusin', event => {
  const button = event.target.closest('[data-action="fight"]');
  if (button) updateCommandPreview(button.dataset.value);
});
app.addEventListener('click', async event => {
  if (renderBusy || onlineBusy) return;
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  const { action, value, stat, delta } = button.dataset;
  if (state.phase === 'playback' && !['online-leave', 'tournament-leave'].includes(action)) return;
  if (state.phase === 'execution' && !['online-leave', 'tournament-leave', 'mode', 'new-session'].includes(action)) return;
  if ((state.phase === 'outcome' || verdictReveal) && !['online-leave', 'tournament-leave', 'mode', 'new-session'].includes(action)) return;
  const index = Number(button.dataset.index);
  state.error = '';
  try {
    if (action === 'name-next' && state.screen === 'creator' && state.creatorStep === 'name') {
      event.preventDefault?.();
      if (index !== state.nameIndex || !nameValid(index)) return;
      state.drafts[index].name = state.drafts[index].name.trim();
      if (state.mode === 'hotseat' && index === 0 && !state.locked[1] && !nameValid(1)) state.nameIndex = 1;
      else { state.creatorStep = 'customize'; state.creatorIndex = index; }
      await render(); window.scrollTo({ top: 0, behavior: 'instant' });
    }
    else if (action === 'name-back' && state.screen === 'creator') {
      if (state.nameIndex === 1 && state.mode === 'hotseat' && !state.locked[0]) state.nameIndex = 0;
      else if (nameValid(state.nameIndex)) state.creatorStep = 'customize';
      await render();
    }
    else if (action === 'rename' && state.screen === 'creator' && [0, 1].includes(index) && !state.locked[index]) {
      state.creatorStep = 'name'; state.nameIndex = index; await render();
    }
    else if (action === 'creator-player' && state.screen === 'creator' && !onlineMode() && [0, 1].includes(index)) {
      state.creatorIndex = index; await render();
    }
    else if (action === 'mode') {
      onlineEpoch += 1; onlineView = null; onlineReplacement = false;
      const epoch = onlineEpoch;
      state.mode = value; newSession();
      if (onlineMode()) {
        const session = await onlineClient.session({ create: false });
        if (epoch !== onlineEpoch || !onlineMode()) return;
        useOnlineSession(session);
        if (session?.activeTournament || session?.activeRoom) {
          onlineClient.legacyRoom = !session.activeTournament && Boolean(session.activeRoom);
          const view = await onlineClient.room(session.activeTournament || session.activeRoom);
          if (epoch !== onlineEpoch || !onlineMode()) return;
          applyOnlineView(view, { animate: false });
        }
        resumeDeathSession();
        if (!onlineView) await render();
      }
    }
    else if (action === 'online-create' || action === 'online-join') {
      if (onlineSessionNeedsRefresh) return;
      if (!creatorValid()) throw new Error('Allocate all points and give your gladiator a name.');
      await performOnline(() => action === 'online-create' ? onlineClient.create(state.drafts[0]) : onlineClient.join(roomCodeDraft, state.drafts[0]));
    }
    else if (action === 'copy-room') {
      try { await navigator.clipboard.writeText(onlineView.code); state.error = 'Room code copied.'; }
      catch { state.error = `Room code: ${onlineView.code}`; }
      await render();
    }
    else if (action === 'online-leave' || action === 'tournament-leave' || action === 'tournament-next') {
      const enterNext = action === 'tournament-next' && tournamentView?.phase === 'complete' && tournamentView.players[tournamentView.you]?.alive;
      cancelRoundPlayback({ commit: true });
      stopExecutionPlayback();
      stopLoserOutcome(); stopVerdictReveal();
      stopSpectatorPlayback();
      await performOnline(() => onlineClient.command(onlineView, 'leave'));
      if (enterNext && !onlineView && !onlineSessionNeedsRefresh && onlineSession?.alive && creatorValid()) await performOnline(() => onlineClient.create(state.drafts[0]));
    }
    else if (action === 'gate-play' && state.screen === 'tournament-entrance') {
      const video = app.querySelector('.tournament-gate-video');
      if (video) { await video.play(); button.hidden = true; }
    }
    else if (action === 'online-replacement') {
      if (!creatorValid()) throw new Error('Allocate all points for your replacement.');
      onlineReplacement = false;
      await performOnline(() => onlineClient.command(onlineView, 'rematch', { character: state.drafts[0] }));
    }
    else if (action === 'face-cycle' && [0, 1].includes(index) && state.screen === 'creator' && !state.locked[index] && state.drafts[index].appearance.facePreset) {
      if (delta !== '-1' && delta !== '1') return;
      const appearance = normalizePresetAppearance(state.drafts[index].appearance);
      const presets = facePresetChoices(appearance.sex);
      const current = presets.findIndex(preset => preset.id === appearance.facePreset);
      const next = (current + Number(delta) + presets.length) % presets.length;
      state.drafts[index].appearance = normalizePresetAppearance({ ...appearance, facePreset: presets[next].id });
      render();
    }
    else if (action === 'stat' && !state.locked[index]) {
      const stats = state.drafts[index].stats;
      const next = stats[stat] + Number(delta);
      if (next >= 0 && next <= RULES.STAT_CAP && Object.values(stats).reduce((sum, item) => sum + item, 0) + Number(delta) <= RULES.POINT_BUDGET) stats[stat] = next;
      render();
    }
    else if (action === 'trait' && !state.locked[index]) { state.drafts[index].trait = value; render(); }
    else if (action === 'color' && !state.locked[index]) { state.drafts[index].color = value; render(); }
    else if (action === 'create') {
      if (!state.drafts.every(character => validateCharacter(character).valid)) throw new Error('Assign all character points and give each gladiator a name.');
      state.profiles = state.drafts.map((character, characterIndex) => state.locked[characterIndex] ? state.profiles[characterIndex] : ({ character: structuredClone({ ...character, name: character.name.trim() }), alive: true, duelWins: 0 }));
      state.locked = [true, true]; startLoadouts();
    }
    else if (action === 'weapon' && state.screen === 'loadout' && index === state.picker && (!onlineMode() || !onlineView.ready[index]) && Object.hasOwn(WEAPONS, value)) { state.loadouts[index].weapon = value; render(); }
    else if (action === 'armor' && state.screen === 'loadout' && index === state.picker && (!onlineMode() || !onlineView.ready[index]) && Object.hasOwn(ARMORS, value)) { state.loadouts[index].armor = value; render(); }
    else if (action === 'helmet' && state.screen === 'loadout' && index === state.picker && (!onlineMode() || !onlineView.ready[index]) && Object.hasOwn(HELMETS, value)) { state.loadouts[index].helmet = value; render(); }
    else if (action === 'lock-loadout' && state.screen === 'loadout' && (!onlineMode() || !onlineView.ready[state.picker])) {
      if (onlineMode()) {
        const view = onlineView;
        const gear = structuredClone(state.loadouts[view.you]);
        await performOnline(() => onlineClient.command(view, 'loadout', { loadout: gear }));
      }
      else if (state.mode === 'cpu' || state.picker === 1) startDuel();
      else { state.handoff = { kind: 'loadout', next: 1 }; state.screen = 'handoff'; render(); }
    }
    else if (action === 'continue-handoff') {
      if (state.handoff.kind === 'loadout') { state.picker = state.handoff.next; state.screen = 'loadout'; }
      else { state.actionTurn = state.handoff.next; state.screen = 'battle'; }
      render();
    }
    else if (action === 'fight') {
      if (state.screen !== 'battle' || state.phase !== 'select' || state.duel.status !== 'active') return;
      if (!onlineMode() && state.turnDeadline !== null && Date.now() >= state.turnDeadline) { expireLocalTurn(); return; }
      if (!getActionOptions(state.duel, state.actionTurn).some(option => option.id === value && option.enabled)) return;
      if (onlineMode()) {
        if (onlineView.pending[onlineView.you] || onlineOffline) return;
        const view = onlineView;
        const round = state.duel.round;
        await performOnline(() => onlineClient.command(view, 'action', { round, action: value }));
        return;
      }
      commitLocalAction(value);
    }
    else if (action === 'mercy' && state.screen === 'battle' && state.duel.status === 'complete' && state.decision === null) {
      if (!['spare', 'execute', 'crowd'].includes(value) || ![0, 1].includes(state.duel.result.winner) || state.localCrowd) return;
      if (onlineMode()) {
        if (onlineView.phase !== 'mercy' || onlineView.you !== state.duel.result.winner || Date.now() < (onlineView.mercyOpensAt || 0)) return;
        await performOnline(() => onlineClient.command(onlineView, 'mercy', { decision: value })); return;
      }
      if (state.mode === 'cpu' && state.duel.result.winner !== 0) return;
      if (value === 'crowd') { beginLocalCrowd(); await render(); }
      else resolveLocalVerdict(value);
    }
    else if (action === 'crowd-vote' && onlineMode() && ['spare', 'execute'].includes(value)) {
      const view = tournamentView || onlineView, crowd = publicMatch(view)?.crowdVote || view?.crowdVote;
      if (view?.type !== 'tournament' || view.phase !== 'crowd' || !crowd?.canVote || crowd.yourVote) return;
      await performOnline(() => onlineClient.vote(view, value));
    }
    else if (action === 'rematch') {
      if (onlineMode()) {
        const own = onlineView.players[onlineView.you];
        if (own.alive) await performOnline(() => onlineClient.command(onlineView, 'rematch'));
        else {
          state.drafts = defaults();
          state.drafts[0].name = `${own.character.name.slice(0, 20)} II`;
          state.creatorStep = 'name'; state.nameIndex = 0; state.creatorIndex = 0;
          state.locked = [false, false]; onlineReplacement = true; state.screen = 'creator'; await render();
          window.scrollTo({ top: 0, behavior: 'instant' });
        }
      }
      else if (state.profiles.every(profile => profile.alive)) startLoadouts();
      else {
        state.drafts = state.profiles.map(profile => structuredClone(profile.character));
        state.locked = state.profiles.map(profile => profile.alive);
        state.drafts.forEach((character, characterIndex) => {
          if (!state.locked[characterIndex]) {
            delete character.id;
            character.name = `${character.name.slice(0, 16)} II`;
          }
        });
        state.creatorIndex = state.locked.findIndex(locked => !locked);
        state.nameIndex = state.creatorIndex; state.creatorStep = 'name';
        state.screen = 'creator'; render(); window.scrollTo({ top: 0, behavior: 'instant' });
      }
    }
    else if (action === 'new-session') newSession();
    else if (action === 'reaction') {
      clearTimeout(reactionTimer); state.reaction = value; render();
      reactionTimer = setTimeout(() => { state.reaction = null; if (state.screen === 'battle') render(); }, 1300);
    }
  } catch (error) { state.error = error.message; render(); }
});
document.addEventListener('keydown', event => {
  if (renderBusy) return;
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) return;
  if (state.screen !== 'battle' || state.phase !== 'select' || state.duel?.status !== 'active') return;
  const key = Number(event.key);
  if (key >= 1 && key <= 4) app.querySelectorAll('[data-action="fight"]')[key - 1]?.click();
});
app.innerHTML = '<main class="app-shell"><section class="panel loading-screen" role="status"><h1>Opening the arena…</h1><p>Loading your character creator.</p></section></main>';
try {
  if (spectatorReview) {
    const { mountSpectatorPreview } = await import('./spectator-preview.js');
    await mountSpectatorPreview(app);
  } else {
    arrival = createArrivalController({ onComplete: () => { arrivalComplete = true; if (appReady) void render(); } });
    arrivalComplete = !arrival.shouldShow();
    if (!arrivalComplete) arrival.mount(app);
    await preloadCleanArt();
    try {
      if (onlineMode()) {
        const session = await onlineClient.session({ create: false });
        useOnlineSession(session);
        if (session?.activeTournament || session?.activeRoom) {
          onlineClient.legacyRoom = !session.activeTournament && Boolean(session.activeRoom);
          applyOnlineView(await onlineClient.room(session.activeTournament || session.activeRoom), { animate: false });
        }
      }
    } catch (error) { state.error = error.message; }
    appReady = true;
    resumeDeathSession();
    await render();
    setInterval(() => { void pollOnline(); }, 1000);
  }
} catch (error) {
  arrival?.dispose(); arrivalComplete = true;
  app.innerHTML = `<main class="app-shell"><section class="panel loading-screen" role="alert"><h1>${spectatorReview ? 'The spectator preview could not load.' : 'The character creator could not load.'}</h1><p>${esc(error.message)}</p><a class="button primary" href="${spectatorReview ? '/?spectator-frame-review=1' : '/'}">Try again</a></section></main>`;
}
