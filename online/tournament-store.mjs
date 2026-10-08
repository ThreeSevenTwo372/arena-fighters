import { randomBytes, randomInt, randomUUID, createHash } from 'node:crypto';
import * as combat from '../src/combat.js';
import { ApiError } from './service.mjs';
import { BOT_ACTION_DELAY_MS, LOBBY_BOT_INTERVAL_MS, createTournamentBot, chooseTournamentBotLoadout } from './tournament-bots.mjs';

const copy = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (status, message, code = 'invalid_request') => { throw new ApiError(status, message, code); };
const defaultGear = () => ({ weapon: 'sword', armor: 'medium', helmet: 'none' });
const stable = value => Array.isArray(value) ? value.map(stable) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const fingerprint = (kind, body) => createHash('sha256').update(JSON.stringify(stable({ kind, body }))).digest('hex');
function shape(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(400, 'Invalid tournament request fields.');
}
const PLAN = [
  ['Quarterfinal 1', 'quarterfinal', null], ['Quarterfinal 2', 'quarterfinal', null],
  ['Quarterfinal 3', 'quarterfinal', null], ['Quarterfinal 4', 'quarterfinal', null],
  ['Semifinal 1', 'semifinal', [0, 1]], ['Semifinal 2', 'semifinal', [2, 3]],
  ['Championship final', 'final', [4, 5]],
];

/** Tournament state shares the duel service's serialized, durable transaction. */
export class TournamentStore {
  constructor(service, { intermissionMs = 6000, entranceMs = 8000 } = {}) {
    if (!Number.isFinite(intermissionMs) || intermissionMs < 6000) throw new Error('Tournament intermissions must last at least six seconds.');
    if (!Number.isFinite(entranceMs) || entranceMs < 8000) throw new Error('Tournament entrances must last at least eight seconds.');
    this.service = service;
    this.intermissionMs = intermissionMs;
    this.entranceMs = entranceMs;
  }
  get data() { return this.service.data.tournaments; }
  touch(tournament) { this.service.touch(tournament); }
  member(session, code, allowLeft = false) {
    const tournament = this.data[code];
    if (!tournament) fail(404, 'Tournament lobby not found.', 'room_not_found');
    const index = tournament.playerIds.indexOf(session.playerId);
    if (index < 0 || tournament.players[index].bot === true || (!allowLeft && tournament.left[index])) fail(403, 'Join this tournament to watch or participate.', 'forbidden');
    return { tournament, index };
  }
  profileView(tournament, index) {
    const service = this.service;
    const profile = tournament.players[index];
    return { ...profile, tournamentWins: profile.tournamentWins ?? 0, seed: tournament.seeds[index] ?? null,
      eliminated: Boolean(tournament.eliminated[index]), left: Boolean(tournament.left[index]),
      connected: !tournament.left[index] && (profile.bot === true || service.clock() - (service.lastSeen.get(tournament.playerIds[index]) ?? 0) < service.rules.disconnectMs) };
  }
  pendingDeadline(session) {
    const match = this.data[session.pendingMercyTournament]?.match;
    return ['mercy', 'crowd'].includes(match?.phase) && match.playerIds.includes(session.playerId) ? match.deadline : null;
  }
  view(tournament, index) {
    const match = tournament.match;
    const localIndex = match ? match.slots.indexOf(index) : -1;
    const participating = localIndex >= 0 && !tournament.left[index];
    const crowdVote = match ? this.service.crowdVoteView(match, tournament.playerIds[index]) : null;
    if (crowdVote) crowdVote.canVote &&= !tournament.left[index] && tournament.players[index].alive && tournament.players[index].bot !== true;
    return copy({
      type: 'tournament', code: tournament.code, tournamentId: tournament.tournamentId,
      duelId: match?.duelId ?? tournament.tournamentId, phase: tournament.phase, revision: tournament.revision, you: index,
      capacity: 8, players: tournament.players.map((_, i) => this.profileView(tournament, i)),
      bracket: tournament.bracket, currentMatchIndex: tournament.currentMatchIndex,
      spectator: !participating, nextMatchAt: tournament.nextMatchAt, nextBotAt: tournament.nextBotAt ?? null, champion: tournament.champion,
      crowdVote,
      mercyOpensAt: match?.phase === 'mercy' ? match.mercyOpensAt : null,
      match: match ? {
        code: tournament.code, duelId: match.duelId, revision: tournament.revision, you: participating ? localIndex : null,
        slots: match.slots, phase: match.phase, players: match.slots.map(slot => this.profileView(tournament, slot)),
        ready: match.loadouts.map(Boolean), pending: match.actions.map(Boolean),
        yourLoadout: participating ? match.loadouts[localIndex] : null,
        // Only the resolved combat state is public. Pending choices and unrevealed gear never leave the service.
        duel: match.loadouts.every(Boolean) ? match.duel : null,
        decision: match.decision, crowdVote, mercyOpensAt: match.phase === 'mercy' ? match.mercyOpensAt : null, deadline: match.deadline, rules: { ...this.service.rules, entranceMs: this.entranceMs, intermissionMs: this.intermissionMs }, canRematch: false,
      } : null,
    });
  }
  saveRoster(tournament) {
    const match = tournament.match;
    if (!match) return;
    match.slots.forEach((slot, index) => {
      tournament.players[slot] = copy(match.players[index]);
      const session = this.service.sessionForPlayer(tournament.playerIds[slot]);
      if (session) session.profile = copy(tournament.players[slot]);
    });
  }
  start(tournament, now) {
    tournament.nextBotAt = null;
    const slots = tournament.players.map((_, index) => index);
    for (let i = slots.length - 1; i > 0; i -= 1) {
      const j = randomInt(i + 1); [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    tournament.seeds = Array(8).fill(null);
    slots.forEach((slot, index) => { tournament.seeds[slot] = index + 1; });
    tournament.bracket = PLAN.map(([label, round], index) => ({
      index, label, round, slots: index < 4 ? slots.slice(index * 2, index * 2 + 2) : [null, null],
      winner: null, loser: null, status: 'pending', advanceReason: null,
    }));
    // Filling the lobby starts a fresh grace window for everyone already waiting.
    for (const [index, id] of tournament.playerIds.entries()) {
      if (tournament.players[index].bot === true) continue;
      this.service.lastSeen.set(id, now);
      const session = this.service.sessionForPlayer(id); if (session) session.lastSeen = now;
    }
    this.startMatch(tournament, 0, now);
  }
  startMatch(tournament, index, now) {
    const bracket = tournament.bracket[index];
    const predecessors = PLAN[index][2];
    if (predecessors) bracket.slots = predecessors.map(previous => tournament.bracket[previous].winner);
    if (bracket.slots.some(slot => !Number.isInteger(slot))) throw new Error('The tournament bracket has unresolved predecessors.');
    bracket.status = 'active';
    tournament.currentMatchIndex = index;
    tournament.nextMatchAt = null;
    tournament.match = {
      code: tournament.code, duelId: randomUUID(), slots: [...bracket.slots],
      playerIds: bracket.slots.map(slot => tournament.playerIds[slot]),
      players: bracket.slots.map(slot => copy(tournament.players[slot])),
      left: bracket.slots.map(slot => tournament.left[slot]),
      phase: 'equipment', deadline: now + this.service.rules.equipmentMs,
      loadouts: [null, null], actions: [null, null], duel: null, decision: null,
      botRound: null, botActionAt: [null, null],
    };
    tournament.match.slots.forEach((slot, localIndex) => {
      if (tournament.players[slot].bot === true) tournament.match.loadouts[localIndex] = chooseTournamentBotLoadout(tournament.players[slot].character);
    });
    tournament.phase = 'equipment';
    this.touch(tournament);
    if (tournament.match.left.some(Boolean)) this.forfeitAbsent(tournament, now);
    else if (tournament.match.loadouts.every(Boolean)) {
      this.startEntrance(tournament, now);
      this.syncMatch(tournament, now);
    }
  }
  finishMatch(tournament, now) {
    const match = tournament.match;
    const bracket = tournament.bracket[tournament.currentMatchIndex];
    if (bracket.status === 'complete') return;
    let winner = match.duel.result.winner;
    if (winner === null) {
      // Randomized original seeds form a recorded deterministic tie break, including double withdrawals.
      winner = tournament.seeds[match.slots[0]] < tournament.seeds[match.slots[1]] ? 0 : 1;
      bracket.advanceReason = 'draw_seed';
      if (match.duel.result.reason !== 'abandoned') match.players[winner].duelWins += 1;
    } else bracket.advanceReason = match.duel.result.reason === 'forfeit' ? 'forfeit' : 'victory';
    this.saveRoster(tournament);
    bracket.winner = match.slots[winner]; bracket.loser = match.slots[1 - winner]; bracket.status = 'complete';
    tournament.eliminated[bracket.loser] = true;
    for (const [index, id] of match.playerIds.entries()) {
      const session = this.service.sessionForPlayer(id);
      if (session?.pendingMercyTournament === tournament.code
        && (tournament.eliminated[match.slots[index]] || tournament.currentMatchIndex === 6)) session.pendingMercyTournament = null;
    }
    if (tournament.currentMatchIndex === 6) {
      // Seed advancement can finish an abandoned bracket, but it cannot crown a withdrawn fighter.
      const eligible = !tournament.left[bracket.winner] && tournament.players[bracket.winner].alive
        && match.duel.result.reason !== 'abandoned';
      tournament.champion = eligible ? bracket.winner : null;
      if (eligible) {
        tournament.players[bracket.winner].tournamentWins = (tournament.players[bracket.winner].tournamentWins ?? 0) + 1;
        const session = this.service.sessionForPlayer(tournament.playerIds[bracket.winner]);
        if (session) session.profile = copy(tournament.players[bracket.winner]);
      }
      tournament.phase = 'complete'; tournament.nextMatchAt = null;
    } else {
      tournament.phase = 'intermission'; tournament.nextMatchAt = now + this.intermissionMs;
    }
    this.touch(tournament);
  }
  syncMatch(tournament, now) {
    if (tournament.match.phase === 'mercy' && now >= tournament.match.mercyOpensAt && tournament.match.players[tournament.match.duel.result.winner].bot === true) {
      this.service.decide(tournament.match, 'spare');
    }
    this.scheduleBotActions(tournament, now);
    this.saveRoster(tournament);
    tournament.phase = tournament.match.phase;
    if (tournament.match.phase === 'complete') this.finishMatch(tournament, now);
  }
  startEntrance(tournament, now) {
    this.service.startBattle(tournament.match, now);
    tournament.match.phase = 'entrance';
    tournament.match.deadline = now + this.entranceMs;
    tournament.match.botRound = null;
    tournament.match.botActionAt = [null, null];
  }
  scheduleBotActions(tournament, now) {
    const match = tournament.match;
    if (match.phase !== 'battle' || !match.players.some(player => player.bot === true) || match.botRound === match.duel.round) return;
    match.botRound = match.duel.round;
    match.botActionAt = match.players.map((player, index) => player.bot === true && !match.actions[index]
      ? now + Math.min(BOT_ACTION_DELAY_MS, this.service.rules.actionMs) : null);
  }
  commitBotActions(tournament, now) {
    const match = tournament.match;
    if (!match.players.some(player => player.bot === true)) return false;
    this.scheduleBotActions(tournament, now);
    let changed = false;
    for (let index = 0; index < 2; index += 1) {
      if (match.players[index].bot !== true || match.actions[index] || match.botActionAt[index] === null || now < match.botActionAt[index]) continue;
      // The CPU receives the resolved public duel only, never either pending choice.
      match.actions[index] = combat.chooseCpuAction(match.duel, index);
      match.botActionAt[index] = null;
      changed = true;
    }
    if (changed) this.touch(tournament);
    if (!match.actions.every(Boolean)) return false;
    this.service.resolveActions(match, now);
    this.syncMatch(tournament, now); this.touch(tournament);
    return true;
  }
  forfeitAbsent(tournament, now) {
    const match = tournament.match;
    const absent = match.playerIds.map((id, index) => match.left[index] || (match.players[index].bot !== true && now - (this.service.lastSeen.get(id) ?? 0) >= this.service.rules.disconnectMs));
    if (!absent.some(Boolean)) return false;
    this.service.forfeit(match, absent.every(Boolean) ? null : absent[0] ? 0 : 1, now);
    this.syncMatch(tournament, now); this.touch(tournament); return true;
  }
  expirePlayers(ids, now) {
    for (const tournament of Object.values(this.data)) {
      const affected = tournament.playerIds.some(id => ids.has(id));
      if (!affected) continue;
      if (tournament.phase === 'waiting') {
        // Waiting rosters have no bracket indices yet; remove expired seats so
        // subsequent guests and bots never inherit an absent fighter's place.
        for (let index = tournament.playerIds.length - 1; index >= 0; index -= 1) {
          if (!ids.has(tournament.playerIds[index])) continue;
          for (const key of ['playerIds', 'players', 'left', 'eliminated', 'seeds']) tournament[key].splice(index, 1);
        }
        if (!tournament.players.some(player => player.bot !== true)) {
          tournament.phase = 'complete'; tournament.nextBotAt = null;
        }
      } else {
        // Once seeded, retain immutable slot/profile snapshots for the surviving
        // contestants' bracket while withdrawing every expired entrant.
        tournament.playerIds.forEach((id, index) => { if (ids.has(id)) tournament.left[index] = true; });
        const match = tournament.match;
        if (match) {
          match.playerIds.forEach((id, index) => { if (ids.has(id)) match.left[index] = true; });
          if (match.phase === 'mercy' && ids.has(match.playerIds[match.duel.result.winner])) {
            this.service.decide(match, 'spare');
            if (!['intermission', 'complete'].includes(tournament.phase)) this.syncMatch(tournament, now);
          }
        }
      }
      for (const key of Object.keys(tournament.commands)) {
        if (ids.has(key.slice(0, key.indexOf(':')))) delete tournament.commands[key];
      }
      this.touch(tournament);
    }
  }
  advance(now) {
    for (const tournament of Object.values(this.data)) {
      if (tournament.phase === 'waiting') {
        if (!tournament.players.some((player, index) => player.bot !== true && !tournament.left[index])) {
          tournament.phase = 'complete'; tournament.nextBotAt = null; this.touch(tournament);
        } else if (!Number.isFinite(tournament.nextBotAt)) {
          // Restore older waiting lobbies with a fresh interval, without a catch-up burst.
          tournament.nextBotAt = now + LOBBY_BOT_INTERVAL_MS; this.touch(tournament);
        } else if (now >= tournament.nextBotAt) {
          if (tournament.players.length < 8) {
            const bot = createTournamentBot(tournament.players);
            tournament.playerIds.push(bot.playerId); tournament.players.push(bot.profile);
            tournament.left.push(false); tournament.eliminated.push(false); tournament.seeds.push(null);
          }
          tournament.nextBotAt = now + LOBBY_BOT_INTERVAL_MS;
          if (tournament.players.length === 8) this.start(tournament, now);
          this.touch(tournament);
        }
        continue;
      }
      if (tournament.phase === 'intermission') {
        if (now >= tournament.nextMatchAt) this.startMatch(tournament, tournament.currentMatchIndex + 1, now);
        continue;
      }
      const match = tournament.match;
      if (!match || !['equipment', 'entrance', 'battle', 'mercy', 'crowd'].includes(tournament.phase)) continue;
      if (match.phase === 'mercy' && now >= match.mercyOpensAt && match.players[match.duel.result.winner].bot === true) {
        this.service.decide(match, 'spare'); this.syncMatch(tournament, now); this.touch(tournament); continue;
      }
      if (match.phase === 'crowd') {
        if (this.service.advanceCrowd(match, now)) { this.syncMatch(tournament, now); this.touch(tournament); }
        continue;
      }
      if (['equipment', 'entrance', 'battle'].includes(tournament.phase) && this.forfeitAbsent(tournament, now)) continue;
      if (match.phase === 'battle' && this.commitBotActions(tournament, now)) continue;
      if (match.deadline === null || now < match.deadline) continue;
      if (match.phase === 'equipment') {
        match.loadouts = match.loadouts.map(value => value ?? defaultGear()); this.startEntrance(tournament, now);
      } else if (match.phase === 'entrance') {
        match.phase = 'battle'; match.deadline = now + this.service.rules.actionMs;
      } else if (match.phase === 'battle') {
        match.actions = match.actions.map(value => value ?? 'recover'); this.service.resolveActions(match, now);
      } else if (match.phase === 'mercy') this.service.decide(match, 'spare');
      this.syncMatch(tournament, now); this.touch(tournament);
    }
  }
  command(tournament, index, kind, body, execute) {
    if (typeof body.commandId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(body.commandId)) fail(400, 'Choose a valid commandId.');
    const key = `${tournament.playerIds[index]}:${body.commandId}`;
    const signature = fingerprint(kind, body);
    if (tournament.commands[key]) {
      if (tournament.commands[key] !== signature) fail(409, 'This commandId was already used for a different choice.', 'command_conflict');
      return;
    }
    if (body.duelId !== (tournament.match?.duelId ?? tournament.tournamentId)) fail(409, 'That choice belongs to an earlier tournament match.', 'stale_duel');
    if (Object.keys(tournament.commands).length >= 10000) fail(409, 'This tournament has reached its command limit.');
    execute(); tournament.commands[key] = signature; this.touch(tournament);
  }
  request({ method, path, session, body, now }) {
    if (!path.startsWith('/api/tournaments')) return null;
    if (method === 'POST' && ['/api/tournaments', '/api/tournaments/join', '/api/tournaments/enter'].includes(path)) {
      const joining = path.endsWith('/join'), auto = path.endsWith('/enter'); shape(body, joining ? ['code', 'character'] : ['character']);
      if (auto && session.activeTournament) {
        const current = this.member(session, session.activeTournament);
        // Repeated entry with the same identity resumes the durable lobby.
        this.service.profile(session, body.character);
        return this.view(current.tournament, current.index);
      }
      if (session.activeRoom || session.activeTournament) fail(409, 'Leave your current lobby before entering another.', 'active_room');
      if (session.pendingMercyRoom || session.pendingMercyTournament) fail(409, 'Wait for the mercy decision before entering another lobby.', 'pending_mercy');
      const profile = this.service.profile(session, body.character);
      let tournament;
      if (joining) {
        if (typeof body.code !== 'string' || !/^[A-Z2-9]{6}$/.test(body.code.toUpperCase())) fail(400, 'Lobby codes contain six letters or digits.');
        tournament = this.data[body.code.toUpperCase()];
        if (!tournament) fail(404, 'Tournament lobby not found.', 'room_not_found');
        if (tournament.phase !== 'waiting' || tournament.players.length >= 8) fail(409, 'This tournament lobby is full or already started.', 'room_full');
      } else if (auto && Object.values(this.data).some(lobby => lobby.phase === 'waiting' && lobby.players.length < 8)) {
        tournament = Object.values(this.data).filter(lobby => lobby.phase === 'waiting' && lobby.players.length < 8)
          .sort((a, b) => a.createdAt - b.createdAt || a.code.localeCompare(b.code))[0];
      } else {
        session.roomStarts = session.roomStarts.filter(time => now - time < 3600000);
        if (session.roomStarts.length >= 20) fail(429, 'Lobby creation is limited to twenty lobbies per hour.', 'rate_limited');
        if (Object.keys(this.data).length >= 2000) fail(503, 'The tournament lobby limit has been reached.');
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do { code = [...randomBytes(6)].map(value => alphabet[value % alphabet.length]).join(''); }
        while (this.data[code] || this.service.data.rooms[code]);
        tournament = { code, tournamentId: randomUUID(), phase: 'waiting', revision: 1, playerIds: [], players: [],
          left: [], eliminated: [], seeds: [], bracket: [], currentMatchIndex: null, match: null, nextMatchAt: null,
          champion: null, commands: {}, createdAt: now, nextBotAt: now + LOBBY_BOT_INTERVAL_MS };
        this.data[code] = tournament; session.roomStarts.push(now);
      }
      tournament.playerIds.push(session.playerId); tournament.players.push(profile);
      tournament.left.push(false); tournament.eliminated.push(false); tournament.seeds.push(null);
      tournament.nextBotAt = now + LOBBY_BOT_INTERVAL_MS;
      session.profile = copy(profile); session.activeTournament = tournament.code;
      if (tournament.players.length === 8) this.start(tournament, now);
      this.touch(tournament);
      return this.view(tournament, tournament.players.length - 1);
    }
    const match = /^\/api\/tournaments\/([A-Z2-9]{6})(?:\/(loadout|action|mercy|vote|leave))?$/.exec(path);
    if (!match) fail(404, 'Tournament endpoint not found.');
    // Waiting departures remove the seat; their exact retries still need a durable acknowledgement.
    if (method === 'POST' && match[2] === 'leave') {
      shape(body, ['commandId', 'duelId']);
      const previous = this.data[match[1]]?.commands[`${session.playerId}:${body.commandId}`];
      if (previous) {
        if (previous !== fingerprint('leave', body)) fail(409, 'This commandId was already used for a different choice.', 'command_conflict');
        return { left: true };
      }
    }
    const { tournament, index } = this.member(session, match[1], match[2] === 'leave');
    if (method === 'GET' && !match[2]) return this.view(tournament, index);
    if (method !== 'POST' || !match[2]) fail(405, 'Method not allowed.');
    const kind = match[2];
    shape(body, ['commandId', 'duelId', ...(kind === 'loadout' ? ['loadout'] : kind === 'action' ? ['round', 'action'] : ['mercy', 'vote'].includes(kind) ? ['decision'] : [])]);
    this.command(tournament, index, kind, body, () => {
      if (tournament.left[index]) fail(409, 'You have already left this tournament.');
      const current = tournament.match;
      const localIndex = current?.slots.indexOf(index) ?? -1;
      if (kind === 'leave') {
        if (tournament.phase === 'waiting') {
          tournament.playerIds.splice(index, 1); tournament.players.splice(index, 1); tournament.left.splice(index, 1);
          tournament.eliminated.splice(index, 1); tournament.seeds.splice(index, 1);
          if (!tournament.players.some(player => player.bot !== true)) {
            tournament.phase = 'complete'; tournament.nextBotAt = null;
          }
        } else {
          tournament.left[index] = true;
          if (localIndex >= 0) {
            current.left[localIndex] = true;
            if (['equipment', 'entrance', 'battle'].includes(tournament.phase)) this.service.forfeit(current, localIndex, now);
            if (current.phase === 'mercy') {
              if (current.duel.result.winner === localIndex) this.service.decide(current, 'spare');
              else session.pendingMercyTournament = tournament.code;
            }
            if (current.phase === 'crowd' && current.duel.result.winner !== localIndex) session.pendingMercyTournament = tournament.code;
            // A completed match shown during intermission must not reset its scheduled next start.
            if (tournament.phase !== 'intermission' && tournament.phase !== 'complete') this.syncMatch(tournament, now);
          }
          // A withdrawn entrant still awaiting their scheduled loss cannot reuse the
          // same identity elsewhere before the old opponent's mercy has resolved.
          if (!tournament.eliminated[index] && tournament.phase !== 'complete') session.pendingMercyTournament = tournament.code;
        }
        session.activeTournament = null;
        return;
      }
      if (kind === 'vote') {
        if (!['spare', 'execute'].includes(body.decision)) fail(400, 'Choose spare or execute.');
        if (tournament.phase !== 'crowd') fail(409, 'The crowd is not voting.', 'wrong_phase');
        if (localIndex >= 0 || !current.crowdVote.eligible.includes(session.playerId)
          || !tournament.players[index].alive || tournament.players[index].bot === true) fail(403, 'Only eligible spectators can vote.', 'spectator');
        if (current.crowdVote.votes[session.playerId]) fail(409, 'Your crowd vote is already locked.', 'choice_locked');
        current.crowdVote.votes[session.playerId] = body.decision;
        return;
      }
      if (localIndex < 0) fail(403, 'Only the two current duelists can commit a choice.', 'spectator');
      if (kind === 'loadout') {
        if (tournament.phase !== 'equipment') fail(409, 'Equipment selection has closed.', 'wrong_phase');
        if (current.loadouts[localIndex]) fail(409, 'Your equipment is already locked.', 'choice_locked');
        shape(body.loadout, ['weapon', 'armor', 'helmet']);
        if (![combat.WEAPONS, combat.ARMORS, combat.HELMETS].every((choices, i) => typeof body.loadout[['weapon', 'armor', 'helmet'][i]] === 'string' && Object.hasOwn(choices, body.loadout[['weapon', 'armor', 'helmet'][i]]))) fail(400, 'Choose valid equipment.');
        current.loadouts[localIndex] = copy(body.loadout);
        if (current.loadouts.every(Boolean)) this.startEntrance(tournament, now);
      } else if (kind === 'action') {
        if (tournament.phase !== 'battle') fail(409, 'The match is not accepting actions.', 'wrong_phase');
        if (!Number.isInteger(body.round) || body.round !== current.duel.round) fail(409, 'That choice belongs to an earlier round.', 'stale_round');
        if (current.actions[localIndex]) fail(409, 'Your choice is already locked.', 'choice_locked');
        const choice = combat.getActionOptions(current.duel, localIndex).find(option => option.id === body.action);
        if (!choice) fail(400, 'Choose a valid action.');
        if (!choice.enabled) fail(409, 'You cannot afford that action. Choose Recover.', 'unaffordable');
        current.actions[localIndex] = body.action;
        if (current.actions.every(Boolean)) this.service.resolveActions(current, now);
      } else if (kind === 'mercy') {
        if (!['spare', 'execute', 'crowd'].includes(body.decision)) fail(400, 'Choose spare, execute or the crowd.');
        if (tournament.phase !== 'mercy') fail(409, 'This match is not awaiting mercy.', 'wrong_phase');
        if (current.duel.result.winner !== localIndex) fail(403, 'Only the winner chooses mercy.', 'forbidden');
        if (now < current.mercyOpensAt) fail(409, 'The winner reveal is still playing.', 'verdict_not_open');
        if (body.decision === 'crowd') {
          const eligible = tournament.players.flatMap((player, slot) => current.slots.includes(slot) || tournament.left[slot] || !player.alive
            ? [] : [{ playerId: tournament.playerIds[slot], bot: player.bot === true }]);
          this.service.startCrowd(current, eligible, now);
        } else this.service.decide(current, body.decision);
      }
      this.syncMatch(tournament, now);
    });
    return kind === 'leave' ? { left: true } : this.view(tournament, index);
  }
}
