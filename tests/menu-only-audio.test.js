import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGameAudio } from '../src/game-audio.js';

const manifest = JSON.parse(readFileSync(new URL('../public/audio/soundtrack-v002/manifest.json', import.meta.url)));
test('active audio loads only the menu theme; battles and victory never request a song or clip', async () => {
  const requests = [], players = [];
  const engine = createGameAudio({ storage: null, createContext: () => null,
    fetcher: async url => { requests.push(url); return { ok: true, json: async () => manifest }; },
    createAudio: () => {
      const player = { src: '', currentTime: 0, plays: [], pauses: 0,
        play() { this.plays.push(this.src); return Promise.resolve(); }, pause() { this.pauses++; }, addEventListener() {} };
      players.push(player); return player;
    },
  });
  engine.setScene({ kind: 'menu' });
  assert.equal(await engine.load(), true);
  await engine.unlock();
  assert.deepEqual(requests, ['/public/audio/soundtrack-v002/manifest.json']);
  assert.equal(players.length, 1);
  assert.deepEqual(players[0].plays, [manifest.menu.src]);
  players[0].currentTime = 37;
  for (const key of ['duel-one', 'duel-two', 'duel-one']) {
    engine.setScene({ kind: 'battle', battleKey: key });
    assert.equal(engine.getState().trackTitle, '');
    assert.equal(engine.getState().rememberedBattleCount, 0);
    engine.playEffect('victory');
  }
  assert.equal(players.length, 1, 'No recorded victory clip player');
  assert.equal(players[0].plays.length, 1);
  engine.setScene({ kind: 'menu' });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(players[0].currentTime, 37, 'Menu track resumes its existing position');
  assert(players[0].plays.every(src => src === manifest.menu.src));
  const preserved = readFileSync(new URL('../public/audio/soundtrack-v001/menu-where-the-stars-remember.mp3', import.meta.url));
  assert.deepEqual(readFileSync(new URL(`..${manifest.menu.src}`, import.meta.url)), preserved);
  engine.dispose();
});

test('menu-only manifest rejects a battle playlist or a recorded victory cue', async () => {
  for (const modified of [{ ...manifest, battles: [manifest.menu] }, { ...manifest, effects: { victory: manifest.menu } }]) {
    const engine = createGameAudio({ storage: null, fetcher: async () => ({ json: async () => modified }) });
    assert.equal(await engine.load(), false); engine.dispose();
  }
});
