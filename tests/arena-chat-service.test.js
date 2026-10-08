import test from 'node:test';
import assert from 'node:assert/strict';
import { DuelService } from '../online/service.mjs';
import { MemoryStore } from '../online/store.mjs';
import { ArenaChat, CHAT_LIMITS } from '../online/arena-chat.mjs';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
const error = (status, code) => actual => actual.status === status && (!code || actual.code === code);
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const chatPath = view => `/api/arena/tournaments/${view.code}/chat`;
async function fixture(t, options = {}) {
  let now = 1000000, service, failing = false;
  const store = new MemoryStore(), originalWrite = store.write.bind(store);
  store.write = async data => { if (failing) throw new Error('Synthetic persistence failure'); await originalWrite(data); };
  const config = { store, clock: () => now, disconnectMs: 10000000, winnerMs: 0, ...options };
  service = new DuelService(config);
  await service.initialized;
  t.after(() => service.close());
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const guests = [];
  return { request, guests, store, get service() { return service; }, get now() { return now; },
    fail(value) { failing = value; },
    async tick(delta = 0) { now += delta; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(config); await service.initialized; },
    async guest() { const guest = await request('POST', '/api/session', undefined, {}); guests.push(guest); return guest; },
    async waiting(name = 'Cassian') {
      const owner = await this.guest();
      const view = await request('POST', '/api/tournaments', owner.token, { character: character(name) });
      return { owner, view };
    },
    async lobby() {
      let { owner, view } = await this.waiting('Fighter 1');
      const entrants = [owner];
      for (let index = 1; index < 8; index += 1) {
        const guest = await this.guest(); entrants.push(guest);
        view = await request('POST', '/api/tournaments/join', guest.token, { code: view.code, character: character(`Fighter ${index + 1}`) });
      }
      return { entrants, view };
    },
    read(view, guest) { return request('GET', chatPath(view), guest?.token); },
    post(view, guest, commandId, text) { return request('POST', chatPath(view), guest?.token, { commandId, text }); },
  };
}

test('anonymous chat reads create no guest, fighter, seat, alias or durable state', async t => {
  const f = await fixture(t), { view } = await f.waiting();
  const before = structuredClone(f.service.data), result = await f.read(view);
  assert.deepEqual(result, { tournamentId: view.tournamentId, code: view.code, available: true,
    messages: [], canSend: false, you: null, maxLength: 240, minIntervalMs: 2000 });
  assert.deepEqual(f.service.data, before); assert.equal(f.service.arenaChat.rooms.size, 0);
  assert.deepEqual(await f.request('GET', chatPath(view), 'malformed-token'), result);
  await assert.rejects(f.post(view, null, 'unauthenticated', 'Hello'), error(401, 'unauthorized'));
  await assert.rejects(f.request('PUT', chatPath(view), null, {}), error(405));
  await assert.rejects(f.request('GET', '/api/arena/tournaments/ABC234/chat'), error(404, 'room_not_found'));
});

test('fighter names come from the current roster and outside guests get opaque per-room spectator aliases', async t => {
  const f = await fixture(t), one = await f.waiting('Cassian'), two = await f.waiting('Mira'), outsider = await f.guest();
  const fromFighter = await f.post(one.view, one.owner, 'fighter-chat', 'Welcome');
  assert.equal(fromFighter.messages[0].name, 'Cassian'); assert.equal(fromFighter.messages[0].role, 'fighter');
  const first = await f.post(one.view, outsider, 'spectator-chat', 'Good luck!');
  assert.equal(first.canSend, true); assert.equal(first.messages[1].name, 'Spectator 1');
  assert.equal(first.messages[1].role, 'spectator'); assert.equal(first.you, first.messages[1].authorId);
  assert.notEqual(first.you, outsider.playerId); assert.notEqual(first.you, fromFighter.you);
  await f.tick(2000);
  const second = await f.post(two.view, outsider, 'other-room', 'Another arena');
  assert.notEqual(second.you, first.you); assert.equal(second.messages[0].name, 'Spectator 1');
  assert.equal((await f.read(one.view, outsider)).you, first.you);
  for (const guest of f.guests) {
    assert.ok(!JSON.stringify(first).includes(guest.token)); assert.ok(!JSON.stringify(first).includes(guest.playerId));
  }
  const session = await f.request('GET', '/api/session', outsider.token);
  assert.equal(session.character, null); assert.equal(session.activeTournament, null); assert.equal(session.activeRoom, null);
  assert.equal(f.service.data.tournaments[one.view.code].players.length, 1);
});

test('one chat follows the tournament from waiting lobby into spectating without changing combat revisions', async t => {
  const f = await fixture(t), { owner, view: waiting } = await f.waiting('Host');
  const first = await f.post(waiting, owner, 'waiting-chat', 'Anyone ready?');
  let view = waiting;
  for (let index = 1; index < 8; index += 1) {
    const guest = await f.guest();
    view = await f.request('POST', '/api/tournaments/join', guest.token, { code: view.code, character: character(`Entrant ${index}`) });
  }
  const revision = view.revision, matchId = view.duelId;
  await f.tick(2000);
  const active = await f.post(view, owner, 'spectating-chat', 'Enjoy the match');
  assert.equal(active.tournamentId, first.tournamentId); assert.equal(active.you, first.you);
  assert.deepEqual(active.messages.map(message => message.text), ['Anyone ready?', 'Enjoy the match']);
  const tournament = f.service.data.tournaments[view.code];
  assert.equal(tournament.revision, revision); assert.equal(tournament.match.duelId, matchId);
  assert.ok(!Object.hasOwn(tournament, 'chat')); assert.ok(!Object.hasOwn(f.service.data, 'chat'));
});

test('chat preserves private loadouts, pending choices, exact battle state, and observer authority', async t => {
  const f = await fixture(t), { entrants, view: start } = await f.lobby(), outsider = await f.guest();
  const [a, b] = start.match.slots;
  const gear = { weapon: 'greatsword', armor: 'heavy', helmet: 'greathelm' };
  await f.request('POST', `/api/tournaments/${start.code}/loadout`, entrants[a].token, command(start, 'private-gear', { loadout: gear }));
  const equipment = structuredClone(f.service.data.tournaments[start.code]);
  const chat = await f.post(start, outsider, 'watching', 'What a match!');
  assert.deepEqual(f.service.data.tournaments[start.code], equipment);
  for (const hidden of Object.values(gear)) assert.ok(!JSON.stringify(chat).includes(hidden));
  await f.request('POST', `/api/tournaments/${start.code}/loadout`, entrants[b].token, command(start, 'other-gear', { loadout: { weapon: 'sword', armor: 'medium', helmet: 'none' } }));
  await f.tick(8000);
  let view = await f.request('GET', `/api/tournaments/${start.code}`, entrants[a].token);
  view = await f.request('POST', `/api/tournaments/${start.code}/action`, entrants[a].token, command(view, 'hidden-technique', { round: 1, action: 'technique' }));
  const before = structuredClone(f.service.data.tournaments[start.code]);
  const after = await f.post(start, outsider, 'pending-chat', 'Still watching');
  assert.deepEqual(f.service.data.tournaments[start.code], before);
  assert.ok(!JSON.stringify(after).includes('technique')); assert.ok(!Object.hasOwn(after, 'match'));
  const publicView = await f.request('GET', `/api/arena/tournaments/${start.code}`, outsider.token);
  assert.equal(publicView.you, null); assert.equal(publicView.match.you, null); assert.equal(publicView.match.yourLoadout, null);
  for (const [kind, payload] of Object.entries({ action: { round: 1, action: 'strike' }, mercy: { decision: 'execute' }, vote: { decision: 'execute' }, loadout: { loadout: gear }, leave: {} })) {
    await assert.rejects(f.request('POST', `/api/tournaments/${start.code}/${kind}`, outsider.token, command(view, `outside-${kind}`, payload)), error(403, 'forbidden'));
  }
  assert.deepEqual(f.service.data.tournaments[start.code], before);
});

test('accepted command retries remain idempotent before rate limits and conflicts reject altered messages', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  const first = await f.post(view, owner, 'send-once', 'One message');
  const retry = await f.post(view, owner, 'send-once', 'One message');
  assert.deepEqual(retry, first); assert.equal(retry.messages.length, 1);
  await assert.rejects(f.post(view, owner, 'send-once', 'Altered message'), error(409, 'command_conflict'));
  await assert.rejects(f.post(view, owner, 'new-command', 'Too soon'), error(429, 'rate_limited'));
  assert.deepEqual(await f.read(view), { ...first, canSend: false, you: null });
});

test('rate limits apply globally to the same guest across arenas and rejected sends do not consume a command', async t => {
  const f = await fixture(t), one = await f.waiting('One'), two = await f.waiting('Two'), guest = await f.guest();
  await f.post(one.view, guest, 'first', 'First arena');
  await assert.rejects(f.post(two.view, guest, 'retryable', 'Second arena'), error(429, 'rate_limited'));
  await f.tick(1999);
  await assert.rejects(f.post(two.view, guest, 'retryable', 'Second arena'), error(429, 'rate_limited'));
  await f.tick(1);
  assert.equal((await f.post(two.view, guest, 'retryable', 'Second arena')).messages.length, 1);
  for (let count = 2; count < 10; count += 1) {
    await f.tick(2000); await f.post(one.view, guest, `minute-${count}`, `Message ${count}`);
  }
  await f.tick(2000);
  await assert.rejects(f.post(two.view, guest, 'eleventh', 'Over ten'), error(429, 'rate_limited'));
  await f.tick(40000);
  assert.equal((await f.post(two.view, guest, 'eleventh', 'Over ten')).messages.at(-1).text, 'Over ten');
});

test('chat normalization counts Unicode code points, preserves plain XSS text, and rejects unsafe controls or fields', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  const raw = '  Cafe\u0301\n\t<img src=x onerror=alert(1)>  ';
  const result = await f.post(view, owner, 'normalize', raw);
  assert.equal(result.messages[0].text, 'Café <img src=x onerror=alert(1)>');
  await f.tick(2000);
  assert.equal(Array.from((await f.post(view, owner, 'emoji', '😀'.repeat(240))).messages.at(-1).text).length, 240);
  for (const [id, text] of [['long', '😀'.repeat(241)], ['blank', ' \r\n '], ['control', 'No\u0000'], ['bidi', 'No\u202e'], ['surrogate', '\ud800'], ['number', 12]]) {
    await assert.rejects(f.post(view, owner, id, text), error(400));
  }
  for (const body of [{ commandId: 'bad-fields', text: 'Hello', name: 'Pretend fighter' }, { text: 'Hello' }, { commandId: 'x' }, [], { commandId: '$wrong', text: 'Hello' }, { commandId: 'x'.repeat(81), text: 'Hello' }]) {
    await assert.rejects(f.request('POST', chatPath(view), owner.token, body), error(400));
  }
  assert.equal((await f.read(view)).messages.length, 2);
});

test('left members speak as ordinary spectators while historical messages retain their original name', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting('Cassian');
  await f.post(view, owner, 'before-leave', 'Going to spectate');
  await f.request('POST', `/api/tournaments/${view.code}/leave`, owner.token, command(view, 'leave-lobby'));
  await f.tick(2000);
  const result = await f.post(view, owner, 'after-leave', 'Now watching');
  assert.deepEqual(result.messages.map(message => [message.name, message.role]), [['Cassian', 'fighter'], ['Spectator 1', 'spectator']]);
  assert.equal(result.messages[0].authorId, result.messages[1].authorId);
  assert.equal((await f.request('GET', '/api/session', owner.token)).activeTournament, null);
});

test('chat is absent from save-store writes and disappears on a service restart even with persistent fighters', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  await f.post(view, owner, 'ephemeral', 'Private-in-memory-content');
  await f.tick(15000); await f.request('GET', '/api/session', owner.token);
  const saved = await f.store.read(), serialized = JSON.stringify(saved);
  assert.ok(!serialized.includes('Private-in-memory-content')); assert.ok(!serialized.includes('authors')); assert.ok(!serialized.includes('chat'));
  const fighter = saved.sessions[Object.keys(saved.sessions)[0]].profile.character;
  await f.restart();
  assert.deepEqual((await f.read(view, owner)).messages, []); assert.equal((await f.read(view, owner)).you, null);
  assert.deepEqual((await f.request('GET', '/api/session', owner.token)).character, fighter);
});

test('failed guest persistence rolls back the chat message, alias and rate limit before a retry', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  await f.tick(15000); f.fail(true);
  await assert.rejects(f.post(view, owner, 'after-failure', 'Try again'), /Synthetic persistence failure/);
  assert.equal(f.service.arenaChat.rooms.size, 0); assert.equal(f.service.arenaChat.rates.size, 0);
  f.fail(false);
  const accepted = await f.post(view, owner, 'after-failure', 'Try again');
  assert.equal(accepted.messages.length, 1);
});

test('message, alias, command and rate state expires after one hour and removed tournaments discard chat immediately', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  await f.post(view, owner, 'old', 'Old conversation');
  await f.tick(CHAT_LIMITS.ttlMs - 1);
  assert.equal((await f.read(view)).messages.length, 1);
  await f.tick(1);
  assert.deepEqual((await f.read(view)).messages, []); assert.equal(f.service.arenaChat.rooms.size, 0); assert.equal(f.service.arenaChat.rates.size, 0);
  await f.post(view, owner, 'old', 'A new conversation');
  await f.service.serialize(() => { delete f.service.data.tournaments[view.code]; f.service.changed = true; });
  await f.tick(); assert.equal(f.service.arenaChat.rooms.size, 0);
  await assert.rejects(f.read(view), error(404, 'room_not_found'));
});

test('temporary expiry removes abandoned lobby chat without reviving an expired bearer', async t => {
  const f = await fixture(t, { temporarySessions: true, disconnectMs: 90000 }), { owner, view } = await f.waiting();
  await f.post(view, owner, 'last-message', 'Until next time');
  await f.tick(90000);
  assert.equal(Object.keys(f.service.data.tournaments).length, 0); assert.equal(f.service.arenaChat.rooms.size, 0);
  await assert.rejects(f.post(view, owner, 'late', 'Gone'), error(401, 'unauthorized'));
  assert.equal(Object.keys(f.service.data.sessions).length, 0);
});

test('room codes reused for a different tournament never inherit the earlier conversation', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  const first = await f.post(view, owner, 'old-room', 'Earlier tournament');
  await f.service.serialize(() => { f.service.data.tournaments[view.code].tournamentId = 'replacement-tournament'; f.service.changed = true; });
  const fresh = await f.read(view, owner);
  assert.notEqual(fresh.tournamentId, first.tournamentId); assert.deepEqual(fresh.messages, []); assert.equal(fresh.you, null);
});

test('concurrent duplicate sends serialize to exactly one message', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting();
  const results = await Promise.all(Array.from({ length: 20 }, () => f.post(view, owner, 'same-command', 'One accepted send')));
  assert.ok(results.every(result => result.messages.length === 1));
  assert.equal(new Set(results.map(result => result.messages[0].id)).size, 1);
  assert.equal(f.service.arenaChat.rates.get(owner.playerId).length, 1);
});

test('a finite recent-message window retains sixty messages and bounds dedupe receipts', () => {
  const chat = new ArenaChat(), tournament = { code: 'ABC234', tournamentId: 'one', playerIds: [], players: [], left: [] };
  let now = 1000000, last;
  for (let index = 0; index < CHAT_LIMITS.maxCommands + 12; index += 1) {
    chat.cleanup({ ABC234: tournament }, now);
    const session = { playerId: `sender-${index % 100}` };
    chat.beginTransaction(); last = chat.post(tournament, session, { commandId: `send-${index}`, text: `Message ${index}` }, now); chat.commitTransaction();
    now += 2000;
  }
  assert.equal(last.messages.length, 60); assert.equal(last.messages[0].text, `Message ${CHAT_LIMITS.maxCommands + 12 - 60}`);
  const room = chat.rooms.get('one'); assert.equal(room.commands.size, CHAT_LIMITS.maxCommands); assert.equal(room.authors.size, 100);
});

test('room and author caps fail safely without evicting an active conversation', () => {
  const chat = new ArenaChat(), makeRoom = index => ({ code: `ROOM${index}`, tournamentId: `room-${index}`, playerIds: [], players: [], left: [] });
  for (let index = 0; index < CHAT_LIMITS.maxRooms; index += 1) {
    chat.beginTransaction(); chat.post(makeRoom(index), { playerId: `owner-${index}` }, { commandId: 'hello', text: 'Hello' }, 1000000); chat.commitTransaction();
  }
  assert.throws(() => chat.post(makeRoom(CHAT_LIMITS.maxRooms), { playerId: 'extra' }, { commandId: 'hello', text: 'Hello' }, 1000000), error(503, 'chat_full'));
  assert.equal(chat.rooms.size, CHAT_LIMITS.maxRooms);
  const other = new ArenaChat(), room = makeRoom(0);
  for (let index = 0; index < CHAT_LIMITS.maxAuthors; index += 1) {
    other.beginTransaction(); other.post(room, { playerId: `author-${index}` }, { commandId: 'hello', text: 'Hello' }, 1000000); other.commitTransaction();
  }
  assert.throws(() => other.post(room, { playerId: 'extra' }, { commandId: 'hello', text: 'Hello' }, 1000000), error(503, 'chat_full'));
  assert.equal(other.rooms.get(room.tournamentId).authors.size, CHAT_LIMITS.maxAuthors);
  assert.equal(other.view(room, { playerId: 'author-0' }).canSend, true);
});
