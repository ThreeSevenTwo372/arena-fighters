import test from 'node:test';
import assert from 'node:assert/strict';
import { TournamentClient } from '../src/tournament-client.js';

const fighter = { name: 'Aster' };
const makeClient = ({ duelMode = false, responder = () => ({}) } = {}) => {
  const requests = [];
  const client = new TournamentClient({ duelMode,
    storage: { getItem: () => 'qa-token' },
    fetcher: async (path, options) => {
      const request = { path, method: options.method, body: options.body === undefined ? null : JSON.parse(options.body), authorization: options.headers.Authorization };
      requests.push(request);
      return { ok: true, json: async () => responder(request) };
    },
  });
  return { client, requests };
};

test('ordinary entry and friend joining retain the tournament endpoints and existing guest token', async () => {
  const { client, requests } = makeClient();
  await client.create(fighter);
  await client.join(' abc234 ', fighter);
  assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => [request.path, request.body]), [
    ['/api/tournaments/enter', { character: fighter }],
    ['/api/tournaments/join', { code: 'ABC234', character: fighter }],
  ]);
  assert.ok(requests.every(request => request.authorization === 'Bearer qa-token'));
  assert.equal(client.legacyRoom, false);
});

test('diagnostic duel entry, friend joining, reading and commands use the retained room endpoints', async () => {
  const { client, requests } = makeClient({ duelMode: true });
  await client.create(fighter);
  await client.join(' abc234 ', fighter);
  await client.room('ABC234');
  await client.command({ code: 'ABC234', duelId: 'duel-1' }, 'action', { round: 2, action: 'guard' });
  assert.deepEqual(requests.filter(request => request.method === 'POST').map(request => request.path), [
    '/api/rooms', '/api/rooms/join', '/api/rooms/ABC234/action',
  ]);
  assert.equal(requests.find(request => request.path === '/api/rooms/join').body.code, 'ABC234');
  assert.ok(requests.some(request => request.path === '/api/rooms/ABC234' && request.method === 'GET'));
  const command = requests.at(-1).body;
  assert.equal(command.duelId, 'duel-1');
  assert.equal(command.round, 2);
  assert.equal(command.action, 'guard');
  assert.equal(typeof command.commandId, 'string');
});

test('a diagnostic route can resume a saved tournament, then return new entry to the diagnostic room mode', async () => {
  const { client, requests } = makeClient({ duelMode: true });
  client.legacyRoom = false; // App recovery derives this from activeTournament.
  await client.room('ABC234');
  await client.command({ type: 'tournament', code: 'ABC234', duelId: 'match-1' }, 'leave');
  await client.create(fighter);
  assert.equal(requests[0].path, '/api/tournaments/ABC234');
  assert.equal(requests[1].path, '/api/tournaments/ABC234/leave');
  assert.equal(requests.at(-1).path, '/api/rooms');
});

test('ordinary route retains a recovered legacy room, while explicit tournament views retain tournament authority', async () => {
  const { client, requests } = makeClient();
  client.legacyRoom = true; // App recovery derives this from activeRoom.
  await client.room('ABC234');
  await client.command({ code: 'ABC234', duelId: 'duel-1' }, 'loadout', { loadout: { weapon: 'sword' } });
  await client.command({ type: 'tournament', code: 'SKY234', duelId: 'match-1' }, 'leave');
  assert.deepEqual(requests.map(request => request.path), ['/api/rooms/ABC234', '/api/rooms/ABC234/loadout', '/api/tournaments/SKY234/leave']);
});

test('diagnostic room entry recovers a lost acknowledgement through activeRoom without a second entry', async () => {
  let entered = false;
  const { client, requests } = makeClient({ duelMode: true, responder: ({ path }) => {
    if (path === '/api/rooms') { entered = true; throw new TypeError('Lost response'); }
    if (path === '/api/session') return { activeRoom: entered ? 'ABC234' : null, activeTournament: null };
    return { code: 'ABC234', duelId: 'duel-1' };
  } });
  const result = await client.create(fighter);
  assert.equal(result.code, 'ABC234');
  assert.equal(requests.filter(request => request.path === '/api/rooms').length, 1);
  assert.equal(requests.at(-1).path, '/api/rooms/ABC234');
});
