import test from 'node:test';
import assert from 'node:assert/strict';
import { DuelService } from '../online/service.mjs';
import { getActionOptions, getFighterStatus } from '../src/combat.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', appearance: { sex: 'male', facePreset: 'p05' } });
const command = (view, commandId, payload) => ({ commandId, duelId: view.duelId, ...payload });
const matchOf = view => view.type === 'tournament' ? view.match : view;
async function fixture(t, tournament) {
  let now = 1000000, saved = { schema: 1, sessions: {}, rooms: {} }, service;
  const config = { winnerMs: 0, disconnectMs: 10000000, clock: () => now,
    store: { async read() { return structuredClone(saved); }, async write(value) { saved = structuredClone(value); } } };
  service = new DuelService(config); t.after(() => service.close());
  const request = (method, path, token, body) => service.request({ method, path, token, body }), base = `/api/${tournament ? 'tournaments' : 'rooms'}`;
  const guests = []; let initial;
  for (let index = 0; index < (tournament ? 8 : 2); index++) {
    const guest = await request('POST', '/api/session', null, {}); guests.push(guest);
    initial = await request('POST', index ? `${base}/join` : base, guest.token, { ...(index ? { code: initial.code } : {}), character: character(`Fighter ${index}`) });
  }
  const tokens = (tournament ? initial.match.slots : [0, 1]).map(index => guests[index].token);
  return { initial, tokens, base, request,
    read(index = 0) { return request('GET', `${base}/${initial.code}`, tokens[index]); },
    post(index, kind, payload, id, source = initial) { return request('POST', `${base}/${initial.code}/${kind}`, tokens[index], command(source, id, payload)); },
    async tickTo(at) { now = Math.max(now, at); await service.tick(); },
    async restart() { await service.close(); service = new DuelService(config); await service.initialized; },
  };
}
for (const tournament of [false, true]) test(`${tournament ? 'tournament' : 'quick duel'} Entangle is private before reveal, persists and resolves taxed costs exactly once`, async t => {
  const f = await fixture(t, tournament), netGear = { weapon: 'trident', armor: 'medium', helmet: 'none' };
  await f.post(0, 'loadout', { loadout: netGear }, 'net-gear');
  const privateView = matchOf(await f.read(1)); assert.equal(privateView.duel, null); assert.equal(JSON.stringify(privateView).includes('"weapon":"trident"'), false);
  let view = await f.post(1, 'loadout', { loadout: { ...netGear, weapon: 'sword' } }, 'sword-gear');
  if (tournament) { await f.tickTo(matchOf(view).deadline); view = await f.read(); }
  const before = matchOf(view).duel, preview = getActionOptions(before, 0);
  await f.post(1, 'action', { round: 1, action: 'strike' }, 'rival-strike', view);
  const pending = matchOf(await f.read()); assert.deepEqual(pending.duel, before); assert.deepEqual(getActionOptions(pending.duel, 0), preview);
  assert.equal(Object.hasOwn(pending, 'actions'), false);
  view = await f.post(0, 'action', { round: 1, action: 'technique' }, 'cast-net', view);
  const resolved = matchOf(view), netted = resolved.duel;
  assert.equal(getFighterStatus(netted, 1).attackSurcharge, 3); assert.equal(netted.lastRound.events.filter(event => event.type === 'entangle').length, 1);
  await f.post(0, 'action', { round: 1, action: 'technique' }, 'cast-net', view);
  assert.deepEqual(matchOf(await f.read()).duel, netted, 'A retry cannot apply or charge the net twice.');
  await f.restart(); view = await f.read(); assert.deepEqual(matchOf(view).duel, netted, 'Restart retains the public effect and its one-round lifetime.');
  const taxed = getActionOptions(netted, 1).find(option => option.id === 'strike');
  assert.equal(taxed.cost, netted.fighters[1].strikeCost + 3);
  await f.tickTo(matchOf(view).actionOpensAt ?? 1000000);
  view = await f.read(); await f.post(0, 'action', { round: 2, action: 'focus' }, 'netter-focus', view);
  await assert.rejects(f.post(1, 'action', { round: 2, action: 'strike', damage: 999, cost: 0 }, 'forged-strike', view), error => error.status === 400 && error.code === 'invalid_request');
  assert.deepEqual(matchOf(await f.read()).duel, netted, 'Forged damage/cost fields cannot change the authoritative effect.');
  view = await f.post(1, 'action', { round: 2, action: 'strike' }, 'taxed-strike', view);
  const after = matchOf(view).duel;
  assert.equal(after.fighters[1].stamina, Math.min(netted.fighters[1].maxStamina, netted.fighters[1].stamina - taxed.cost + netted.fighters[1].staminaRegen), 'The service charges the authoritative preview cost, then regenerates once at round end.');
  assert.equal(after.fighters[1].entangle, undefined); assert.equal(getFighterStatus(after, 1), null);
  await f.post(1, 'action', { round: 2, action: 'strike' }, 'taxed-strike', view);
  assert.deepEqual(matchOf(await f.read()).duel, after);
});
