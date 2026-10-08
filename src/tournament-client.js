import { OnlineClient } from './online-client.js';

/** Tournament commands reuse the durable guest identity and request retries. */
export class TournamentClient extends OnlineClient {
  constructor({ duelMode = false, ...options } = {}) {
    super(options);
    this.duelMode = Boolean(duelMode);
    this.legacyRoom = this.duelMode;
  }
  async enter(path, payload) {
    if (path.startsWith('/api/rooms')) return super.enter(path, payload);
    await this.session();
    try { return await this.request(path, payload, { retry: false }); }
    catch (error) {
      if (!error.status) {
        const session = await this.session();
        if (session.activeTournament && (!payload.code || session.activeTournament === payload.code)) return this.room(session.activeTournament);
      }
      throw error;
    }
  }
  create(character) {
    this.legacyRoom = this.duelMode;
    return this.duelMode ? super.create(character) : this.enter('/api/tournaments/enter', { character });
  }
  host(character) { this.legacyRoom = false; return this.enter('/api/tournaments', { character }); }
  join(code, character) {
    this.legacyRoom = this.duelMode;
    return this.duelMode ? super.join(code, character) : this.enter('/api/tournaments/join', { code: code.trim().toUpperCase(), character });
  }
  room(code) { return this.request(`/api/${this.legacyRoom ? 'rooms' : 'tournaments'}/${encodeURIComponent(code)}`); }
  resetMatchContext() { this.legacyRoom = this.duelMode; }
  command(view, action, payload = {}) {
    const legacyRoom = view.type === 'tournament' ? false : this.legacyRoom;
    return this.request(`/api/${legacyRoom ? 'rooms' : 'tournaments'}/${encodeURIComponent(view.code)}/${action}`, {
      commandId: globalThis.crypto.randomUUID(), duelId: view.duelId, ...payload,
    });
  }
}
