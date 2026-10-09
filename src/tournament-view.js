import { WEAPONS, ARMORS, getFighterStatus } from './combat.js';
import { renderCleanAvatar } from './current-avatar.js';
import { renderArena } from './arena.js';
import { renderSpectatorFrame } from './spectator-frame.js';
import { roundSummary } from './battle-presentation.js';
import { renderMercyPanel } from './mercy-presentation.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const currentProfile = view => view.players?.[view.you];
const fighterName = (view, index, fallback = 'Awaiting fighter') => view.players?.[index]?.character?.name ?? fallback;
const activePhases = new Set(['equipment', 'entrance', 'battle', 'mercy', 'crowd']);
const matchLabel = index => index < 4 ? `Quarterfinal ${index + 1}` : index < 6 ? `Semifinal ${index - 3}` : 'The final';
const activeMatch = view => view.bracket?.find(match => match.index === view.currentMatchIndex) ?? null;
const gatePoster = '/public/cinematics/arrival-v001/arena-gate.jpg';
const botBadge = profile => profile?.bot === true ? ` <span class="tournament-bot">Bot${({ aggressive: ' · Aggressive', cautious: ' · Cautious', patient: ' · Patient' })[profile.botStyle] || ''}</span>` : '';

function banner(character) {
  const color = /^#[0-9a-f]{6}$/i.test(character?.color ?? '') ? character.color : '#b45143';
  return `<svg class="tournament-banner" viewBox="0 0 18 25" aria-hidden="true"><path d="M2 1H16V18L9 24L2 18Z" fill="${color}" stroke="#d7bd87"/><path d="M9 4V18M5 9H13" stroke="#f0deb5" opacity=".65"/></svg>`;
}
function deadline(timestamp, label) {
  const value = number(timestamp);
  if (value <= 0) return '';
  const seconds = Math.max(0, Math.ceil((value - Date.now()) / 1000));
  return `<p class="tournament-clock" role="timer">${escape(label)} <strong><span data-deadline="${value}">${seconds}</span>s</strong></p>`;
}
function leaveLabel(view) {
  const own = currentProfile(view);
  if (view.phase === 'complete') return own?.alive === false ? 'Create a new fighter' : 'Enter another tournament';
  return own?.eliminated || own?.left ? 'Leave the stands' : 'Withdraw from tournament';
}
function roomBar(view, { invite = false } = {}) {
  if (view.role === 'spectator') return `<div class="tournament-room-bar"><div><span class="tournament-room-label">Watching tournament</span><strong class="tournament-room-code">${escape(view.code)}</strong></div><div class="tournament-room-actions"><button type="button" class="button ghost" data-action="observer-leave">Back to matches</button></div></div>`;
  return `<div class="tournament-room-bar"><div><span class="tournament-room-label">Tournament</span><strong class="tournament-room-code">${escape(view.code)}</strong>${invite ? '<span class="tournament-invite-note">Invite rivals with this code.</span>' : ''}</div><div class="tournament-room-actions">${invite ? '<button type="button" class="button ghost" data-action="copy-room">Copy code</button><button type="button" class="button ghost" data-action="copy-invite">Copy invite link</button>' : ''}<button type="button" class="button ghost" data-action="tournament-leave">${leaveLabel(view)}</button></div></div>`;
}
function seatState(view, profile, index) {
  if (!profile) return 'Awaiting fighter';
  if (profile.left) return 'Withdrawn';
  if (profile.alive === false) return 'Retired';
  if (view.champion === index) return 'Champion';
  if (profile.eliminated) return 'In the stands';
  if (profile.connected === false) return 'Reconnecting';
  if (view.match?.slots?.includes(index) && activePhases.has(view.phase)) return ['battle', 'mercy', 'crowd'].includes(view.phase) ? 'In the arena' : 'At the gate';
  return view.phase === 'waiting' ? 'Joined' : 'Awaiting their match';
}
function roster(view) {
  const count = (view.players ?? []).filter(profile => profile && !profile.left).length;
  return `<section class="tournament-roster"><header><div><span class="eyebrow">The contenders</span><h2>Eight fighters. One champion.</h2></div><strong class="tournament-seat-count" role="status">${count} / 8</strong></header><progress class="tournament-seat-progress" max="8" value="${count}" aria-label="Fighters joined"></progress><ol class="tournament-seats">${Array.from({ length: 8 }, (_, index) => {
    const profile = view.players?.[index];
    const status = seatState(view, profile, index);
    return `<li class="tournament-seat${profile ? ' occupied' : ''}${index === view.you ? ' own-seat' : ''}${profile?.eliminated ? ' eliminated-seat' : ''}" data-roster-index="${index}"><span class="tournament-seed">${profile?.seed ?? index + 1}</span>${profile ? banner(profile.character) : '<span class="tournament-empty-banner" aria-hidden="true">◇</span>'}<div><strong>${escape(profile?.character?.name ?? `Open seat ${index + 1}`)}${index === view.you ? ' <span class="tournament-you">You</span>' : ''}${botBadge(profile)}</strong><small>${escape(status)}</small></div><span class="tournament-seat-record">${profile ? `${number(profile.duelWins)} ${number(profile.duelWins) === 1 ? 'win' : 'wins'}` : '—'}</span></li>`;
  }).join('')}</ol></section>`;
}
function pendingName(matchIndex, slot) {
  if (matchIndex < 4) return 'Awaiting fighter';
  if (matchIndex < 6) return `Winner QF ${(matchIndex - 4) * 2 + slot + 1}`;
  return `Winner SF ${slot + 1}`;
}

/** The bracket is always the seven sequential matches, with one active pairing. */
export function renderTournamentBracket(view = {}) {
  const byIndex = new Map((view.bracket ?? []).map(match => [match.index, match]));
  const columns = [{ title: 'Quarterfinals', indices: [0, 1, 2, 3] }, { title: 'Semifinals', indices: [4, 5] }, { title: 'Final', indices: [6] }];
  return `<section class="tournament-bracket" aria-label="Tournament bracket"><header class="tournament-bracket-heading"><h2>The road to the crown</h2><p>Four quarterfinals · Two semifinals · One final</p></header><div class="tournament-bracket-rounds">${columns.map(column => `<div class="tournament-bracket-round"><h3>${column.title}</h3><div class="tournament-bracket-matches">${column.indices.map(index => {
    const match = byIndex.get(index) ?? { index, slots: [null, null], winner: null, status: 'pending' };
    const active = view.currentMatchIndex === index && activePhases.has(view.phase);
    const complete = match.status === 'complete';
    const state = active ? 'active' : complete ? 'complete' : 'pending';
    return `<article class="tournament-match ${state}" data-tournament-match="${index}"${active ? ' aria-current="step"' : ''}><div class="tournament-match-heading"><span>${matchLabel(index)}</span><strong>${active ? 'In progress' : complete ? 'Complete' : 'Upcoming'}</strong></div>${[0, 1].map(slot => {
      const playerIndex = match.slots?.[slot];
      const filled = Number.isInteger(playerIndex) && Boolean(view.players?.[playerIndex]);
      const won = complete && filled && match.winner === playerIndex;
      return `<div class="tournament-bracket-fighter${won ? ' advanced' : ''}${filled && playerIndex === view.you ? ' your-bracket-fighter' : ''}"><span>${escape(filled ? fighterName(view, playerIndex) : pendingName(index, slot))}</span>${won ? '<strong aria-label="Advanced">◆</strong>' : ''}</div>`;
    }).join('')}${complete && match.advanceReason === 'draw_seed' ? '<p class="tournament-advance-note">Draw · advancement by original seeding.</p>' : ''}</article>`;
  }).join('')}</div></div>`).join('')}</div></section>`;
}

function lobbySlots(view) {
  const joined = (view.players ?? []).filter(profile => profile && !profile.left).length;
  return `<section class="tournament-lobby-roster" aria-label="Eight fighter slots"><header class="tournament-lobby-roster-heading"><div><span class="eyebrow">The contenders</span><h2>Eight places. One champion.</h2></div><strong class="tournament-seat-count" role="status">${joined} / 8 fighters</strong></header><progress class="tournament-seat-progress" max="8" value="${joined}" aria-label="Fighters joined"></progress><ol class="tournament-fighter-slots">${Array.from({ length: 8 }, (_, index) => {
    const candidate = view.players?.[index];
    const profile = candidate && !candidate.left ? candidate : null;
    const own = Boolean(profile && index === view.you);
    const name = profile?.character?.name;
    const wins = number(profile?.duelWins);
    return `<li class="tournament-fighter-slot${profile ? ' occupied' : ' open-slot'}${own ? ' own-slot' : ''}" data-roster-index="${index}" data-fighter-slot="${index}" aria-label="${escape(profile ? `Slot ${index + 1}: ${name}${own ? ', you' : ''}${profile.bot === true ? ', bot' : ''}` : `Slot ${index + 1}: open`)}"><div class="tournament-slot-heading"><span>Slot ${index + 1}</span>${own ? '<strong class="tournament-slot-you">You</strong>' : profile ? banner(profile.character) : '<span class="tournament-slot-open">Open</span>'}</div><div class="tournament-slot-stage">${profile ? renderCleanAvatar(profile.character.appearance, 'battle', { weapon: 'sword', armor: 'medium', helmet: 'none' }, { alt: `${name} standing ready in fighter slot ${index + 1}` }) : '<span class="tournament-slot-empty" aria-hidden="true">◇</span>'}</div><div class="tournament-slot-identity"><h3>${escape(name ?? 'Awaiting fighter')}</h3><p>${profile ? `${escape(seatState(view, profile, index))}${botBadge(profile)}` : 'This place is open.'}</p><span class="tournament-slot-record">${profile ? `${wins} ${wins === 1 ? 'duel win' : 'duel wins'}${number(profile.tournamentWins) > 0 ? ` · ${number(profile.tournamentWins)} ${number(profile.tournamentWins) === 1 ? 'crown' : 'crowns'}` : ''}` : 'Waiting for a rival'}</span></div></li>`;
  }).join('')}</ol><p class="tournament-lobby-draw-note">${joined < 8 ? `${8 - joined} more ${8 - joined === 1 ? 'fighter' : 'fighters'} to join. ` : ''}All eight fighters are randomly paired for the first round. One duel takes place at a time; everyone else watches from the stands.</p></section>`;
}

/** All eight places display the joined fighters' assembled arena identities. */
export function renderTournamentLobby(view = {}) {
  const openSeats = (view.players ?? []).filter(profile => profile && !profile.left).length < 8;
  const botClock = view.phase === 'waiting' && openSeats ? deadline(view.nextBotAt, 'Next bot in') : '';
  if (view.role === 'spectator') return `<div class="tournament-view tournament-lobby">${roomBar(view)}<section class="tournament-heading"><span class="eyebrow">A seat in the stands</span><h1>The tournament is gathering.</h1><p>Watch the fighters arrive. The draw begins when all eight places are filled.</p>${botClock}</section>${lobbySlots(view)}${renderTournamentBracket(view)}</div>`;
  return `<div class="tournament-view tournament-lobby">${roomBar(view, { invite: true })}<section class="tournament-heading"><span class="eyebrow">Gather your rivals</span><h1>Your tournament begins with eight.</h1><p>Meet the fighters as they join. When every place is filled, the first-round pairings are drawn at random.</p>${botClock}</section>${lobbySlots(view)}${renderTournamentBracket(view)}</div>`;
}

/** Every entrant shares the preserved gate opening before taking their role. */
export function renderTournamentEntrance(view = {}) {
  const match = view.match;
  const slots = match?.slots ?? activeMatch(view)?.slots ?? [null, null];
  const names = slots.map((slot, index) => fighterName(view, slot, match?.players?.[index]?.character?.name ?? (index === 0 ? 'West fighter' : 'East fighter')));
  const spectator = !Number.isInteger(match?.you);
  return `<div class="tournament-view tournament-entrance">${roomBar(view)}<section class="tournament-gate" data-tournament-entrance aria-label="Entering the arena"><video class="tournament-gate-video" muted playsinline preload="auto" src="/public/cinematics/arrival-v001/arena-gate.mp4" poster="${gatePoster}"></video><div class="tournament-gate-caption"><span class="eyebrow">${escape(activeMatch(view)?.label ?? matchLabel(view.currentMatchIndex ?? 0))}</span><h1>The gates are opening.</h1><p>${escape(names[0])}<span class="tournament-versus">vs</span>${escape(names[1])}</p>${deadline(match?.deadline, spectator ? 'Spectating begins in' : 'Battle begins in')}<p class="tournament-gate-role">${spectator ? 'Take your seat in the stands.' : 'Your opponent awaits in the arena.'}</p><button type="button" class="button ghost" data-action="gate-play" hidden>Play gate animation</button></div></section></div>`;
}

function fighterStatus(fighter, index, view, playing, duel) {
  const condition = !playing && fighter.entangle ? getFighterStatus(duel, index) : null;
  const personality = ({ aggressive: 'Aggressive', cautious: 'Cautious', patient: 'Patient' })[view.match?.players?.[index]?.botStyle];
  const hp = Math.max(0, number(fighter.hp)), maxHp = Math.max(1, number(fighter.maxHp, 1));
  const stamina = Math.max(0, number(fighter.stamina)), maxStamina = Math.max(1, number(fighter.maxStamina, 1));
  const name = fighter.character?.name ?? `Fighter ${index + 1}`;
  const completed = view.match?.duel?.status === 'complete';
  const winner = view.match?.duel?.result?.winner;
  const readiness = playing ? 'Moves revealed' : completed ? winner === null ? 'Draw' : winner === index ? 'Winner' : 'Defeated' : view.match?.pending?.[index] ? 'Choice locked' : 'Choosing a move';
  const conditionMarkup = `${personality ? `<p>${escape(personality)} opponent</p>` : ''}${condition ? `<p class="fighter-condition">Entangled · Attacks +${condition.attackSurcharge} SP · Guard or Recover clears it</p>` : ''}`;
  return `<section class="spectator-status" aria-label="${escape(name)} status"><div class="spectator-status-heading"><h2>${escape(name)}</h2><span>${index === 0 ? 'West gate' : 'East gate'}</span></div><p>${escape(WEAPONS[fighter.weapon]?.name ?? 'Weapon')} · ${escape(ARMORS[fighter.armor]?.name ?? 'Armor')}</p>${conditionMarkup}<div class="meter-label"><span>Health</span><strong>${hp} / ${maxHp}</strong></div><progress class="meter health" max="${maxHp}" value="${Math.min(hp, maxHp)}" aria-label="${escape(name)} health"></progress><div class="meter-label"><span>Stamina</span><strong>${stamina} / ${maxStamina}</strong></div><progress class="meter stamina" max="${maxStamina}" value="${Math.min(stamina, maxStamina)}" aria-label="${escape(name)} stamina"></progress><div class="tournament-fighter-state">${readiness}</div></section>`;
}
function spectatorNotice(view) {
  if (view.role === 'spectator') return '<p class="tournament-personal-note">Watching from the stands. The fighters choose their moves in secret.</p>';
  const own = currentProfile(view);
  if (own?.alive === false) return '<p class="tournament-personal-note">Your fighter has been retired. Watch the tournament through to its champion, then create a new fighter.</p>';
  if (own?.eliminated) return '<p class="tournament-personal-note">Your tournament run has ended. Your surviving fighter keeps their identity and record. Enjoy the remaining matches from the stands.</p>';
  return '<p class="tournament-personal-note">Your seat in the stands is ready. You will return to the gate when your next match is called.</p>';
}
function waitingMatch(view) {
  const slots = view.match?.slots ?? activeMatch(view)?.slots ?? [null, null];
  const names = slots.map((slot, index) => fighterName(view, slot, index === 0 ? 'West fighter' : 'East fighter'));
  const entrance = view.phase === 'entrance';
  return `<section class="tournament-gate-scene tournament-pair-wait" data-tournament-gate aria-label="Fighters preparing at the arena gate"><img class="tournament-gate-backdrop" src="${gatePoster}" alt="The closed arena gate, lit by torches" draggable="false"><div class="tournament-gate-vignette" aria-hidden="true"></div><div class="tournament-gate-heading"><span class="eyebrow">${entrance ? 'The fighters approach' : 'The next pair prepares'}</span><h2>${entrance ? 'The gate is opening.' : 'Preparing for battle.'}</h2><p>${escape(names[0])}<span class="tournament-versus">vs</span>${escape(names[1])}</p></div><div class="tournament-ready-pair">${names.map((name, index) => `<div><strong>${escape(name)}</strong><span>${entrance || view.match?.ready?.[index] ? 'Ready' : 'Choosing equipment'}</span></div>`).join('')}</div><div class="tournament-gate-footer">${deadline(view.match?.deadline, entrance ? 'Entering the arena in' : 'Preparation ends in')}</div></section>`;
}
function matchResult(view) {
  const duel = view.match?.duel;
  const bracketMatch = activeMatch(view);
  const winnerIndex = bracketMatch?.winner;
  const localWinner = duel?.result?.winner;
  const winner = Number.isInteger(winnerIndex) ? fighterName(view, winnerIndex) : Number.isInteger(localWinner) ? duel.fighters?.[localWinner]?.character?.name : null;
  const title = winner ? `${winner} advances.` : 'The match has ended.';
  return `<section class="tournament-match-result" role="status"><span class="eyebrow">${escape(matchLabel(view.currentMatchIndex ?? 0))} complete</span><h2>${escape(title)}</h2><p>${view.phase === 'mercy' ? 'The winner decides the defeated fighter’s fate before the tournament continues.' : 'The arena rests before the next pairing.'}</p>${deadline(view.phase === 'intermission' ? view.nextMatchAt : view.match?.deadline, view.phase === 'intermission' ? 'Next match in' : 'Verdict in')}</section>`;
}

/** Spectators only receive public match state and never an action/loadout picker. */
export function renderTournamentSpectator(view = {}, { playing = false, duel = null,
  verdictPhase = null, verdictBusy = false, executing = false } = {}) {
  if (view.phase === 'complete' && !executing) return renderTournamentOutcome(view);
  if (view.phase === 'entrance' && !executing) return renderTournamentEntrance(view);
  const liveDuel = duel ?? view.match?.duel;
  const visibleBattle = Boolean(liveDuel?.fighters?.length === 2) && (executing || !['equipment', 'entrance', 'waiting'].includes(view.phase));
  const label = matchLabel(view.currentMatchIndex ?? 0);
  const pair = view.match?.slots?.map(slot => fighterName(view, slot)).join(' vs ') ?? '';
  let stage;
  if (visibleBattle) {
    const hud = liveDuel.fighters.map((fighter, index) => fighterStatus(fighter, index, view, playing, liveDuel)).join('');
    stage = renderSpectatorFrame(`<div class="arena-stage">${renderArena(liveDuel, { perspective: 'stands' })}</div>`, { hud });
  } else stage = waitingMatch(view);
  const mercy = !executing && ['mercy', 'crowd'].includes(view.phase) && Number.isInteger(liveDuel?.result?.winner)
    ? renderMercyPanel({ phase: verdictPhase ?? view.phase, winnerName: liveDuel.fighters[liveDuel.result.winner]?.character?.name,
      deadline: view.match?.deadline, crowdVote: view.match?.crowdVote ?? view.crowdVote, disabled: verdictBusy }) : '';
  const narrative = playing ? 'Both choices are revealed. Watch the round unfold.' : liveDuel?.lastRound ? roundSummary(liveDuel) : 'Both fighters choose their moves in secret. Their choices reveal together.';
  return `<div class="tournament-view tournament-spectator">${roomBar(view)}<section class="tournament-heading"><span class="eyebrow">A seat in the stands · ${escape(label)}</span><h1>${escape(pair || 'The arena awaits.')}</h1><p>${view.phase === 'equipment' ? 'The fighters are choosing their equipment at the gate.' : view.phase === 'entrance' ? 'The next fighters enter the arena.' : view.phase === 'intermission' ? 'One match at a time. The next pair enters shortly.' : 'Watch the active match from the stands.'}</p></section><div class="tournament-live-layout"><div class="tournament-watch">${stage}${visibleBattle && view.phase === 'battle' && !executing ? `<section class="tournament-commentary" aria-label="Match commentary"><span class="eyebrow">${playing ? 'Round reveal' : `Round ${number(liveDuel.round, 1)}`}</span><p role="status">${escape(narrative)}</p>${playing ? '' : Number(view.match?.actionOpensAt) > Date.now() ? `<p class="tournament-clock tournament-choice-opening" role="timer">Choices open in <strong><span data-deadline="${view.match.actionOpensAt}">${Math.ceil((view.match.actionOpensAt - Date.now()) / 1000)}</span>s</strong> · then 20s to choose</p>` : deadline(view.match?.deadline, 'Choices reveal in')}</section>` : ''}${mercy}${view.phase === 'intermission' && !executing ? matchResult(view) : ''}${spectatorNotice(view)}</div><aside class="tournament-side">${roster(view)}</aside></div>${renderTournamentBracket(view)}</div>`;
}

/** Leaving a finished bracket preserves survivors or opens replacement creation. */
export function renderTournamentOutcome(view = {}) {
  const champion = Number.isInteger(view.champion) ? fighterName(view, view.champion) : null;
  if (view.role === 'spectator') return `<div class="tournament-view tournament-complete">${roomBar(view)}<section class="tournament-champion"><span class="eyebrow">Tournament ${escape(view.code)} · Complete</span><h1>${champion ? `${escape(champion)} takes the crown.` : 'The tournament has ended.'}</h1><p>Eight entered. The final record joins the leaderboard.</p><button type="button" class="button primary" data-action="observer-leave">Watch another tournament <span aria-hidden="true">→</span></button></section>${renderTournamentBracket(view)}${roster(view)}</div>`;
  const own = currentProfile(view);
  const won = view.champion === view.you && Number.isInteger(view.champion);
  const note = view.role === 'spectator' ? 'The final record joins the leaderboard. Another tournament awaits.' : own?.alive === false ? 'Your fighter has been retired. Create a new fighter for your next tournament.' : won ? 'Your champion survives with their identity and record. The next tournament awaits.' : 'Your surviving fighter keeps their identity and record for the next tournament.';
  return `<div class="tournament-view tournament-complete"><section class="tournament-champion"><svg class="tournament-crown" viewBox="0 0 72 60" aria-hidden="true"><path d="M9 15L23 25L36 7L49 25L63 15L57 48H15Z" fill="#c7a163" stroke="#f1d79b" stroke-width="2"/><path d="M16 52H56" stroke="#f1d79b" stroke-width="4"/><path d="M23 39H49" stroke="#795736" stroke-width="3"/><circle cx="36" cy="31" r="3" fill="#ead6a3"/></svg><span class="eyebrow">Tournament ${escape(view.code)} · Complete</span><h1>${champion ? `${escape(champion)} takes the crown.` : 'The tournament has ended.'}</h1><p>${won ? 'You are the arena’s champion.' : champion ? 'Eight entered. One champion remains.' : 'The arena will welcome a new field of fighters.'}</p><p class="tournament-survival-note">${note}</p><button type="button" class="button primary" data-action="${own?.alive === false ? 'tournament-leave' : 'tournament-next'}">${leaveLabel(view)} <span aria-hidden="true">→</span></button>${own?.alive !== false ? '<button type="button" class="button ghost" data-action="tournament-leave">Leave lobby</button>' : ''}</section>${renderTournamentBracket(view)}${roster(view)}</div>`;
}
