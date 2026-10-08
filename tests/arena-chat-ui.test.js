import test from 'node:test';
import assert from 'node:assert/strict';
import { mountArenaChat } from '../src/arena-chat.js';

const settle = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const descriptor = (code = 'ABC234', tournamentId = 'tournament-1') => ({ code, tournamentId, visible: true, expanded: true });
const message = (id, text = `Message ${id}`) => ({ id: String(id), authorId: 'alias-1', name: 'Cassian', role: 'fighter', text, createdAt: '2026-10-08T12:00:00Z' });
const view = (messages = [], { code = 'ABC234', tournamentId = 'tournament-1', ...overrides } = {}) => ({ code, tournamentId, available: true, canSend: false, you: null, messages, maxLength: 240, minIntervalMs: 2000, ...overrides });

class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.open = false; this.scrollTop = 0; this.clientHeight = 100; this._text = ''; this._scrollHeight = null; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(text) { this._text = String(text); this.children = []; }
  set innerHTML(_value) { throw new Error('The chat must construct plain text nodes.'); }
  get scrollHeight() { return this._scrollHeight ?? this.children.length * 50; }
  set scrollHeight(value) { this._scrollHeight = value; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatch(name, extra = {}) { const event = { target: this, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...extra }; for (const handler of this.listeners.get(name) ?? []) handler(event); return event; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('[') ? node.attributes.has(selector.slice(1, -1)) : selector.startsWith('.') ? String(node.className ?? '').split(' ').includes(selector.slice(1)) : node.tagName.toLowerCase() === selector;
    const result = [];
    const visit = node => { for (const child of node.children) { if (matches(child)) result.push(child); visit(child); } }; visit(this); return result;
  }
  focus() { this.ownerDocument.activeElement = this; }
}

function fixture({ read = async () => view(), send, start = 10000 } = {}) {
  const document = { activeElement: null, createElement(tag) { return new Element(tag, this); } };
  const host = document.createElement('aside'), reads = [], sends = [], timers = new Map();
  let time = start, nextTimer = 0, command = 0;
  const controller = mountArenaChat(host, {
    read: code => { reads.push(code); return read(code); },
    send: async (code, body) => { sends.push({ code, body: { ...body } }); return send ? send(code, body) : view([message('accepted', body.text)], { canSend: true, you: 'alias-1' }); },
    now: () => time, uuid: () => `command-${++command}`,
    setTimer: (callback, duration) => { const id = ++nextTimer; timers.set(id, { callback, duration }); return id; }, clearTimer: id => timers.delete(id),
  });
  const input = host.querySelector('[data-chat-input]'), form = host.querySelector('[data-chat-form]'), log = host.querySelector('[data-chat-log]'), button = host.querySelector('[data-chat-send]'), details = host.querySelector('details'), status = host.querySelector('[data-chat-status]');
  return { controller, host, input, form, log, button, details, status, reads, sends, timers,
    type(text) { input.value = text; input.dispatch('input'); }, send() { form.dispatch('submit'); },
    advance(ms) { time += ms; for (const [id, entry] of [...timers]) if (entry.duration <= ms) { timers.delete(id); entry.callback(); } },
  };
}

test('chat stays hidden until an arena is selected, then anonymous visitors can send without a fighter', async () => {
  const f = fixture(); assert.equal(f.host.hidden, true); assert.equal(f.reads.length, 0);
  f.controller.setRoom(descriptor()); await settle();
  assert.equal(f.host.hidden, false); assert.equal(f.details.open, true);
  f.type('Hello from the stands'); assert.equal(f.button.disabled, false);
  f.send(); await settle();
  assert.deepEqual(f.sends, [{ code: 'ABC234', body: { commandId: 'command-1', text: 'Hello from the stands' } }]);
  assert.equal(f.input.value, ''); assert.equal(f.log.children.length, 1);
});

test('waiting, entrance, and spectator polls of the same room retain the draft, focus, and collapse choice', async () => {
  const f = fixture({ read: async () => view([message('one')]) });
  f.controller.setRoom(descriptor()); await settle(); f.type('My unfinished thought'); f.input.focus();
  const firstMessage = f.log.children[0]; f.details.open = false; f.details.dispatch('toggle');
  for (let n = 0; n < 4; n++) { f.controller.setRoom({ ...descriptor(), expanded: true }); await f.controller.refresh(); }
  assert.equal(f.input.value, 'My unfinished thought'); assert.equal(f.input.ownerDocument.activeElement, f.input);
  assert.equal(f.log.children[0], firstMessage); assert.equal(f.details.open, false);
});

test('player names and message HTML render as plain text with accessible incremental log semantics', async () => {
  const unsafe = { ...message('xss', '<img src=x onerror=alert(1)>'), name: '<script>bad()</script>' };
  const f = fixture({ read: async () => view([unsafe]) }); f.controller.setRoom(descriptor()); await settle();
  assert.match(f.log.textContent, /<script>bad\(\)<\/script>/); assert.match(f.log.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(f.log.querySelectorAll('img').length, 0); assert.equal(f.log.querySelectorAll('script').length, 0);
  assert.equal(f.log.getAttribute('role'), 'log'); assert.equal(f.log.getAttribute('aria-relevant'), 'additions');
  assert.equal(f.log.getAttribute('aria-atomic'), 'false');
});

test('polling appends each message once and trims the oldest retained history to sixty', async () => {
  let messages = [message(1)]; const f = fixture({ read: async () => view(messages) });
  f.controller.setRoom(descriptor()); await settle(); const first = f.log.children[0];
  messages = [message(1), message(1), message(2)]; await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.log.children.length, 2); assert.equal(f.log.children[0], first);
  messages = Array.from({ length: 75 }, (_, n) => message(n)); await f.controller.refresh();
  assert.equal(f.log.children.length, 60); assert.equal(f.log.children[0].getAttribute('data-chat-message'), '15');
  assert.equal(f.controller.getState().messageCount, 60);
});

test('an interrupted send retries the exact command and body, while an edited message gets a new command', async () => {
  let attempts = 0; const f = fixture({ send: async (_code, body) => { if (++attempts === 1) throw new Error('Lost acknowledgement'); return view([message('accepted', body.text)]); } });
  f.controller.setRoom(descriptor()); await settle(); f.type('  Hello\n  arena  '); f.send(); await settle();
  assert.equal(f.input.value, '  Hello\n  arena  '); assert.equal(f.button.textContent, 'Retry');
  f.send(); await settle(); assert.deepEqual(f.sends[0], f.sends[1]); assert.equal(f.sends[1].body.text, 'Hello arena');
  f.advance(2000); f.type('Another message'); f.send(); await settle();
  assert.equal(f.sends[2].body.commandId, 'command-2');
});

test('editing after an unknown send outcome retains the draft and uses a fresh id for the new text', async () => {
  const f = fixture({ send: async () => { throw new Error('Offline'); } });
  f.controller.setRoom(descriptor()); await settle(); f.type('First'); f.send(); await settle();
  f.type('Second'); f.send(); await settle(); assert.equal(f.sends[0].body.commandId, 'command-1'); assert.equal(f.sends[1].body.commandId, 'command-2');
  assert.equal(f.input.value, 'Second');
});

test('a successful send enforces the local cooldown without sending extra requests', async () => {
  const f = fixture(); f.controller.setRoom(descriptor()); await settle(); f.type('First'); f.send(); await settle();
  f.type('Second'); assert.equal(f.button.disabled, true); f.send(); await settle(); assert.equal(f.sends.length, 1);
  f.advance(2000); assert.equal(f.button.disabled, false); f.send(); await settle(); assert.equal(f.sends.length, 2);
});

test('typing a new draft while a send is pending never clears the new draft', async () => {
  const response = deferred(); const f = fixture({ send: () => response.promise });
  f.controller.setRoom(descriptor()); await settle(); f.type('Sending this'); f.send(); await settle();
  f.type('Next thought'); response.resolve(view([message('accepted', 'Sending this')])); await settle();
  assert.equal(f.input.value, 'Next thought'); assert.equal(f.controller.getState().draft, 'Next thought');
});

test('Enter sends once; Shift+Enter and IME composition keep typing separate from game hotkeys', async () => {
  const f = fixture(); f.controller.setRoom(descriptor()); await settle(); f.type('Hello');
  let event = f.input.dispatch('keydown', { key: 'Enter', shiftKey: true }); assert.equal(event.prevented, false); assert.equal(event.stopped, true);
  event = f.input.dispatch('keydown', { key: 'Enter', isComposing: true }); assert.equal(event.prevented, false); assert.equal(f.sends.length, 0);
  event = f.input.dispatch('keydown', { key: '1' }); assert.equal(event.stopped, true);
  event = f.input.dispatch('keydown', { key: 'Enter' }); await settle(); assert.equal(event.prevented, true); assert.equal(f.sends.length, 1);
});

test('history polling does not drag a reader down, but a user send follows their accepted message', async () => {
  let messages = Array.from({ length: 8 }, (_, n) => message(n)); const f = fixture({ read: async () => view(messages) });
  f.controller.setRoom(descriptor()); await settle(); f.log.scrollTop = 0;
  messages.push(message(9)); await f.controller.refresh(); assert.equal(f.log.scrollTop, 0);
  f.log.scrollTop = f.log.scrollHeight - f.log.clientHeight; messages.push(message(10)); await f.controller.refresh();
  assert.equal(f.log.scrollTop, f.log.scrollHeight);
  f.log.scrollTop = 0; f.type('My message'); f.send(); await settle(); assert.equal(f.log.scrollTop, f.log.scrollHeight);
});

test('changing rooms discards stale read responses and restores the correct per-room draft', async () => {
  const firstRead = deferred(); const f = fixture({ read: code => code === 'ABC234' ? firstRead.promise : Promise.resolve(view([message('room-b')], { code, tournamentId: 'tournament-2' })) });
  f.controller.setRoom(descriptor()); await settle(); f.type('Room A draft');
  f.controller.setRoom(descriptor('DEF567', 'tournament-2')); await settle(); f.type('Room B draft');
  firstRead.resolve(view([message('stale-a')])); await settle(); assert.equal(f.log.children[0].getAttribute('data-chat-message'), 'room-b');
  assert.equal(f.input.value, 'Room B draft'); f.controller.setRoom(null); assert.equal(f.host.hidden, true);
  f.controller.setRoom(descriptor()); await settle(); assert.equal(f.input.value, 'Room A draft');
});

test('an accepted POST cannot be overwritten by an older GET begun before that send', async () => {
  const oldRead = deferred(); let reads = 0; const f = fixture({ read: () => ++reads === 1 ? Promise.resolve(view()) : oldRead.promise });
  f.controller.setRoom(descriptor()); await settle(); const pendingRead = f.controller.refresh(); await settle();
  f.type('Arrived'); f.send(); await settle(); assert.equal(f.log.children.length, 1);
  oldRead.resolve(view()); await pendingRead; assert.equal(f.log.children.length, 1);
});

test('a hidden and restored room still receives its own in-flight send confirmation without losing a newer draft', async () => {
  const reply = deferred(); const f = fixture({ send: () => reply.promise }); f.controller.setRoom(descriptor()); await settle();
  f.type('Sent'); f.send(); await settle(); f.controller.setRoom(null); f.controller.setRoom(descriptor()); await settle();
  f.type('New draft'); reply.resolve(view([message('accepted', 'Sent')])); await settle();
  assert.equal(f.input.value, 'New draft'); assert.equal(f.log.children.length, 1); assert.equal(f.controller.getState().sending, false);
});

test('Unicode limits count characters rather than UTF-16 halves and leave oversized drafts intact', async () => {
  const f = fixture(); f.controller.setRoom(descriptor()); await settle(); f.type('😀'.repeat(240));
  assert.equal(f.button.disabled, false); assert.equal(f.host.querySelector('[data-chat-counter]').textContent, '240/240');
  f.type('😀'.repeat(241)); assert.equal(f.button.disabled, true); f.send(); await settle(); assert.equal(f.sends.length, 0);
  assert.equal(f.input.getAttribute('aria-invalid'), 'true'); assert.equal(Array.from(f.input.value).length, 241);
});

test('server validation and throttling preserve the message and show an inline error', async () => {
  let status = 400; const f = fixture({ send: async () => { throw Object.assign(new Error('Message contains unsupported characters.'), { status }); } });
  f.controller.setRoom(descriptor()); await settle(); f.type('Rejected'); f.send(); await settle();
  assert.equal(f.input.value, 'Rejected'); assert.match(f.status.textContent, /unsupported/); assert.equal(f.controller.getState().pendingCommandId, null);
  status = 429; f.type('Slow down'); f.send(); await settle(); assert.equal(f.button.disabled, true); assert.match(f.status.textContent, /wait/);
  f.advance(2000); assert.equal(f.button.disabled, false);
});

test('read backpressure, recovery, unavailable rooms, and disposal keep the widget bounded', async () => {
  const response = deferred(); let attempt = 0; const f = fixture({ read: () => ++attempt === 1 ? response.promise : Promise.resolve(view([], { available: false, canSend: false })) });
  f.controller.setRoom(descriptor()); const one = f.controller.refresh(), two = f.controller.refresh(); assert.equal(one, two); await settle(); assert.equal(f.reads.length, 1);
  response.reject(new Error('Offline')); await one; assert.match(f.status.textContent, /could not connect/);
  await f.controller.refresh(); assert.match(f.status.textContent, /unavailable/); f.type('Cannot send'); assert.equal(f.button.disabled, true);
  f.controller.dispose(); assert.equal(f.host.hidden, true); assert.equal(f.timers.size, 0); f.send(); await settle(); assert.equal(f.sends.length, 0);
});
