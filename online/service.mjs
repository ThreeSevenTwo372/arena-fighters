import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as combat from '../src/combat.js';
import { normalizeAppearance } from '../src/avatar.js';
import { facePresetChoices } from '../src/face-presets.js';
import { AtomicStore, MemoryStore } from './store.mjs';
import { TournamentStore } from './tournament-store.mjs';
import { ArenaChat } from './arena-chat.mjs';

const copy = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => typeof key === 'string' && Object.hasOwn(value, key);
const digest = value => createHash('sha256').update(value).digest('hex');
const defaultGear = () => ({ weapon: 'sword', armor: 'medium', helmet: 'none' });
const ACTIVE = new Set(['equipment', 'battle', 'mercy', 'crowd']);

export class ApiError extends Error {
  constructor(status, message, code = 'invalid_request') { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new ApiError(status, message, code); };
function shape(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(400, 'Invalid request fields.');
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}

export function sanitizeCharacter(input) {
  shape(input, ['id', 'name', 'stats', 'trait', 'color', 'appearance'], ['name', 'stats', 'trait']);
  const keys = combat.STAT_KEYS ?? ['strength', 'dexterity', 'speed', 'defense', 'intelligence'];
  shape(input.stats, keys);
  if (input.id !== undefined && (typeof input.id !== 'string' || input.id.length > 80)) fail(400, 'Invalid character identity.');
  if (input.appearance !== undefined) {
    shape(input.appearance, ['schema', 'body', 'sex', 'hairstyle', 'skin', 'hairColor', 'eyes', 'eyeStyle', 'beard', 'facePreset'], []);
    if (Object.values(input.appearance).some(value => !['string', 'number'].includes(typeof value))) fail(400, 'Invalid character appearance.');
    if (input.appearance.facePreset !== undefined && !facePresetChoices().some(preset => preset.id === input.appearance.facePreset)) fail(400, 'Choose a valid face preset.');
  }
  const check = combat.validateCharacter(input);
  if (!check.valid) fail(400, check.errors.join(' '));
  return {
    ...(input.id ? { id: input.id } : {}), name: input.name.trim(),
    stats: Object.fromEntries(keys.map(key => [key, input.stats[key]])), trait: input.trait,
    color: input.color ?? '#b87333', appearance: {
      ...normalizeAppearance(input.appearance),
      ...(input.appearance?.facePreset ? { facePreset: input.appearance.facePreset } : {}),
    },
  };
}
function sameCharacter(a, b) {
  const withoutId = ({ id, ...rest }) => stable(rest);
  return JSON.stringify(withoutId(a)) === JSON.stringify(withoutId(b));
}
const publicIdentity = character => ({ id: character.id, name: character.name, color: character.color, appearance: copy(character.appearance) });

/** All requests and deadline advancement are serialized, including persistence. */
export class DuelService {
  constructor({ storePath, store, temporarySessions = false, clock = Date.now, equipmentMs = 120000, actionMs = combat.RULES.TURN_SECONDS * 1000, winnerMs = 5000, mercyMs = 20000, crowdMs = 20000, disconnectMs = 90000, heartbeatPersistMs = 15000, entranceMs = 8000, intermissionMs = 6000 } = {}) {
    this.temporarySessions = Boolean(temporarySessions);
    this.store = store ?? (this.temporarySessions ? new MemoryStore() : new AtomicStore(storePath));
    this.clock = clock;
    this.rules = { equipmentMs, actionMs, winnerMs, mercyMs, crowdMs, disconnectMs };
    for (const [key, value] of Object.entries(this.rules)) if (!Number.isFinite(value) || (key === 'winnerMs' ? value < 0 : value <= 0)) throw new Error('Duel deadlines must be positive milliseconds (the winner reveal may be zero).');
    this.heartbeatPersistMs = heartbeatPersistMs;
    this.lastSeen = new Map();
    this.queue = Promise.resolve();
    this.tournaments = new TournamentStore(this, { entranceMs, intermissionMs });
    this.arenaChat = new ArenaChat();
    this.initialized = this.store.read().then(async data => {
      this.data = data;
      data.tournaments ??= {};
      for (const session of Object.values(data.sessions)) this.lastSeen.set(session.playerId, session.lastSeen);
      // Restore old longer windows once without extending a shorter deadline.
      const windows = { battle: this.rules.actionMs, mercy: this.rules.mercyMs, crowd: this.rules.crowdMs };
      const now = this.clock();
      let shortened = false;
      const restoreWindow = room => {
        let changed = false;
        if (room.phase === 'mercy' && !Number.isFinite(room.mercyOpensAt)) { room.mercyOpensAt = now; changed = true; }
        const maximumDeadline = (room.phase === 'mercy' ? Math.max(now, room.mercyOpensAt) : now) + windows[room.phase];
        if (room.deadline > maximumDeadline) {
          room.deadline = maximumDeadline;
          if (room.phase === 'crowd' && room.crowdVote) room.crowdVote.deadline = maximumDeadline;
          changed = true;
        }
        return changed;
      };
      for (const room of Object.values(data.rooms)) {
        if (restoreWindow(room)) {
          room.revision += 1;
          shortened = true;
        }
      }
      for (const tournament of Object.values(data.tournaments)) {
        if (tournament.match && restoreWindow(tournament.match)) {
          tournament.revision += 1;
          shortened = true;
        }
      }
      if (shortened) await this.store.write(data);
    });
  }
  async serialize(operation) {
    const task = this.queue.then(async () => {
      await this.initialized;
      const before = copy(this.data);
      this.changed = false;
      this.arenaChat.beginTransaction();
      try {
        const value = await operation();
        if (this.changed) await this.store.write(this.data);
        this.arenaChat.commitTransaction();
        return value;
      } catch (error) { this.data = before; this.arenaChat.rollbackTransaction(); throw error; }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async close() { await this.initialized; await this.queue; }
  touch(room) { room.revision += 1; this.changed = true; }
  session(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'A valid guest session is required.', 'unauthorized');
    const session = this.data.sessions[digest(token)];
    if (!session) fail(401, 'Your guest session could not be found.', 'unauthorized');
    return session;
  }
  heartbeat(session, now) {
    this.lastSeen.set(session.playerId, now);
    if (now - session.lastSeen >= this.heartbeatPersistMs) { session.lastSeen = now; this.changed = true; }
  }
  member(session, code, allowLeft = false) {
    const room = this.data.rooms[code];
    if (!room) fail(404, 'Room not found.', 'room_not_found');
    const index = room.playerIds.indexOf(session.playerId);
    if (index < 0 || (!allowLeft && room.left[index])) fail(403, 'This room belongs to its two players.', 'forbidden');
    return { room, index };
  }
  profile(session, input) {
    const character = sanitizeCharacter(input);
    if (session.profile?.alive) {
      if (!sameCharacter(session.profile.character, character) || (character.id && character.id !== session.profile.character.id)) fail(409, 'A surviving gladiator keeps their identity and attributes.', 'identity_locked');
      return copy(session.profile);
    }
    if (session.profile && character.id === session.profile.character.id) fail(409, 'An executed gladiator cannot return. Create a replacement.', 'character_dead');
    return { character: { ...character, id: randomUUID() }, alive: true, duelWins: 0, tournamentWins: 0 };
  }
  roomView(room, index) {
    const now = this.clock();
    return copy({
      code: room.code, phase: room.phase, revision: room.revision, you: index, duelId: room.duelId,
      players: room.players.map((player, i) => ({ ...player, left: Boolean(room.left[i]), connected: !room.left[i] && now - (this.lastSeen.get(room.playerIds[i]) ?? 0) < this.rules.disconnectMs })),
      ready: room.loadouts.map(Boolean), pending: room.actions.map(Boolean), yourLoadout: room.loadouts[index],
      duel: room.loadouts.every(Boolean) ? room.duel : null, decision: room.decision,
      crowdVote: this.crowdVoteView(room, room.playerIds[index]),
      mercyOpensAt: room.phase === 'mercy' ? room.mercyOpensAt : null,
      rematchReady: room.rematchReady, deadline: room.deadline, rules: this.rules,
      canRematch: !room.left.some(Boolean),
    });
  }
  sessionForPlayer(playerId) { return Object.values(this.data.sessions).find(session => session.playerId === playerId); }
  arenaTournamentList() {
    return {
      tournaments: Object.values(this.data.tournaments).filter(tournament => tournament.phase !== 'complete')
        .sort((a, b) => a.createdAt - b.createdAt || a.code.localeCompare(b.code)).map(tournament => ({
          code: tournament.code, phase: tournament.phase,
          playerCount: tournament.players.filter((player, index) => player.alive && !tournament.left[index]).length,
          currentMatchLabel: tournament.bracket.find(match => match.index === tournament.currentMatchIndex)?.label ?? null,
          fighters: (tournament.match?.players ?? tournament.players.filter((_, index) => !tournament.left[index]))
            .map(player => player.character.name),
        })),
      sessionMode: this.temporarySessions ? 'temporary' : 'persistent',
    };
  }
  arenaTournamentView(code) {
    const tournament = this.data.tournaments[code];
    if (!tournament) fail(404, 'Tournament lobby not found.', 'room_not_found');
    // An observer never acquires a roster seat or inherits its voting/control rights.
    const view = this.tournaments.view(tournament, -1);
    view.you = null; view.role = 'spectator'; view.spectator = true;
    if (view.crowdVote) { view.crowdVote.canVote = false; view.crowdVote.yourVote = null; }
    if (view.match) {
      view.match.you = null; view.match.yourLoadout = null; view.match.canRematch = false;
      if (view.match.crowdVote) { view.match.crowdVote.canVote = false; view.match.crowdVote.yourVote = null; }
    }
    return view;
  }
  arenaLeaderboard() {
    const profiles = new Map();
    for (const session of Object.values(this.data.sessions)) {
      const profile = session.profile;
      if (profile?.alive && profile.bot !== true && profile.character?.id) profiles.set(profile.character.id, profile);
    }
    return {
      fighters: [...profiles.values()].sort((a, b) => b.duelWins - a.duelWins
        || (b.tournamentWins ?? 0) - (a.tournamentWins ?? 0) || a.character.id.localeCompare(b.character.id))
        .map((profile, index) => ({ rank: index + 1, character: publicIdentity(profile.character),
          duelWins: profile.duelWins, tournamentWins: profile.tournamentWins ?? 0 })),
      sessionMode: this.temporarySessions ? 'temporary' : 'persistent',
    };
  }
  archiveExecution(room, loser, winner) {
    const session = this.sessionForPlayer(room.playerIds[loser]);
    if (!session) return;
    const profile = room.players[loser];
    session.graveyard ??= [];
    if (session.graveyard.some(grave => grave.character.id === profile.character.id)) return;
    session.graveyard.push({ character: copy(profile.character), duelWins: profile.duelWins,
      tournamentWins: profile.tournamentWins ?? 0, diedAt: this.clock(),
      killedBy: room.players[winner].character.name, code: room.code });
    this.changed = true;
  }
  saveProfile(room, index) {
    const session = this.sessionForPlayer(room.playerIds[index]);
    if (session) session.profile = copy(room.players[index]);
  }
  startBattle(room, now) {
    room.duel = combat.createDuel(room.players.map((player, index) => ({ character: player.character, ...room.loadouts[index] })));
    room.phase = 'battle'; room.deadline = now + this.rules.actionMs;
  }
  settleBattle(room, now) {
    if (room.duel.status !== 'complete') { room.deadline = now + this.rules.actionMs; return; }
    const winner = room.duel.result.winner;
    if (winner === null) { room.phase = 'complete'; room.deadline = null; }
    else {
      room.players[winner].duelWins += 1; this.saveProfile(room, winner);
      room.phase = 'mercy'; room.mercyOpensAt = now + this.rules.winnerMs; room.deadline = room.mercyOpensAt + this.rules.mercyMs;
    }
  }
  resolveActions(room, now) {
    room.duel = combat.resolveRound(room.duel, room.actions);
    room.actions = [null, null]; this.settleBattle(room, now);
  }
  decide(room, decision) {
    const winner = room.duel.result.winner, loser = 1 - winner;
    room.decision = { decision, winner, loser };
    if (decision === 'execute') {
      room.players[loser].alive = false; this.archiveExecution(room, loser, winner); this.saveProfile(room, loser);
    }
    const session = this.sessionForPlayer(room.playerIds[loser]);
    if (session?.pendingMercyRoom === room.code) session.pendingMercyRoom = null;
    room.phase = 'complete'; room.deadline = null;
  }
  startCrowd(room, eligible, now) {
    room.phase = 'crowd'; room.deadline = now + this.rules.crowdMs;
    room.crowdVote = { deadline: room.deadline, eligible: eligible.map(player => player.playerId), votes: {}, botVotes: {} };
    for (const player of eligible) {
      if (!player.bot) continue;
      const signature = digest(`${room.duelId}:${player.playerId}`);
      const fraction = parseInt(signature.slice(0, 4), 16) / 65535;
      const delay = Math.min(this.rules.crowdMs - 1, Math.round(this.rules.crowdMs * (.15 + .6 * fraction)));
      room.crowdVote.botVotes[player.playerId] = {
        decision: parseInt(signature.slice(4, 6), 16) % 2 ? 'execute' : 'spare', at: now + Math.max(0, delay),
      };
    }
  }
  crowdVoteView(room, playerId) {
    const ballot = room.phase === 'crowd' ? room.crowdVote : null;
    if (!ballot) return null;
    const counts = { spare: 0, execute: 0 };
    for (const vote of Object.values(ballot.votes)) if (vote === 'spare' || vote === 'execute') counts[vote]++;
    const yourVote = ballot.votes[playerId] ?? null;
    return { deadline: room.deadline, eligibleCount: ballot.eligible.length, counts, yourVote,
      canVote: ballot.eligible.includes(playerId) && !ballot.botVotes[playerId] && !yourVote };
  }
  advanceCrowd(room, now) {
    if (room.phase !== 'crowd') return false;
    let changed = false;
    for (const [id, scheduled] of Object.entries(room.crowdVote.botVotes)) {
      if (room.crowdVote.votes[id] || now < scheduled.at || scheduled.at > room.deadline) continue;
      room.crowdVote.votes[id] = scheduled.decision; changed = true;
    }
    if (now >= room.deadline) {
      const counts = this.crowdVoteView(room, null).counts;
      this.decide(room, counts.execute > counts.spare ? 'execute' : 'spare'); changed = true;
    }
    return changed;
  }
  forfeit(room, loser, now) {
    if (room.phase === 'equipment') {
      room.loadouts = room.loadouts.map(value => value ?? defaultGear()); this.startBattle(room, now);
    }
    room.actions = [null, null];
    room.duel = combat.forfeitDuel(room.duel, loser);
    this.settleBattle(room, now);
  }
  expireTemporarySessions(now) {
    const expired = Object.entries(this.data.sessions).filter(([, session]) =>
      now - (this.lastSeen.get(session.playerId) ?? session.lastSeen) >= this.rules.disconnectMs);
    if (!expired.length) return;
    const ids = new Set(expired.map(([, session]) => session.playerId));
    // Mark every departure together before normal advancement, so simultaneous
    // expiry produces an abandoned duel rather than awarding the first survivor.
    for (const room of Object.values(this.data.rooms)) {
      let changed = false;
      room.playerIds.forEach((id, index) => {
        if (ids.has(id) && !room.left[index]) { room.left[index] = true; changed = true; }
      });
      if (!changed) continue;
      if (room.phase === 'waiting') { room.phase = 'complete'; room.deadline = null; }
      if (room.phase === 'mercy' && ids.has(room.playerIds[room.duel.result.winner])) this.decide(room, 'spare');
      this.touch(room);
    }
    this.tournaments.expirePlayers(ids, now);
    for (const [key, session] of expired) {
      delete this.data.sessions[key];
      this.lastSeen.delete(session.playerId);
    }
    this.changed = true;
  }
  collectTemporaryGames(now) {
    const sessions = Object.values(this.data.sessions);
    const liveIds = new Set(sessions.map(session => session.playerId));
    const required = new Set(sessions.flatMap(session => [session.activeRoom, session.activeTournament,
      session.pendingMercyRoom, session.pendingMercyTournament]).filter(Boolean));
    for (const games of [this.data.rooms, this.data.tournaments]) {
      for (const [code, game] of Object.entries(games)) {
        if (required.has(code)) { if (game.unreferencedAt !== undefined) { delete game.unreferencedAt; this.changed = true; } continue; }
        // Keep a brief receipt window for exact leave retries while their guests
        // remain online. Completely abandoned games can be discarded immediately.
        const liveMember = game.playerIds.some(id => liveIds.has(id));
        if (liveMember && game.unreferencedAt === undefined) { game.unreferencedAt = now; this.changed = true; }
        if (!liveMember || now - game.unreferencedAt >= this.rules.disconnectMs) {
          delete games[code]; this.changed = true;
        }
      }
    }
  }
  advance(now, expireGuests = true) {
    if (this.temporarySessions && expireGuests) this.expireTemporarySessions(now);
    for (const room of Object.values(this.data.rooms)) {
      if (room.phase === 'crowd') { if (this.advanceCrowd(room, now)) this.touch(room); continue; }
      if (room.phase === 'battle' || room.phase === 'equipment') {
        const absent = room.playerIds.map((id, index) => room.left[index] || now - (this.lastSeen.get(id) ?? 0) >= this.rules.disconnectMs);
        if (absent.some(Boolean)) { this.forfeit(room, absent.every(Boolean) ? null : absent[0] ? 0 : 1, now); this.touch(room); }
      }
      // A timeout advances at most one round, giving both players a fresh response window.
      if (!ACTIVE.has(room.phase) || room.deadline === null || now < room.deadline) continue;
      if (room.phase === 'equipment') {
        room.loadouts = room.loadouts.map(value => value ?? defaultGear()); this.startBattle(room, now);
      } else if (room.phase === 'battle') {
        room.actions = room.actions.map(value => value ?? 'recover'); this.resolveActions(room, now);
      } else if (room.phase === 'mercy') this.decide(room, 'spare');
      this.touch(room);
    }
    this.tournaments.advance(now);
    if (this.temporarySessions) this.collectTemporaryGames(now);
    this.arenaChat.cleanup(this.data.tournaments, now);
  }
  async tick() { return this.serialize(() => this.advance(this.clock())); }
  command(room, index, kind, body, execute) {
    if (typeof body.commandId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(body.commandId)) fail(400, 'Choose a valid commandId.');
    const key = `${index}:${body.commandId}`;
    const fingerprint = digest(JSON.stringify(stable({ kind, body })));
    const previous = room.commands[key];
    if (previous) {
      if (previous !== fingerprint) fail(409, 'This commandId was already used for a different choice.', 'command_conflict');
      return false;
    }
    if (body.duelId !== room.duelId) fail(409, 'That choice belongs to an earlier duel.', 'stale_duel');
    if (Object.keys(room.commands).length >= 10000) fail(409, 'This room has reached its match limit. Leave and create another room.');
    execute(); room.commands[key] = fingerprint; this.touch(room); return true;
  }
  async request({ method, path, token, body = {} }) {
    // Expiration is its own committed transaction. A rejected stale token or
    // invalid command must not roll cleanup back and resurrect an expired guest.
    if (this.temporarySessions) await this.tick();
    return this.serialize(() => {
      const now = this.clock(); this.advance(now, false);
      if (method === 'POST' && path === '/api/session') {
        shape(body, [], []);
        if (Object.keys(this.data.sessions).length >= 10000) fail(503, 'The guest session limit has been reached.');
        const secret = randomBytes(32).toString('base64url');
        const session = { playerId: randomUUID(), profile: null, activeRoom: null, lastSeen: now, roomStarts: [] };
        this.data.sessions[digest(secret)] = session; this.heartbeat(session, now); this.changed = true;
        return { token: secret, playerId: session.playerId };
      }
      if (path.startsWith('/api/arena/')) {
        // Public browsing does not create a fighter; an existing guest keeps its grace window.
        const viewer = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
          ? this.data.sessions[digest(token)] : null;
        if (viewer) this.heartbeat(viewer, now);
        const chat = /^\/api\/arena\/tournaments\/([A-Z2-9]{6})\/chat$/.exec(path);
        if (chat) {
          if (!['GET', 'POST'].includes(method)) fail(405, 'Method not allowed.');
          const session = method === 'POST' ? this.session(token) : viewer;
          const tournament = this.data.tournaments[chat[1]];
          if (!tournament) fail(404, 'Tournament lobby not found.', 'room_not_found');
          return method === 'POST' ? this.arenaChat.post(tournament, session, body, now) : this.arenaChat.view(tournament, session);
        }
        if (method !== 'GET') fail(405, 'Method not allowed.');
        if (path === '/api/arena/tournaments') return this.arenaTournamentList();
        if (path === '/api/arena/leaderboard') return this.arenaLeaderboard();
        const observer = /^\/api\/arena\/tournaments\/([A-Z2-9]{6})$/.exec(path);
        if (observer) return this.arenaTournamentView(observer[1]);
        fail(404, 'Arena endpoint not found.');
      }
      const session = this.session(token); this.heartbeat(session, now);
      if (path === '/api/graveyard') {
        if (method !== 'GET') fail(405, 'Method not allowed.');
        return { graves: copy(session.graveyard ?? []), sessionMode: this.temporarySessions ? 'temporary' : 'persistent' };
      }
      if (method === 'GET' && path === '/api/session') return {
        playerId: session.playerId, character: session.profile?.character ?? null,
        alive: session.profile?.alive ?? true, duelWins: session.profile?.duelWins ?? 0, activeRoom: session.activeRoom,
        tournamentWins: session.profile?.tournamentWins ?? 0, activeTournament: session.activeTournament ?? null,
        pendingMercyRoom: session.pendingMercyRoom ?? null,
        pendingMercyDeadline: session.pendingMercyRoom ? this.data.rooms[session.pendingMercyRoom]?.deadline ?? null : null,
        pendingMercyTournament: session.pendingMercyTournament ?? null,
        pendingMercyTournamentDeadline: session.pendingMercyTournament ? this.tournaments.pendingDeadline(session) : null,
      };
      if (path.startsWith('/api/tournaments')) return this.tournaments.request({ method, path, session, body, now });
      if (method === 'POST' && (path === '/api/rooms' || path === '/api/rooms/join')) {
        const joining = path.endsWith('/join'); shape(body, joining ? ['code', 'character'] : ['character']);
        if (session.activeRoom || session.activeTournament) fail(409, 'Leave your current room before entering another.', 'active_room');
        if (session.pendingMercyRoom || session.pendingMercyTournament) fail(409, 'Your previous opponent must finish the mercy decision before this gladiator can enter another room.', 'pending_mercy');
        const profile = this.profile(session, body.character);
        let room;
        if (joining) {
          if (typeof body.code !== 'string' || !/^[A-Z2-9]{6}$/.test(body.code.toUpperCase())) fail(400, 'Room codes contain six letters or digits.');
          room = this.data.rooms[body.code.toUpperCase()];
          if (!room) fail(404, 'Room not found.', 'room_not_found');
          if (room.phase !== 'waiting' || room.players.length !== 1) fail(409, 'This room already has two players.', 'room_full');
          room.playerIds.push(session.playerId); room.players.push(profile); room.left.push(false);
          room.phase = 'equipment'; room.deadline = now + this.rules.equipmentMs;
          // Joining starts the host's connection grace period too.
          this.lastSeen.set(room.playerIds[0], now);
          const host = this.sessionForPlayer(room.playerIds[0]); if (host) host.lastSeen = now;
          this.touch(room);
        } else {
          session.roomStarts = session.roomStarts.filter(time => now - time < 3600000);
          if (session.roomStarts.length >= 20) fail(429, 'Room creation is limited to twenty rooms per hour.', 'rate_limited');
          if (Object.keys(this.data.rooms).length >= 2000) fail(503, 'The room limit has been reached.');
          const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          let code;
          do { code = [...randomBytes(6)].map(value => alphabet[value % alphabet.length]).join(''); } while (this.data.rooms[code] || this.data.tournaments[code]);
          room = { code, phase: 'waiting', revision: 1, duelId: randomUUID(), playerIds: [session.playerId], players: [profile],
            left: [false], loadouts: [null, null], actions: [null, null], duel: null, decision: null,
            rematchReady: [false, false], rematchProfiles: [null, null], deadline: null, commands: {}, history: [], createdAt: now };
          this.data.rooms[code] = room; session.roomStarts.push(now); this.changed = true;
        }
        session.profile = copy(profile); session.activeRoom = room.code;
        return this.roomView(room, joining ? 1 : 0);
      }
      const match = /^\/api\/rooms\/([A-Z2-9]{6})(?:\/(loadout|action|mercy|vote|rematch|leave))?$/.exec(path);
      if (!match) fail(404, 'Endpoint not found.');
      const { room, index } = this.member(session, match[1], match[2] === 'leave');
      if (method === 'GET' && !match[2]) return this.roomView(room, index);
      if (method !== 'POST' || !match[2]) fail(405, 'Method not allowed.');
      const kind = match[2];
      shape(body, ['commandId', 'duelId', ...(kind === 'loadout' ? ['loadout'] : kind === 'action' ? ['round', 'action'] : ['mercy', 'vote'].includes(kind) ? ['decision'] : kind === 'rematch' ? ['character'] : [])], kind === 'rematch' ? ['commandId', 'duelId'] : undefined);
      this.command(room, index, kind, body, () => {
        if (room.left[index]) fail(409, 'You have already left this room.');
        if (kind === 'loadout') {
          if (room.phase !== 'equipment') fail(409, 'Equipment selection has closed.', 'wrong_phase');
          if (room.loadouts[index]) fail(409, 'Your equipment is already locked.', 'choice_locked');
          shape(body.loadout, ['weapon', 'armor', 'helmet']);
          if (!has(combat.WEAPONS, body.loadout.weapon) || !has(combat.ARMORS, body.loadout.armor) || !has(combat.HELMETS, body.loadout.helmet)) fail(400, 'Choose valid equipment.');
          room.loadouts[index] = copy(body.loadout);
          if (room.loadouts.every(Boolean)) this.startBattle(room, now);
        } else if (kind === 'action') {
          if (room.phase !== 'battle') fail(409, 'The duel is not accepting actions.', 'wrong_phase');
          if (!Number.isInteger(body.round) || body.round !== room.duel.round) fail(409, 'That choice belongs to an earlier round.', 'stale_round');
          if (room.actions[index]) fail(409, 'Your choice is already locked for this round.', 'choice_locked');
          if (typeof body.action !== 'string') fail(400, 'Choose a valid action.');
          const option = combat.getActionOptions(room.duel, index).find(option => option.id === body.action);
          if (!option) fail(400, 'Choose a valid action.');
          if (!option.enabled) fail(409, 'You cannot afford that action. Choose Recover.', 'unaffordable');
          room.actions[index] = body.action;
          if (room.actions.every(Boolean)) this.resolveActions(room, now);
        } else if (kind === 'mercy') {
          if (!['spare', 'execute', 'crowd'].includes(body.decision)) fail(400, 'Choose spare, execute or the crowd.');
          if (room.phase !== 'mercy') fail(409, 'This duel is not awaiting a mercy decision.', 'wrong_phase');
          if (room.duel.result.winner !== index) fail(403, 'Only the winner chooses mercy.', 'forbidden');
          if (now < room.mercyOpensAt) fail(409, 'The winner reveal is still playing.', 'verdict_not_open');
          if (body.decision === 'crowd') this.startCrowd(room, [], now);
          else this.decide(room, body.decision);
        } else if (kind === 'vote') {
          if (!['spare', 'execute'].includes(body.decision)) fail(400, 'Choose spare or execute.');
          if (room.phase !== 'crowd') fail(409, 'The crowd is not voting.', 'wrong_phase');
          fail(403, 'Only eligible spectators can vote.', 'spectator');
        } else if (kind === 'rematch') {
          if (room.phase !== 'complete' || room.left.some(Boolean)) fail(409, 'Both players must remain in a completed room.', 'wrong_phase');
          if (room.rematchReady[index]) fail(409, 'You are already ready for the rematch.', 'choice_locked');
          if (room.players[index].alive) {
            if (body.character && (!sameCharacter(room.players[index].character, sanitizeCharacter(body.character)) || (body.character.id && body.character.id !== room.players[index].character.id))) fail(409, 'A surviving gladiator keeps their identity and attributes.', 'identity_locked');
            room.rematchProfiles[index] = copy(room.players[index]);
          } else {
            if (!body.character) fail(409, 'Create a replacement for your executed gladiator.', 'character_dead');
            room.rematchProfiles[index] = this.profile(session, body.character);
          }
          room.rematchReady[index] = true;
          if (room.rematchReady.every(Boolean)) {
            room.history.push({ duelId: room.duelId, players: copy(room.players), duel: room.duel, decision: room.decision });
            room.players = room.rematchProfiles; room.players.forEach((_, i) => this.saveProfile(room, i));
            room.duelId = randomUUID(); room.phase = 'equipment'; room.duel = null;
            room.loadouts = [null, null]; room.actions = [null, null]; room.decision = null; room.crowdVote = null;
            room.rematchReady = [false, false]; room.rematchProfiles = [null, null]; room.deadline = now + this.rules.equipmentMs;
          }
        } else if (kind === 'leave') {
          if (room.phase === 'equipment' || room.phase === 'battle') this.forfeit(room, index, now);
          if (room.phase === 'mercy') {
            if (room.duel.result.winner === index) this.decide(room, 'spare');
            else session.pendingMercyRoom = room.code;
          }
          if (room.phase === 'crowd' && room.duel.result.winner !== index) session.pendingMercyRoom = room.code;
          room.left[index] = true; session.activeRoom = null;
          if (room.phase === 'waiting') { room.phase = 'complete'; room.deadline = null; }
        }
      });
      return kind === 'leave' ? { left: true } : this.roomView(room, index);
    });
  }
}
