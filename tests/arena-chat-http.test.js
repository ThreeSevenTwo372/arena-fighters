import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer } from '../server.mjs';
import { MemoryStore } from '../online/store.mjs';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced' });
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
async function fixture(t) {
  let now = 1000000;
  // Explicit process-only storage prevents access to any local saved fighters.
  const server = createAppServer({ temporarySessions: true, store: new MemoryStore(), clock: () => now, tickMs: 100000 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await server.duels.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (method, path, token, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, value: await response.json() };
  };
  return { server, request,
    async tick(delta) { now += delta; await server.duels.tick(); },
    async guest() { const created = await request('POST', '/api/session', null, {}); assert.equal(created.status, 200); return created.value; },
    async waiting() {
      const owner = await this.guest();
      const created = await request('POST', '/api/tournaments', owner.token, { character: character('Cassian') });
      assert.equal(created.status, 200); return { owner, view: created.value };
    },
  };
}

test('real HTTP chat preserves public browsing, authenticated server identity, literal text, origin checks and exact retry semantics', async t => {
  const f = await fixture(t), { owner, view } = await f.waiting(), path = `/api/arena/tournaments/${view.code}/chat`;
  const before = structuredClone(f.server.duels.data);
  const anonymous = await f.request('GET', path);
  assert.equal(anonymous.status, 200); assert.equal(anonymous.value.available, true); assert.equal(anonymous.value.canSend, false);
  assert.equal(anonymous.value.you, null); assert.deepEqual(anonymous.value.messages, []);
  assert.deepEqual(f.server.duels.data, before, 'Reading chat creates no guest, fighter, roster seat or alias.');
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  assert.match(anonymous.headers.get('content-type'), /^application\/json/);
  assert.equal(anonymous.headers.get('x-content-type-options'), 'nosniff');
  const payload = { commandId: 'http-message-1', text: '<img src=x onerror=alert(1)> Hello arena!' };
  assert.equal((await f.request('POST', path, null, payload)).status, 401);
  assert.equal((await f.request('POST', path, owner.token, payload, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await f.request('POST', path, owner.token, { ...payload, name: 'Forged emperor' })).status, 400);
  const accepted = await f.request('POST', path, owner.token, payload);
  assert.equal(accepted.status, 200); assert.equal(accepted.value.messages.length, 1);
  const message = accepted.value.messages[0];
  assert.equal(message.name, 'Cassian'); assert.equal(message.role, 'fighter'); assert.equal(message.text, payload.text);
  assert.equal(accepted.value.you, message.authorId); assert.notEqual(message.authorId, owner.playerId);
  assert.ok(!JSON.stringify(accepted.value).includes(owner.token)); assert.ok(!JSON.stringify(accepted.value).includes(owner.playerId));
  assert.deepEqual((await f.request('POST', path, owner.token, payload)).value, accepted.value);
  const conflict = await f.request('POST', path, owner.token, { ...payload, text: 'Different message' });
  assert.equal(conflict.status, 409); assert.equal(conflict.value.code, 'command_conflict');
  const next = { commandId: 'http-message-2', text: 'Two seconds later' };
  const limited = await f.request('POST', path, owner.token, next);
  assert.equal(limited.status, 429); assert.equal(limited.value.code, 'rate_limited');
  await f.tick(2000);
  assert.equal((await f.request('POST', path, owner.token, next)).value.messages.length, 2);
  assert.equal((await f.request('GET', path)).value.messages[0].text, payload.text);
  assert.equal(f.server.duels.data.tournaments[view.code].revision, view.revision);
  assert.equal((await f.request('GET', '/online/arena-chat.mjs')).status, 404);
});

test('a real HTTP spectator may chat through a guest session without acquiring a fighter seat or private gameplay authority', async t => {
  const f = await fixture(t), entrants = [];
  let view;
  for (let index = 0; index < 8; index += 1) {
    const guest = await f.guest(); entrants.push(guest);
    const entry = await f.request('POST', '/api/tournaments/enter', guest.token, { character: character(`Entrant ${index + 1}`) });
    assert.equal(entry.status, 200); view = entry.value;
  }
  const gear = { weapon: 'greatsword', armor: 'heavy', helmet: 'greathelm' };
  assert.equal((await f.request('POST', `/api/tournaments/${view.code}/loadout`, entrants[view.match.slots[0]].token,
    command(view, 'http-private-gear', { loadout: gear }))).status, 200);
  const outsider = await f.guest(), before = structuredClone(f.server.duels.data.tournaments[view.code]);
  const sent = await f.request('POST', `/api/arena/tournaments/${view.code}/chat`, outsider.token,
    { commandId: 'http-observer', text: 'Cheering from the stands!' });
  assert.equal(sent.status, 200); assert.equal(sent.value.messages[0].name, 'Spectator 1'); assert.equal(sent.value.messages[0].role, 'spectator');
  assert.deepEqual(f.server.duels.data.tournaments[view.code], before);
  for (const hidden of Object.values(gear)) assert.ok(!JSON.stringify(sent.value).includes(hidden));
  const guest = (await f.request('GET', '/api/session', outsider.token)).value;
  assert.equal(guest.character, null); assert.equal(guest.activeTournament, null); assert.equal(guest.activeRoom, null);
  const publicView = (await f.request('GET', `/api/arena/tournaments/${view.code}`, outsider.token)).value;
  assert.equal(publicView.you, null); assert.equal(publicView.match.you, null); assert.equal(publicView.match.yourLoadout, null);
  assert.equal(publicView.match.duel, null); assert.equal(publicView.match.canRematch, false);
  for (const [kind, payload] of Object.entries({ action: { round: 1, action: 'strike' }, mercy: { decision: 'execute' },
    vote: { decision: 'execute' }, loadout: { loadout: gear }, leave: {} })) {
    const denied = await f.request('POST', `/api/tournaments/${view.code}/${kind}`, outsider.token, command(view, `http-outside-${kind}`, payload));
    assert.equal(denied.status, 403); assert.equal(denied.value.code, 'forbidden');
  }
  assert.deepEqual(f.server.duels.data.tournaments[view.code], before);
  assert.equal(Object.keys(f.server.duels.data.sessions).length, 9); assert.equal(before.players.length, 8);
});
