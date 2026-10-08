import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentClient } from '../src/tournament-client.js';

function makeClient({ token = null, responder = () => ({}) } = {}) {
  const requests = [], saved = new Map();
  if (token) saved.set('last-laurel.guest.v1', token);
  const client = new TournamentClient({
    storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
    fetcher: async (path, options) => {
      const request = { path, method: options.method, authorization: options.headers.Authorization, serialized: options.body, body: options.body === undefined ? null : JSON.parse(options.body) };
      requests.push(request);
      const result = await responder(request);
      return { ok: (result?.status ?? 200) < 400, status: result?.status ?? 200, json: async () => result?.data ?? result };
    },
  });
  return { client, requests, saved };
}

test('public chat reading normalizes and safely encodes the code without creating a guest or fighter', async () => {
  const response = { code: 'ABC234', tournamentId: 'tournament-one', messages: [], canSend: true, you: null, maxLength: 240, minIntervalMs: 2000 };
  const { client, requests } = makeClient({ responder: () => response });
  assert.deepEqual(await client.chat(' abc234 '), response);
  assert.deepEqual(requests.map(({ path, method, authorization, body }) => ({ path, method, authorization, body })), [
    { path: '/api/arena/tournaments/ABC234/chat', method: 'GET', authorization: undefined, body: null },
  ]);
  assert.equal(client.token, null);
  await client.chat(' ab/c? ');
  assert.equal(requests.at(-1).path, '/api/arena/tournaments/AB%2FC%3F/chat');
});

test('a fresh anonymous spectator creates only a guest session before sending its exact chat command', async () => {
  const { client, requests } = makeClient({ responder: ({ path, method }) => path === '/api/session'
    ? method === 'POST' ? { token: 'chat-only-guest' } : { activeRoom: null, activeTournament: null, character: null }
    : { messages: [{ id: 'message-one', text: 'Ave, arena!' }] } });
  const result = await client.sendChat(' abc234 ', { commandId: 'send-once', text: 'Ave, arena!' });
  assert.equal(result.messages[0].text, 'Ave, arena!');
  assert.deepEqual(requests.map(({ path, method, body }) => [path, method, body]), [
    ['/api/session', 'POST', {}],
    ['/api/session', 'GET', null],
    ['/api/arena/tournaments/ABC234/chat', 'POST', { commandId: 'send-once', text: 'Ave, arena!' }],
  ]);
  assert.equal(requests.at(-1).authorization, 'Bearer chat-only-guest');
  assert.ok(requests.every(request => request.body?.character === undefined));
  assert.equal(client.legacyRoom, false);
});

test('existing authentication and legacy match context survive spectator chat without entry commands', async () => {
  const { client, requests } = makeClient({ token: 'saved-token' });
  client.legacyRoom = true;
  await client.chat('ABC234');
  await client.sendChat('ABC234', { commandId: 'chat-in-another-lobby', text: 'Good match.' });
  assert.ok(requests.every(request => request.authorization === 'Bearer saved-token'));
  assert.deepEqual(requests.map(({ path, method }) => [path, method]), [
    ['/api/arena/tournaments/ABC234/chat', 'GET'], ['/api/session', 'GET'], ['/api/arena/tournaments/ABC234/chat', 'POST'],
  ]);
  assert.equal(client.legacyRoom, true);
});

test('a lost chat acknowledgement retries the same serialized command and never submits a second identity', async () => {
  let posts = 0;
  const command = { commandId: 'stable-retry-id', text: 'A brave counter! 👏' };
  const { client, requests } = makeClient({ token: 'saved-token', responder: ({ path, method }) => {
    if (path.endsWith('/chat') && method === 'POST' && ++posts === 1) {
      command.text = 'This later mutation must not replace the committed message.';
      throw new TypeError('Acknowledgement lost');
    }
    return { messages: [{ id: 'committed-one', text: 'A brave counter! 👏' }] };
  } });
  await client.sendChat(' abc234 ', command);
  const sends = requests.filter(request => request.path.endsWith('/chat') && request.method === 'POST');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].serialized, sends[1].serialized);
  assert.deepEqual(sends[0].body, { commandId: 'stable-retry-id', text: 'A brave counter! 👏' });
  assert.deepEqual(sends[1].body, sends[0].body);
  assert.equal(requests.filter(request => request.path === '/api/session').length, 1);
});

test('failure to obtain a guest session rejects the send before any chat POST', async () => {
  const { client, requests } = makeClient({ responder: () => ({ status: 503, data: { error: 'Session unavailable.' } }) });
  await assert.rejects(client.sendChat('ABC234', { commandId: 'unused', text: 'Hello.' }), error => error.status === 503 && error.message === 'Session unavailable.');
  assert.deepEqual(requests.map(request => request.path), ['/api/session']);
});

test('chat rejection reports the server error and does not retry a rate-limited command', async () => {
  const { client, requests } = makeClient({ token: 'saved-token', responder: ({ path }) => path.endsWith('/chat')
    ? { status: 429, data: { error: 'Please wait before sending again.' } } : {} });
  await assert.rejects(client.sendChat('ABC234', { commandId: 'too-fast', text: 'Again.' }), error => error.status === 429 && error.message === 'Please wait before sending again.');
  assert.equal(requests.filter(request => request.path.endsWith('/chat')).length, 1);
});

test('a repeated network failure reports interruption after one exact command retry', async () => {
  const { client, requests } = makeClient({ token: 'saved-token', responder: ({ path }) => {
    if (path.endsWith('/chat')) throw new TypeError('Disconnected');
    return {};
  } });
  await assert.rejects(client.sendChat('ABC234', { commandId: 'unknown-outcome', text: 'Hello.' }), /Connection interrupted/);
  const sends = requests.filter(request => request.path.endsWith('/chat'));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].serialized, sends[1].serialized);
});
