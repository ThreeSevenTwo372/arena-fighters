/** Requests carry intentions only. Damage, hidden choices and results live on the service. */
const TOKEN_KEY = 'last-laurel.guest.v1';
const TEMPORARY_TOKEN_KEY = 'last-laurel.temporary-guest.v1';

function sessionMode() {
  try {
    return globalThis.document?.querySelector?.('meta[name="arena-session-mode"]')?.content === 'temporary' ? 'temporary' : 'persistent';
  } catch { return 'persistent'; }
}

export class OnlineClient {
  constructor({ storage, fetcher = globalThis.fetch } = {}) {
    this.sessionMode = sessionMode();
    this.tokenKey = this.sessionMode === 'temporary' ? TEMPORARY_TOKEN_KEY : TOKEN_KEY;
    this.storageWarning = null;
    this.fetcher = fetcher.bind(globalThis);
    this.token = null;
    try {
      this.storage = storage === undefined ? globalThis[this.sessionMode === 'temporary' ? 'sessionStorage' : 'localStorage'] : storage;
      this.token = this.storage?.getItem(this.tokenKey) || null;
      if (!this.storage) this.storageUnavailable();
    } catch { this.storageUnavailable(); }
  }

  storageUnavailable() {
    this.storage = null;
    if (this.sessionMode === 'temporary') this.storageWarning = 'This browser cannot retain your session. Refreshing the page will start a new fighter.';
  }

  saveToken(token) {
    this.token = token;
    try {
      if (token) this.storage?.setItem(this.tokenKey, token);
      else this.storage?.removeItem(this.tokenKey);
    } catch { this.storageUnavailable(); }
  }

  async request(path, body, { retry = body !== undefined } = {}) {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await this.fetcher(path, {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'omit', cache: 'no-store', signal: controller.signal,
          headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
          body: serialized,
        });
        const data = await response.json();
        if (!response.ok) {
          const error = new Error(typeof data.error === 'string' ? data.error : data.message || 'The service could not accept this request.');
          error.status = response.status;
          throw error;
        }
        return data;
      } catch (error) {
        if (error.status || !retry || attempt >= 1) {
          if (!error.status) throw new Error('Connection interrupted. Your committed choices stay on the server; reconnect to check the duel.');
          throw error;
        }
        // The exact same command ID and body survive an unknown network outcome.
      } finally { clearTimeout(timer); }
    }
  }

  async session({ create = true } = {}) {
    if (!this.token) {
      if (!create) return null;
      const guest = await this.request('/api/session', {}, { retry: false });
      this.saveToken(guest.token);
    }
    try { return await this.request('/api/session'); }
    catch (error) {
      if (error.status !== 401) throw error;
      this.saveToken(null);
      return create ? this.session() : null;
    }
  }

  async enter(path, payload) {
    await this.session();
    try { return await this.request(path, payload, { retry: false }); }
    catch (error) {
      if (!error.status) {
        // Creation/join can succeed even if its acknowledgement never arrives.
        const session = await this.session();
        if (session.activeRoom && (!payload.code || session.activeRoom === payload.code)) return this.room(session.activeRoom);
      }
      throw error;
    }
  }
  create(character) { return this.enter('/api/rooms', { character }); }
  join(code, character) { return this.enter('/api/rooms/join', { code: code.trim().toUpperCase(), character }); }
  room(code) { return this.request(`/api/rooms/${encodeURIComponent(code)}`); }
  command(view, action, payload = {}) {
    return this.request(`/api/rooms/${encodeURIComponent(view.code)}/${action}`, {
      commandId: globalThis.crypto.randomUUID(), duelId: view.duelId, ...payload,
    });
  }
  vote(view, decision) { return this.command(view, 'vote', { decision }); }
  resetMatchContext() { /* Match context changes retain the current session's authoritative guest token. */ }
}
