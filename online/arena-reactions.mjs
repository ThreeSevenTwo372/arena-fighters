import { randomUUID } from 'node:crypto';
import { ApiError } from './service.mjs';

export const REACTION_KINDS = Object.freeze(['cheer', 'applause', 'tomato']);
export const REACTION_LIMITS = Object.freeze({ minIntervalMs: 3000, ttlMs: 6000, maxReactions: 24,
  receiptMs: 60000, maxRooms: 64, maxCommands: 256 });
const fail = (status, message, code = 'invalid_request') => { throw new ApiError(status, message, code); };
const copy = value => structuredClone(value);

/** Public atmosphere only. No reaction state enters a fighter or durable store. */
export class ArenaReactions {
  constructor() { this.rooms = new Map(); this.rates = new Map(); this.undo = null; }
  beginTransaction() { this.undo = null; }
  commitTransaction() { this.undo = null; }
  rollbackTransaction() { this.undo?.(); this.undo = null; }
  cleanup(tournaments, now) {
    const active = new Set(Object.values(tournaments).map(tournament => tournament.tournamentId));
    for (const [id, room] of this.rooms) {
      if (!active.has(id) || now - room.updatedAt >= REACTION_LIMITS.receiptMs) { this.rooms.delete(id); continue; }
      room.reactions = room.reactions.filter(reaction => now - reaction.createdAt < REACTION_LIMITS.ttlMs);
      for (const [key, receipt] of room.commands) if (now - receipt.createdAt >= REACTION_LIMITS.receiptMs) room.commands.delete(key);
    }
    for (const [id, sentAt] of this.rates) if (now - sentAt >= REACTION_LIMITS.receiptMs) this.rates.delete(id);
  }
  eligibility(tournament, session) {
    if (tournament.phase === 'complete') return { allowed: false, reason: 'This tournament has ended.', code: 'wrong_phase' };
    // An anonymous observer can obtain an ordinary guest on their first send.
    if (!session) return { allowed: true };
    if (session.profile?.alive === false || session.pendingMercyRoom || session.pendingMercyTournament) {
      return { allowed: false, reason: 'A defeated or departing fighter cannot send crowd reactions.', code: 'spectator' };
    }
    const slot = tournament.playerIds.indexOf(session.playerId);
    if (slot >= 0 && (tournament.left[slot] || !tournament.players[slot].alive || tournament.players[slot].bot === true)) {
      return { allowed: false, reason: 'A departed fighter cannot send crowd reactions.', code: 'spectator' };
    }
    if (tournament.match?.playerIds.includes(session.playerId)) {
      return { allowed: false, reason: 'The two current duelists cannot send crowd reactions.', code: 'spectator' };
    }
    return { allowed: true };
  }
  view(tournament, session, now) {
    const eligibility = this.eligibility(tournament, session);
    const sentAt = session ? this.rates.get(session.playerId) : undefined;
    return { tournamentId: tournament.tournamentId, code: tournament.code,
      available: tournament.phase !== 'complete', canSend: eligibility.allowed,
      reactions: copy((this.rooms.get(tournament.tournamentId)?.reactions ?? [])
        .filter(reaction => now - reaction.createdAt < REACTION_LIMITS.ttlMs)),
      minIntervalMs: REACTION_LIMITS.minIntervalMs, ttlMs: REACTION_LIMITS.ttlMs,
      nextSendAt: sentAt === undefined ? now : sentAt + REACTION_LIMITS.minIntervalMs };
  }
  post(tournament, session, body, now) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'commandId') || !Object.hasOwn(body, 'kind')) fail(400, 'Invalid crowd reaction fields.');
    if (typeof body.commandId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(body.commandId)) fail(400, 'Choose a valid commandId.');
    if (!REACTION_KINDS.includes(body.kind)) fail(400, 'Choose Cheer, Applause or Tomato.');
    const id = tournament.tournamentId, key = `${session.playerId}:${body.commandId}`;
    let room = this.rooms.get(id);
    const previous = room?.commands.get(key);
    if (previous) {
      if (previous.kind !== body.kind) fail(409, 'This commandId was already used for a different reaction.', 'command_conflict');
      return this.view(tournament, session, now);
    }
    const eligibility = this.eligibility(tournament, session);
    if (!eligibility.allowed) fail(eligibility.code === 'wrong_phase' ? 409 : 403, eligibility.reason, eligibility.code);
    const sentAt = this.rates.get(session.playerId);
    if (sentAt !== undefined && now - sentAt < REACTION_LIMITS.minIntervalMs) fail(429, 'Wait three seconds before another crowd reaction.', 'rate_limited');
    if (!room && this.rooms.size >= REACTION_LIMITS.maxRooms) fail(503, 'The crowd reaction limit has been reached. Try again shortly.', 'reactions_full');
    const beforeRoom = room ? copy(room) : null;
    this.undo = () => {
      if (beforeRoom) this.rooms.set(id, beforeRoom); else this.rooms.delete(id);
      if (sentAt === undefined) this.rates.delete(session.playerId); else this.rates.set(session.playerId, sentAt);
    };
    if (!room) { room = { reactions: [], commands: new Map(), updatedAt: now }; this.rooms.set(id, room); }
    room.reactions.push({ id: randomUUID(), kind: body.kind, createdAt: now });
    if (room.reactions.length > REACTION_LIMITS.maxReactions) room.reactions.splice(0, room.reactions.length - REACTION_LIMITS.maxReactions);
    room.commands.set(key, { kind: body.kind, createdAt: now });
    if (room.commands.size > REACTION_LIMITS.maxCommands) room.commands.delete(room.commands.keys().next().value);
    room.updatedAt = now; this.rates.set(session.playerId, now);
    return this.view(tournament, session, now);
  }
}
