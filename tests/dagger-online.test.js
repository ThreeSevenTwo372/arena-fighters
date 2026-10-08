import test from 'node:test';
import assert from 'node:assert/strict';
import { DuelService } from '../online/service.mjs';
import { getActionOptions, WEAPONS } from '../src/combat.js';

const character = name => ({ name, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 },
  trait: 'balanced', color: '#b87333', appearance: { sex: 'male', facePreset: 'p05', skin: 'ivory', hairColor: 'chestnut' } });
const daggerGear = { weapon: 'dagger', armor: 'medium', helmet: 'greathelm' };
const rivalGear = weapon => ({ weapon, armor: 'medium', helmet: 'none' });
const command = (view, commandId, payload = {}) => ({ commandId, duelId: view.duelId, ...payload });
const apiError = (status, code) => error => error.status === status && (!code || error.code === code);
const matchOf = view => view.type === 'tournament' ? view.match : view;

async function fixture(t) {
  let now = 1000000, saved = { schema: 1, sessions: {}, rooms: {} }, service;
  const configuration = { winnerMs: 0, disconnectMs: 10000000, clock: () => now,
    store: { async read() { return structuredClone(saved); }, async write(value) { saved = structuredClone(value); } } };
  service = new DuelService(configuration);
  const request = (method, path, token, body) => service.request({ method, path, token, body });
  const f = {
    request, get service() { return service; },
    async guest() { return request('POST', '/api/session', null, {}); },
    async tick(delta) { now += delta; await service.tick(); },
    async restart() { await service.close(); service = new DuelService(configuration); await service.initialized; },
    async arena(mode) {
      const tournament = mode === 'tournament', base = `/api/${tournament ? 'tournaments' : 'rooms'}`;
      const guests = [], names = ['Cassian', 'Mira', 'Titus', 'Aster', 'Livia', 'Rufus', 'Flavia', 'Marius'];
      let view;
      for (let index = 0; index < (tournament ? 8 : 2); index++) {
        const guest = await this.guest(); guests.push(guest);
        view = await request('POST', index ? `${base}/join` : base, guest.token,
          { ...(index ? { code: view.code } : {}), character: character(names[index]) });
      }
      const slots = tournament ? [...view.match.slots] : [0, 1];
      const tokens = slots.map(slot => guests[slot].token), outsider = await this.guest();
      return { mode, base, code: view.code, view, guests, slots, tokens, outsider,
        read(index = 0) { return request('GET', `${base}/${this.code}`, tokens[index]); },
        post(index, kind, payload, id, source = this.view) {
          return request('POST', `${base}/${this.code}/${kind}`, tokens[index], command(source, id, payload));
        },
        publicView() { return request('GET', `/api/arena/tournaments/${this.code}`, outsider.token); },
      };
    },
    async battle(arena, weapon = 'sword') {
      await arena.post(0, 'loadout', { loadout: daggerGear }, 'dagger-loadout');
      arena.view = await arena.post(1, 'loadout', { loadout: rivalGear(weapon) }, 'rival-loadout');
      if (arena.mode === 'tournament') { await this.tick(8000); arena.view = await arena.read(); }
      assert.equal(matchOf(arena.view).phase, 'battle');
      return arena.view;
    },
  };
  t.after(() => service.close());
  return f;
}

for (const mode of ['room', 'tournament']) {
  test(`${mode}: dagger equipment remains private until both loadouts reveal`, async t => {
    const f = await fixture(t), arena = await f.arena(mode);
    const committed = await arena.post(0, 'loadout', { loadout: daggerGear }, 'private-dagger');
    assert.deepEqual(matchOf(committed).yourLoadout, daggerGear);
    const rival = await arena.read(1), match = matchOf(rival);
    assert.equal(match.duel, null); assert.equal(match.yourLoadout, null);
    assert.deepEqual(match.ready, [true, false]);
    assert.equal(JSON.stringify(rival).includes('"weapon":"dagger"'), false);
    assert.equal(JSON.stringify(rival).includes('greathelm'), false);
    if (mode === 'tournament') {
      const observer = await arena.publicView();
      assert.equal(observer.match.duel, null); assert.equal(observer.match.yourLoadout, null);
      assert.equal(JSON.stringify(observer).includes('"weapon":"dagger"'), false);
      assert.equal(Object.hasOwn(observer.match, 'loadouts'), false);
    }
    const revealed = await arena.post(1, 'loadout', { loadout: rivalGear('sword') }, 'rival-reveals');
    assert.equal(matchOf(revealed).duel.fighters[0].weapon, 'dagger');
    assert.equal(matchOf(revealed).duel.fighters[0].helmet, 'greathelm');
  });

  test(`${mode}: Riposte stays selectable without revealing a committed rival Strike; only the resolved round parries and counters`, async t => {
    const f = await fixture(t), arena = await f.arena(mode), initial = await f.battle(arena);
    const before = matchOf(initial).duel;
    const options = getActionOptions(before, 0), riposte = options.find(option => option.id === 'technique');
    assert.equal(riposte.name, 'Riposte'); assert.equal(riposte.conditional, 'riposte');
    assert.equal(riposte.enabled, true); assert.equal(riposte.priority, 2); assert.equal(riposte.cost, 5);
    const incoming = getActionOptions(before, 1).find(option => option.id === 'strike');
    const enemyCommand = command(initial, 'hidden-strike', { round: before.round, action: 'strike' });
    await f.request('POST', `${arena.base}/${arena.code}/action`, arena.tokens[1], enemyCommand);
    const pending = await arena.read();
    assert.deepEqual(matchOf(pending).duel, before);
    assert.deepEqual(matchOf(pending).pending, [false, true]);
    assert.equal(Object.hasOwn(matchOf(pending), 'actions'), false);
    assert.deepEqual(getActionOptions(matchOf(pending).duel, 0), options);
    if (mode === 'tournament') {
      const publicPending = await arena.publicView();
      assert.deepEqual(publicPending.match.duel, before);
      assert.equal(Object.hasOwn(publicPending.match, 'actions'), false);
      assert.equal(publicPending.match.you, null);
    }
    const revealed = await arena.post(0, 'action', { round: before.round, action: 'technique' }, 'predict-strike', initial);
    const after = matchOf(revealed).duel;
    assert.deepEqual(after.lastRound.actions, ['technique', 'strike']);
    const stance = after.lastRound.events.find(event => event.type === 'riposte' && event.actor === 0);
    const attack = after.lastRound.events.find(event => event.type === 'attack' && event.actor === 1);
    const counter = after.lastRound.events.find(event => event.type === 'attack' && event.actor === 0 && event.counter === true);
    assert.ok(stance); assert.ok(counter); assert.equal(attack.parried, true);
    assert.equal(attack.damage, Math.max(1, Math.floor(incoming.damage * 0.5)));
    assert.equal(counter.damage, riposte.damage);
    assert.equal(after.fighters[0].hp, before.fighters[0].hp - attack.damage);
    assert.equal(after.fighters[1].hp, before.fighters[1].hp - counter.damage);
    assert.equal(after.fighters[0].stamina, before.fighters[0].stamina - riposte.cost);
    assert.equal(after.fighters[1].stamina, before.fighters[1].stamina - incoming.cost);
    assert.equal(after.lastRound.events.filter(event => event.counter === true).length, 1);
  });

  test(`${mode}: every existing Weapon Technique defeats the Strike-only prediction without leaking its pending choice`, async t => {
    for (const weapon of ['sword', 'spear', 'axe', 'flail', 'halberd', 'mace', 'greatsword']) {
      assert.ok(Object.hasOwn(WEAPONS, weapon));
      const f = await fixture(t), arena = await f.arena(mode), initial = await f.battle(arena, weapon);
      const before = matchOf(initial).duel, options = getActionOptions(before, 0);
      const riposte = options.find(option => option.id === 'technique');
      const technique = getActionOptions(before, 1).find(option => option.id === 'technique');
      await arena.post(1, 'action', { round: before.round, action: 'technique' }, 'hidden-rival-technique', initial);
      const pending = await arena.read();
      assert.deepEqual(matchOf(pending).duel, before);
      assert.deepEqual(getActionOptions(matchOf(pending).duel, 0), options);
      const result = await arena.post(0, 'action', { round: before.round, action: 'technique' }, 'wrong-prediction', initial);
      const after = matchOf(result).duel;
      const incoming = after.lastRound.events.find(event => event.type === 'attack' && event.actor === 1);
      assert.equal(incoming.damage, technique.damage, weapon);
      assert.equal(Boolean(incoming.parried), false, weapon);
      assert.equal(after.lastRound.events.some(event => event.counter === true), false, weapon);
      assert.equal(after.lastRound.events.some(event => event.type === 'attack' && event.actor === 0), false, weapon);
      assert.equal(after.fighters[0].stamina, before.fighters[0].stamina - riposte.cost, weapon);
      assert.equal(after.fighters[1].hp, before.fighters[1].hp, weapon);
    }
  });

  test(`${mode}: exact Riposte retries and a restart cannot repeat stamina spending, damage, or the counter`, async t => {
    const f = await fixture(t), arena = await f.arena(mode), initial = await f.battle(arena);
    const before = matchOf(initial).duel;
    const locked = command(initial, 'retry-riposte', { round: before.round, action: 'technique' });
    const path = `${arena.base}/${arena.code}/action`;
    await f.request('POST', path, arena.tokens[0], locked);
    await f.request('POST', path, arena.tokens[0], locked);
    await f.restart();
    assert.deepEqual(matchOf(await arena.read(1)).duel, before);
    assert.deepEqual(matchOf(await arena.read(1)).pending, [true, false]);
    const resolved = await arena.post(1, 'action', { round: before.round, action: 'strike' }, 'resolve-counter-once', initial);
    const after = structuredClone(matchOf(resolved).duel);
    const repeats = await Promise.all([f.request('POST', path, arena.tokens[0], locked), f.request('POST', path, arena.tokens[0], locked)]);
    for (const view of repeats) assert.deepEqual(matchOf(view).duel, after);
    await assert.rejects(f.request('POST', path, arena.tokens[0], { ...locked, action: 'strike' }), apiError(409, 'command_conflict'));
    await assert.rejects(f.request('POST', path, arena.tokens[0], { ...locked, commandId: 'old-round' }), apiError(409, 'stale_round'));
    assert.deepEqual(matchOf(await arena.read()).duel, after);
    assert.equal(after.lastRound.events.filter(event => event.counter === true).length, 1);
  });

  test(`${mode}: forged counter results and outsider actions cannot alter the authoritative duel`, async t => {
    const f = await fixture(t), arena = await f.arena(mode), initial = await f.battle(arena);
    const before = structuredClone(matchOf(initial).duel);
    const forged = command(initial, 'forged-counter', { round: before.round, action: 'technique', counter: true, damage: 999 });
    await assert.rejects(f.request('POST', `${arena.base}/${arena.code}/action`, arena.tokens[0], forged), apiError(400));
    await assert.rejects(f.request('POST', `${arena.base}/${arena.code}/action`, arena.tokens[0],
      command(initial, 'unregistered-riposte-id', { round: before.round, action: 'riposte' })), apiError(400));
    await assert.rejects(f.request('POST', `${arena.base}/${arena.code}/action`, arena.outsider.token,
      command(initial, 'observer-counter', { round: before.round, action: 'technique' })), apiError(403, 'forbidden'));
    if (mode === 'tournament') {
      const observer = await arena.publicView();
      assert.equal(observer.you, null); assert.equal(observer.match.you, null); assert.equal(observer.match.yourLoadout, null);
      const watchingSlot = arena.guests.findIndex((_, slot) => !arena.slots.includes(slot));
      await assert.rejects(f.request('POST', `${arena.base}/${arena.code}/action`, arena.guests[watchingSlot].token,
        command(initial, 'roster-spectator-counter', { round: before.round, action: 'technique' })), apiError(403, 'spectator'));
    }
    const latest = matchOf(await arena.read());
    assert.deepEqual(latest.duel, before); assert.deepEqual(latest.pending, [false, false]);
  });
}
