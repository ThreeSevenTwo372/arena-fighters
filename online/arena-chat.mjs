import { randomUUID } from 'node:crypto';
import { ApiError } from './service.mjs';

export const CHAT_LIMITS = Object.freeze({ maxLength: 240, minIntervalMs: 2000, perMinute: 10,
  maxMessages: 60, ttlMs: 3600000, maxRooms: 64, maxAuthors: 256, maxCommands: 512 });
const fail = (status, message, code = 'invalid_request') => { throw new ApiError(status, message, code); };
const copy = value => structuredClone(value);

export function normalizeChatText(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) fail(400, 'Write a valid chat message.');
  // Chat is plain text. Fold line breaks to keep each message on a single line,
  // but reject invisible controls and directional overrides that obscure names.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    fail(400, 'Chat messages cannot contain control or directional characters.');
  }
  const text = value.normalize('NFC').replace(/[\t\r\n\u2028\u2029]+/gu, ' ').trim();
  if (!text || Array.from(text).length > CHAT_LIMITS.maxLength) fail(400, `Chat messages must contain 1 to ${CHAT_LIMITS.maxLength} characters.`);
  return text;
}

/** Ephemeral conversation state stays outside every fighter/save-store record. */
export class ArenaChat {
  constructor() { this.rooms = new Map(); this.rates = new Map(); this.undo = null; }
  beginTransaction() { this.undo = null; }
  commitTransaction() { this.undo = null; }
  rollbackTransaction() { this.undo?.(); this.undo = null; }
  cleanup(tournaments, now) {
    const active = new Set(Object.values(tournaments).map(tournament => tournament.tournamentId));
    for (const [id, room] of this.rooms) {
      if (!active.has(id) || now - room.updatedAt >= CHAT_LIMITS.ttlMs) { this.rooms.delete(id); continue; }
      room.messages = room.messages.filter(message => now - message.createdAt < CHAT_LIMITS.ttlMs);
      for (const [playerId, author] of room.authors) if (now - author.updatedAt >= CHAT_LIMITS.ttlMs) room.authors.delete(playerId);
      for (const [key, receipt] of room.commands) if (now - receipt.createdAt >= CHAT_LIMITS.ttlMs) room.commands.delete(key);
    }
    for (const [playerId, times] of this.rates) {
      const recent = times.filter(time => now - time < 60000);
      if (recent.length) this.rates.set(playerId, recent); else this.rates.delete(playerId);
    }
  }
  view(tournament, session) {
    const room = this.rooms.get(tournament.tournamentId);
    return { tournamentId: tournament.tournamentId, code: tournament.code, available: true,
      messages: copy(room?.messages ?? []), canSend: Boolean(session),
      you: session ? room?.authors.get(session.playerId)?.id ?? null : null,
      maxLength: CHAT_LIMITS.maxLength, minIntervalMs: CHAT_LIMITS.minIntervalMs };
  }
  post(tournament, session, body, now) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2
      || !Object.hasOwn(body, 'commandId') || !Object.hasOwn(body, 'text')) fail(400, 'Invalid chat request fields.');
    if (typeof body.commandId !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(body.commandId)) fail(400, 'Choose a valid commandId.');
    const text = normalizeChatText(body.text);
    const id = tournament.tournamentId;
    let room = this.rooms.get(id);
    const key = `${session.playerId}:${body.commandId}`;
    const previous = room?.commands.get(key);
    if (previous) {
      if (previous.text !== text) fail(409, 'This commandId was already used for a different message.', 'command_conflict');
      return this.view(tournament, session);
    }
    const recent = (this.rates.get(session.playerId) ?? []).filter(time => now - time < 60000);
    if (recent.length && now - recent.at(-1) < CHAT_LIMITS.minIntervalMs) fail(429, 'Wait two seconds before sending another message.', 'rate_limited');
    if (recent.length >= CHAT_LIMITS.perMinute) fail(429, 'Chat is limited to ten messages per minute.', 'rate_limited');
    if (!room && this.rooms.size >= CHAT_LIMITS.maxRooms) fail(503, 'The arena chat limit has been reached. Try again later.', 'chat_full');
    if (room && !room.authors.has(session.playerId) && room.authors.size >= CHAT_LIMITS.maxAuthors) fail(503, 'This arena chat is full. Try again later.', 'chat_full');
    // Roll back an accepted message if the surrounding guest heartbeat fails to
    // persist. The message itself is never part of that persistence operation.
    const beforeRoom = room ? copy(room) : null, beforeRate = this.rates.get(session.playerId);
    this.undo = () => {
      if (beforeRoom) this.rooms.set(id, beforeRoom); else this.rooms.delete(id);
      if (beforeRate) this.rates.set(session.playerId, beforeRate); else this.rates.delete(session.playerId);
    };
    if (!room) {
      room = { messages: [], authors: new Map(), commands: new Map(), nextSpectator: 1, updatedAt: now };
      this.rooms.set(id, room);
    }
    let author = room.authors.get(session.playerId);
    if (!author) { author = { id: randomUUID(), spectatorName: null, updatedAt: now }; room.authors.set(session.playerId, author); }
    const slot = tournament.playerIds.indexOf(session.playerId);
    const fighter = slot >= 0 && !tournament.left[slot] && tournament.players[slot].bot !== true;
    if (!fighter && !author.spectatorName) author.spectatorName = `Spectator ${room.nextSpectator++}`;
    author.updatedAt = now;
    const message = { id: randomUUID(), authorId: author.id,
      name: fighter ? tournament.players[slot].character.name : author.spectatorName,
      role: fighter ? 'fighter' : 'spectator', text, createdAt: now };
    room.messages.push(message);
    if (room.messages.length > CHAT_LIMITS.maxMessages) room.messages.splice(0, room.messages.length - CHAT_LIMITS.maxMessages);
    room.commands.set(key, { text, createdAt: now });
    if (room.commands.size > CHAT_LIMITS.maxCommands) room.commands.delete(room.commands.keys().next().value);
    room.updatedAt = now;
    recent.push(now); this.rates.set(session.playerId, recent);
    return this.view(tournament, session);
  }
}
