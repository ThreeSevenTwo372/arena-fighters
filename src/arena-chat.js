const DEFAULT_LIMIT = 240;
const MESSAGE_LIMIT = 60;
const ROOM_LIMIT = 8;
const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
const normalizedText = value => String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim();
const characters = value => Array.from(value).length;

/** A separate render tree keeps a spectator's draft and focus through game polls. */
export function mountArenaChat(host, { read, send, now = Date.now, uuid = () => globalThis.crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!host?.ownerDocument || typeof read !== 'function' || typeof send !== 'function') {
    return { setRoom() {}, refresh: async () => false, dispose() {}, getState: () => ({ visible: false }) };
  }
  const document = host.ownerDocument;
  const create = (tag, className, attributes = {}) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
    return element;
  };
  const details = create('details', 'arena-chat-panel');
  const summary = create('summary', 'arena-chat-heading');
  const title = create('span'); title.textContent = 'Arena lobby chat';
  const roomLabel = create('span', 'arena-chat-room');
  const unreadLabel = create('span', 'arena-chat-unread');
  summary.append(title, roomLabel, unreadLabel);
  const body = create('div', 'arena-chat-body');
  const log = create('ol', 'arena-chat-log', { role: 'log', 'aria-label': 'Arena lobby messages', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-atomic': 'false', tabindex: '0', 'data-chat-log': '' });
  const empty = create('p', 'arena-chat-empty'); empty.textContent = 'No messages yet. Say hello to the arena.';
  const form = create('form', 'arena-chat-form', { 'data-chat-form': '' });
  const label = create('label', 'arena-chat-label', { for: 'arena-chat-message' }); label.textContent = 'Message';
  const input = create('textarea', 'arena-chat-input', { id: 'arena-chat-message', rows: '2', placeholder: 'Chat with players and spectators…', 'aria-describedby': 'arena-chat-hint arena-chat-counter arena-chat-status', 'data-chat-input': '' });
  const footer = create('div', 'arena-chat-compose-footer');
  const hint = create('span', 'arena-chat-hint', { id: 'arena-chat-hint' }); hint.textContent = 'Enter to send · Shift+Enter for a new line';
  const counter = create('output', 'arena-chat-counter', { id: 'arena-chat-counter', 'data-chat-counter': '' });
  const button = create('button', 'arena-chat-send', { type: 'submit', 'data-chat-send': '' }); button.textContent = 'Send';
  footer.append(hint, counter, button);
  const status = create('p', 'arena-chat-status', { id: 'arena-chat-status', role: 'status', 'aria-live': 'polite', 'data-chat-status': '' });
  form.append(label, input, footer, status); body.append(log, empty, form); details.append(summary, body);
  host.replaceChildren(details); host.hidden = true;
  const rooms = new Map();
  let room = null, generation = 0, disposed = false, request = null, timer = null;
  const remember = descriptor => {
    const key = `${descriptor.tournamentId}:${descriptor.code}`;
    let record = rooms.get(key);
    if (!record) {
      record = { key, code: descriptor.code, tournamentId: descriptor.tournamentId, draft: '', pending: null, messages: [], nodes: new Map(), available: true, canSend: false, loaded: false, sending: false, error: '', readError: '', contentEpoch: 0, limit: DEFAULT_LIMIT, interval: 2000, cooldownUntil: 0, unread: 0, expanded: descriptor.expanded !== false };
      rooms.set(key, record);
      while (rooms.size > ROOM_LIMIT) rooms.delete(rooms.keys().next().value);
    }
    return record;
  };
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const update = () => {
    if (!room || disposed) return;
    const length = characters(input.value);
    const cooling = now() < room.cooldownUntil;
    counter.textContent = `${length}/${room.limit}`;
    input.setAttribute('aria-invalid', String(length > room.limit));
    button.disabled = room.sending || cooling || !room.available || !normalizedText(input.value) || length > room.limit;
    setText(button, room.sending ? 'Sending…' : cooling ? 'Wait…' : room.pending && room.error ? 'Retry' : 'Send');
    setText(status, room.error || room.readError || (!room.available ? 'Chat is unavailable for this arena.' : cooling ? 'Please wait a moment before sending another message.' : ''));
    setText(unreadLabel, room.unread && !details.open ? `${room.unread} new` : '');
    empty.hidden = room.messages.length > 0;
    cancelTimer();
    if (cooling) timer = setTimer(() => { timer = null; update(); }, Math.max(1, room.cooldownUntil - now()));
  };
  const messageNode = message => {
    const item = create('li', 'arena-chat-message', { 'data-chat-message': message.id });
    const heading = create('div', 'arena-chat-message-heading');
    const author = create('strong', 'arena-chat-author'); author.textContent = String(message.name || 'Spectator');
    const role = create('span', 'arena-chat-author-role'); role.textContent = message.role === 'fighter' || message.role === 'player' ? 'Fighter' : 'Spectator';
    heading.append(author, role);
    const timestamp = new Date(message.createdAt);
    if (!Number.isNaN(timestamp.getTime())) {
      const time = create('time', 'arena-chat-time', { datetime: timestamp.toISOString() });
      time.textContent = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); heading.append(time);
    }
    const text = create('p', 'arena-chat-message-text'); text.textContent = String(message.text ?? '');
    item.append(heading, text); return item;
  };
  const apply = (record, payload, { ownSend = false } = {}) => {
    if (!payload || payload.code !== record.code || payload.tournamentId !== record.tournamentId) return false;
    const messages = Array.isArray(payload.messages) ? payload.messages.filter(message => message && typeof message.id === 'string' && typeof message.text === 'string').slice(-MESSAGE_LIMIT) : [];
    const unique = [...new Map(messages.map(message => [message.id, message])).values()];
    const wasNearBottom = log.scrollHeight - log.clientHeight - log.scrollTop < 48;
    const currentIds = new Set(record.messages.map(message => message.id));
    const newCount = unique.filter(message => !currentIds.has(message.id)).length;
    record.messages = unique;
    record.readError = '';
    record.available = payload.available === true || payload.canSend === true;
    record.canSend = payload.canSend === true;
    record.limit = Number.isInteger(payload.maxLength) && payload.maxLength > 0 ? Math.min(DEFAULT_LIMIT, payload.maxLength) : DEFAULT_LIMIT;
    record.interval = Number.isFinite(payload.minIntervalMs) && payload.minIntervalMs >= 0 ? Math.min(60000, payload.minIntervalMs) : 2000;
    const firstLoad = !record.loaded;
    record.loaded = true;
    if (record !== room || disposed) return true;
    const retained = new Set(unique.map(message => message.id));
    for (const [id, node] of record.nodes) if (!retained.has(id)) { node.remove(); record.nodes.delete(id); }
    for (const message of unique) {
      if (!record.nodes.has(message.id)) { const node = messageNode(message); record.nodes.set(message.id, node); log.append(node); }
    }
    if (!details.open && !firstLoad) record.unread += newCount;
    if (ownSend || firstLoad || (details.open && wasNearBottom)) log.scrollTop = log.scrollHeight;
    update(); return true;
  };
  const refresh = () => {
    if (!room || disposed) return Promise.resolve(false);
    if (request?.record === room) return request.promise;
    const record = room, version = generation, epoch = record.contentEpoch;
    const pending = { record, promise: null };
    pending.promise = Promise.resolve().then(() => read(record.code)).then(payload => {
      if (disposed || generation !== version || room !== record || record.contentEpoch !== epoch) return false;
      return apply(record, payload);
    }).catch(() => {
      if (!disposed && generation === version && room === record && !record.loaded) { record.readError = 'Chat could not connect. It will retry while you stay in the arena.'; update(); }
      return false;
    }).finally(() => { if (request === pending) request = null; });
    request = pending; return pending.promise;
  };
  const submit = async event => {
    event?.preventDefault?.();
    if (!room || disposed) return false;
    const record = room;
    record.draft = input.value;
    const text = normalizedText(record.draft);
    if (record.sending || !record.available || now() < record.cooldownUntil || !text || characters(record.draft) > record.limit) return false;
    if (!record.pending || record.pending.text !== text) record.pending = { commandId: uuid(), text };
    const command = record.pending, sentDraft = record.draft;
    record.sending = true; record.error = ''; update();
    try {
      const payload = await send(record.code, { ...command });
      if (disposed) return false;
      if (!payload || payload.code !== record.code || payload.tournamentId !== record.tournamentId) throw new Error('Chat response did not identify this arena.');
      record.contentEpoch++;
      record.pending = null; record.cooldownUntil = now() + record.interval; record.error = '';
      if (record.draft === sentDraft) record.draft = '';
      apply(record, payload, { ownSend: true });
      if (room === record) {
        if (input.value === sentDraft) input.value = record.draft;
        update();
      }
      return true;
    } catch (error) {
      if (disposed) return false;
      record.error = error?.status === 429 ? 'Please wait a moment before sending another message.' : 'Message could not be confirmed. Retry to send it once.';
      if (error?.status === 429) record.cooldownUntil = now() + record.interval;
      else if (error?.status && error.status !== 408 && error.status < 500) { record.pending = null; record.error = String(error.message || 'The arena could not accept this message.'); }
      if (room === record) update();
      return false;
    } finally { record.sending = false; if (!disposed && room === record) update(); }
  };
  const onInput = () => { if (room) { room.draft = input.value; room.error = ''; update(); } };
  const onKeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); void submit(); }
    else event.stopPropagation();
  };
  const onToggle = () => {
    if (!room) return;
    room.expanded = details.open;
    if (details.open) { room.unread = 0; log.scrollTop = log.scrollHeight; }
    update();
  };
  input.addEventListener('input', onInput); input.addEventListener('keydown', onKeydown);
  form.addEventListener('submit', submit); details.addEventListener('toggle', onToggle);
  const setRoom = descriptor => {
    if (disposed) return;
    if (room) room.draft = input.value;
    const valid = descriptor?.visible !== false && typeof descriptor?.code === 'string' && typeof descriptor?.tournamentId === 'string';
    const next = valid ? remember(descriptor) : null;
    if (room === next) return;
    generation++; request = null; cancelTimer(); room = next; host.hidden = !room;
    if (!room) return;
    setText(roomLabel, room.code); details.open = room.expanded; input.value = room.draft;
    log.replaceChildren(); room.nodes = new Map();
    for (const message of room.messages) { const node = messageNode(message); room.nodes.set(message.id, node); log.append(node); }
    update(); void refresh();
  };
  return {
    setRoom, refresh,
    getState: () => ({ visible: Boolean(room && !disposed), code: room?.code ?? null, tournamentId: room?.tournamentId ?? null, draft: room?.draft ?? '', messageCount: room?.messages.length ?? 0, sending: Boolean(room?.sending), pendingCommandId: room?.pending?.commandId ?? null, error: room?.error || room?.readError || '' }),
    dispose() {
      if (disposed) return; disposed = true; generation++; cancelTimer(); host.hidden = true;
      input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKeydown);
      form.removeEventListener('submit', submit); details.removeEventListener('toggle', onToggle);
    },
  };
}
