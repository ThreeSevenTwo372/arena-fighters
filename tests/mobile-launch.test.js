import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { squarespaceEmbed } from '../tools/build-squarespace-embed.mjs';
const source = await readFile(new URL('../src/mobile-launch.js', import.meta.url), 'utf8');
function run({ url = 'https://www.blackbooktattoo.com/arena-fighters', mobile = true, nested = false,
  script = 'https://blackbook-arena-fighters.onrender.com/src/mobile-launch.js' } = {}) {
  const navigation = [], window = { location: { href: url, replace: value => navigation.push(value) },
    matchMedia: () => ({ matches: mobile }) };
  window.self = window; window.top = nested ? {} : window;
  runInNewContext(source, { window, document: { currentScript: script ? { src: script } : null }, URL });
  return navigation;
}
test('published phone entry opens the own-origin game directly in the same tab', () => {
  assert.deepEqual(run(), ['https://blackbook-arena-fighters.onrender.com/']);
  assert.deepEqual(run({ url: 'https://blackbooktattoo.com/arena-fighters/' }), ['https://blackbook-arena-fighters.onrender.com/']);
  assert.deepEqual(run({ mobile: false }), []);
});
test('mobile launch never navigates editor previews, nested frames or other pages', () => {
  for (const options of [{ nested: true }, { url: 'https://fish-bullfrog-sgh8.squarespace.com/config/pages' },
    { url: 'https://fish-bullfrog-sgh8.squarespace.com/arena-fighters' }, { url: 'https://www.blackbooktattoo.com/gallery' },
    { url: 'https://blackbook-arena-fighters.onrender.com/' }]) assert.deepEqual(run(options), []);
});
test('direct launch forwards only valid public invitation code and duel mode', () => {
  const result = run({ url: 'https://www.blackbooktattoo.com/arena-fighters?invite=AB12CD&duel-mode=1&token=private&return=https://example.com#fragment' });
  assert.deepEqual(result, ['https://blackbook-arena-fighters.onrender.com/?invite=AB12CD&duel-mode=1']);
  assert.deepEqual(run({ url: 'https://www.blackbooktattoo.com/arena-fighters?invite=bad&duel-mode=2' }), ['https://blackbook-arena-fighters.onrender.com/']);
});
test('launch destination is derived from the trusted HTTPS script, never arbitrary query data', () => {
  for (const script of [null, 'http://example.com/src/mobile-launch.js', 'https://name:secret@example.com/src/mobile-launch.js',
    'https://example.com/unrelated.js']) assert.deepEqual(run({ script }), []);
});
test('Squarespace code keeps desktop iframe and a direct link with mobile launch script', () => {
  const html = squarespaceEmbed('https://blackbook-arena-fighters.onrender.com/');
  assert(html.includes('<script src="https://blackbook-arena-fighters.onrender.com/src/mobile-launch.js" defer></script>'));
  assert(html.includes('target="_self"'));assert(html.includes('title="Arena Fighters"'));
  for (const origin of ['http://example.com', 'https://name:secret@example.com', 'https://example.com/?token=secret',
    'https://example.com/private']) assert.throws(() => squarespaceEmbed(origin));
});
