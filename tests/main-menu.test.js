import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMainMenu, renderMatchBrowser, renderLeaderboard, renderGraveyard } from '../src/main-menu.js';

test('the main menu offers fighting, learning, records and spectating', () => {
  const output = renderMainMenu();
  for (const [action, label] of [['menu-fight', 'FIGHT'], ['menu-quick-duel', 'QUICK DUEL'], ['menu-learn', 'LEARN TO FIGHT'], ['menu-spectate', 'SPECTATE'], ['menu-leaderboard', 'LEADERBOARD'], ['menu-graveyard', 'Graveyard']]) {
    assert.match(output, new RegExp(`data-action="${action}" aria-label="${label}"`));
    assert.match(output, new RegExp(`<span class="sr-only">${label}</span>`));
  }
  assert.match(output, /id="arena-menu-title" aria-label="ARENA FIGHTERS"/);
  assert.doesNotMatch(output, /portrait|canvas|data-appearance|data-action="online-create"/);
});

test('resuming shows the saved fighter record without changing the identity or revealing credentials', () => {
  const session = { character: { name: 'Cassian <script>', id: 'PRIVATE-CHARACTER', appearance: { facePreset: 'p01' } }, alive: true, duelWins: 12, tournamentWins: 2, activeTournament: 'ABC234', token: 'PRIVATE-TOKEN' };
  const before = structuredClone(session);
  const output = renderMainMenu({ session });
  assert.match(output, /data-action="menu-fight" aria-label="FIGHT"/);
  assert.match(output, /Resume your place/);
  assert.match(output, /Cassian &lt;script&gt;/);
  assert.match(output, /12 duel wins · 2 tournament wins/);
  assert.doesNotMatch(output, /PRIVATE-|facePreset|<script>/);
  assert.deepEqual(session, before);
  assert.doesNotMatch(renderMainMenu({ session: { ...session, alive: false, activeTournament: null } }), /Surviving fighter/);
});

test('spectator browsing includes exact watch actions, match state, and the six-character friend code field', () => {
  const tournaments = [{ code: 'ABC234', phase: 'mercy', playerCount: 8, currentMatchLabel: 'Semifinal 1', fighters: ['Cassian', 'Mira'] }];
  const before = structuredClone(tournaments);
  const output = renderMatchBrowser({ tournaments, watchCode: 'ABC234' });
  assert.match(output, /data-action="watch-tournament" data-value="ABC234"/);
  assert.match(output, /Mercy decision/);
  assert.match(output, /Semifinal 1/);
  assert.match(output, /8 fighters · Cassian, Mira/);
  assert.match(output, /data-watch-code maxlength="6" minlength="6" pattern="\[A-Za-z0-9\]\{6\}" value="ABC234"/);
  assert.match(output, /data-action="watch-code">Watch<\/button>/);
  assert.match(output, /for="watch-code"/);
  assert.deepEqual(tournaments, before);
});

test('spectator content and lobby-code attributes cannot inject executable HTML', () => {
  const output = renderMatchBrowser({ watchCode: '"><img src=x onerror=alert(1)>', tournaments: [{ code: '" onclick="attack', phase: '<script>', playerCount: '<svg>', currentMatchLabel: '<script>attack</script>', fighters: ['<img>', 'A&B'] }] });
  assert.match(output, /data-value="&quot; onclick=&quot;attack"/);
  assert.match(output, /&lt;script&gt;attack&lt;\/script&gt;/);
  assert.match(output, /&lt;img&gt;, A&amp;B/);
  assert.doesNotMatch(output, /<script>|<img|<svg|\bonclick="attack/);
});

test('the leaderboard displays authoritative rank and both records without exposing identities or reordering', () => {
  const fighters = [{ rank: 3, character: { id: 'PRIVATE-ID', name: 'Mira', appearance: { facePreset: 'p10' } }, duelWins: 17, tournamentWins: 4 }, { rank: 4, character: { name: 'Titus' }, duelWins: 16, tournamentWins: 7 }];
  const before = structuredClone(fighters);
  const output = renderLeaderboard({ fighters });
  assert.match(output, /<table class="menu-leaderboard">/);
  assert.match(output, /<td class="menu-rank">3<\/td><th scope="row">Mira<\/th><td>17<\/td><td>4<\/td>/);
  assert.ok(output.indexOf('Mira') < output.indexOf('Titus'));
  assert.doesNotMatch(output, /PRIVATE-ID|facePreset|portrait/);
  assert.deepEqual(fighters, before);
});

test('a grave preserves the fallen name, final record, date and killer without changing saved data', () => {
  const graves = [{ character: { id: 'PRIVATE-ID', name: 'Aurelia & Co' }, duelWins: 9, tournamentWins: 1, diedAt: '2026-10-08T18:45:00Z', killedBy: 'Cassian <script>' }];
  const before = structuredClone(graves);
  const output = renderGraveyard({ graves });
  assert.match(output, /Aurelia &amp; Co/);
  assert.match(output, /<dt>Duel wins<\/dt><dd>9<\/dd>/);
  assert.match(output, /<dt>Tournament wins<\/dt><dd>1<\/dd>/);
  assert.match(output, /<time datetime="2026-10-08T18:45:00.000Z">Oct 8, 2026<\/time>/);
  assert.match(output, /Fell to Cassian &lt;script&gt;\./);
  assert.doesNotMatch(output, /PRIVATE-ID|<script>|portrait/);
  assert.deepEqual(graves, before);
});

test('loading and empty states stay honest, navigable, and separate from records', () => {
  for (const render of [renderMatchBrowser, renderLeaderboard, renderGraveyard]) {
    const loading = render({ loading: true });
    assert.match(loading, /aria-busy="true"/);
    assert.match(loading, /data-action="menu-home"/);
    assert.match(loading, /data-action="menu-refresh" disabled/);
    assert.match(loading, /role="status"/);
    assert.doesNotMatch(loading, /<table|class="menu-grave"|class="menu-tournament"/);
    const empty = render();
    assert.match(empty, /aria-busy="false"/);
    assert.doesNotMatch(empty, /data-action="menu-refresh" disabled/);
  }
  assert.match(renderGraveyard(), /No fallen fighters/);
  assert.match(renderMatchBrowser(), /No tournaments to watch yet/);
});

test('temporary records explain expiry only on record pages and do not promise permanent history', () => {
  for (const render of [renderLeaderboard, renderGraveyard]) {
    assert.match(render({ temporary: true }), /Records last for this visit\. The arena resets when its server restarts\./);
    assert.doesNotMatch(render({ temporary: false }), /server restarts/);
  }
  assert.match(renderGraveyard({ temporary: true }), /no longer available after its session expires/);
  assert.doesNotMatch(renderMatchBrowser({ temporary: true }), /Records last for this visit/);
  assert.doesNotMatch(renderMainMenu({ temporary: true }), /Records last for this visit|RAM|session token|IDs/);
});

test('pixel lettering uses integer cells and integer display multiples with accessible command labels', () => {
  const output = renderMainMenu();
  const glyphs = [...output.matchAll(/class="menu-pixel-label" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) 7" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="([^"]+)"/g)];
  assert.equal(glyphs.length, 8, 'Two title lines and six commands use the authored pixel lettering.');
  for (const [, width, height, nativeWidth, path] of glyphs) {
    const scale = Number(height) / 7;
    assert.ok([2, 4].includes(scale));
    assert.equal(Number(width), Number(nativeWidth) * scale);
    assert.match(path, /^(?:M\d+ \d+h1v1h-1z)+$/);
  }
  assert.doesNotMatch(output, /<text|font-family=|<image/);
});

test('corrupt counts and memorial dates do not produce unsafe markup or impossible displayed records', () => {
  const output = renderGraveyard({ graves: [{ character: { name: 'Titus' }, duelWins: -9, tournamentWins: 'Infinity', diedAt: '<script>', killedBy: { name: 'Mira' } }] });
  assert.match(output, /<dt>Duel wins<\/dt><dd>0<\/dd>/);
  assert.match(output, /<dt>Tournament wins<\/dt><dd>0<\/dd>/);
  assert.match(output, /Date unrecorded/);
  assert.match(output, /Fell to Mira\./);
  assert.doesNotMatch(output, /Infinity|NaN|<script>/);
});
