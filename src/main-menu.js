const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const count = value => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0;
const names = value => Array.isArray(value) ? value.map(fighter => typeof fighter === 'string' ? fighter : fighter?.name ?? fighter?.character?.name ?? '').filter(Boolean) : [];
const phaseLabels = Object.freeze({ waiting: 'Gathering fighters', equipment: 'Choosing equipment', entrance: 'Entering the arena', battle: 'Duel in progress', mercy: 'Mercy decision', crowd: 'Crowd ballot', intermission: 'Between duels', complete: 'Tournament complete' });

// Original 5 × 7 lettering: every cell stays on the integer SVG grid.
const pixelGlyphs = Object.freeze({
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01111', '10000', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  J: ['00111', '00010', '00010', '00010', '10010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
});

function pixelLabel(label, scale = 2) {
  let cursor = 0, path = '';
  for (const letter of label.toUpperCase()) {
    const rows = pixelGlyphs[letter];
    if (!rows) { cursor += 4; continue; }
    rows.forEach((row, y) => [...row].forEach((cell, x) => { if (cell === '1') path += `M${cursor + x} ${y}h1v1h-1z`; }));
    cursor += 6;
  }
  const width = Math.max(1, cursor - 1);
  return `<svg class="menu-pixel-label" width="${width * scale}" height="${7 * scale}" viewBox="0 0 ${width} 7" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="${path}"/></svg><span class="sr-only">${escape(label)}</span>`;
}

function menuCommand(action, label, primary = false) {
  return `<button type="button" class="button ${primary ? 'primary' : 'secondary'}" data-action="${action}" aria-label="${escape(label)}"><svg class="menu-command-pointer" width="10" height="14" viewBox="0 0 5 7" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path d="M0 0h1v1h1v1h1v1h1v1H3v1H2v1H1v1H0z"/></svg>${pixelLabel(label)}</button>`;
}

function navigation(loading) {
  return `<nav class="menu-page-navigation" aria-label="Page navigation"><button type="button" class="button ghost" data-action="menu-home">Main menu</button><button type="button" class="button ghost" data-action="menu-refresh" ${loading ? 'disabled' : ''}>Refresh</button></nav>`;
}

function temporaryNotice(temporary, personal = false) {
  return temporary ? `<p class="menu-record-notice">Records last for this visit. The arena resets when its server restarts.${personal ? ' Your graves belong to this tab and are no longer available after its session expires.' : ''}</p>` : '';
}

function emptyState(title, detail, loading = false) {
  return `<div class="menu-empty" role="status"><h2>${escape(title)}</h2>${detail ? `<p>${escape(detail)}</p>` : ''}${loading ? '<span class="menu-loading-rule" aria-hidden="true"></span>' : ''}</div>`;
}

/** The main menu does not modify, recreate, or render a saved fighter identity. */
export function renderMainMenu({ session = null, temporary = false } = {}) {
  const surviving = session?.character && session.alive !== false;
  const active = Boolean(session?.activeTournament || session?.activeRoom);
  const fightNote = active ? 'Resume your place in the arena.' : surviving ? 'Enter the lobby with your surviving fighter.' : 'Create a fighter and enter the lobby.';
  const quickNote = active ? 'Resume your current match first.' : surviving ? 'One duel with your surviving fighter.' : 'Create a fighter for one duel.';
  return `<section class="arena-main-menu" aria-labelledby="arena-menu-title"><header class="menu-title-page"><span class="eyebrow">Glory or the grave</span><h1 id="arena-menu-title" aria-label="ARENA FIGHTERS"><span class="menu-title-line">${pixelLabel('ARENA', 4)}</span><span class="menu-title-line">${pixelLabel('FIGHTERS', 4)}</span></h1><div class="menu-title-rule" aria-hidden="true"><span></span></div></header><nav class="menu-primary" aria-label="Arena activities"><div class="menu-primary-entry">${menuCommand('menu-fight', 'FIGHT', true)}<p>${fightNote}</p></div><div class="menu-primary-entry">${menuCommand('menu-quick-duel', 'QUICK DUEL')}<p>${quickNote}</p></div><div class="menu-primary-entry">${menuCommand('menu-learn', 'LEARN TO FIGHT')}<p>Three coached rounds. No time limit.</p></div><div class="menu-primary-entry">${menuCommand('menu-spectate', 'SPECTATE')}<p>Watch a tournament.</p></div><div class="menu-primary-entry">${menuCommand('menu-leaderboard', 'LEADERBOARD')}<p>Living champions.</p></div></nav>${surviving ? `<p class="menu-current-fighter"><span>Surviving fighter</span><strong>${escape(session.character.name)}</strong><span>${count(session.duelWins)} duel ${count(session.duelWins) === 1 ? 'win' : 'wins'} · ${count(session.tournamentWins)} tournament ${count(session.tournamentWins) === 1 ? 'win' : 'wins'}</span></p>` : ''}<footer class="menu-secondary">${menuCommand('menu-graveyard', 'Graveyard')}<p>Remember your fallen fighters.</p></footer></section>`;
}

export function renderMatchBrowser({ tournaments = [], loading = false, temporary = false, watchCode = '' } = {}) {
  const entries = Array.isArray(tournaments) ? tournaments : [];
  return `<section class="menu-record-page menu-spectate-page" aria-labelledby="spectate-title">${navigation(loading)}<header class="menu-record-heading"><span class="eyebrow">From the stands</span><h1 id="spectate-title">Spectate</h1><p>Choose a tournament to watch.</p></header><section class="menu-watch-code" aria-labelledby="watch-code-title"><div><h2 id="watch-code-title">Have a lobby code?</h2><p>Find the tournament your friends joined.</p></div><div class="menu-watch-code-controls"><label class="sr-only" for="watch-code">Six-character lobby code</label><input type="text" id="watch-code" data-watch-code maxlength="6" minlength="6" pattern="[A-Za-z0-9]{6}" value="${escape(watchCode)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="LOBBY CODE" aria-describedby="watch-code-hint"><button type="button" class="button secondary" data-action="watch-code">Watch</button></div><span class="sr-only" id="watch-code-hint">Enter the six-character code shared by a friend.</span></section><div class="menu-live-list" aria-busy="${Boolean(loading)}">${loading && !entries.length ? emptyState('Finding tournaments…', '', true) : entries.length ? `<ul class="menu-tournament-list">${entries.map(tournament => {
    const fighters = names(tournament?.fighters);
    const phase = phaseLabels[tournament?.phase] ?? 'Tournament';
    return `<li class="menu-tournament"><div class="menu-tournament-heading"><span class="eyebrow">${escape(phase)}</span><strong class="menu-tournament-code">${escape(tournament?.code)}</strong></div><div class="menu-tournament-details"><h2>${escape(tournament?.currentMatchLabel || (tournament?.phase === 'waiting' ? 'The draw is gathering' : 'Eight-fighter tournament'))}</h2><p>${count(tournament?.playerCount)} ${count(tournament?.playerCount) === 1 ? 'fighter' : 'fighters'}${fighters.length ? ` · ${escape(fighters.join(', '))}` : ''}</p></div><button type="button" class="button secondary" data-action="watch-tournament" data-value="${escape(tournament?.code)}" aria-label="Watch tournament ${escape(tournament?.code)}">Watch</button></li>`;
  }).join('')}</ul>` : emptyState('No tournaments to watch yet.', 'A tournament will appear here when fighters enter the lobby. You can also watch with a friend’s lobby code.')}</div></section>`;
}

export function renderLeaderboard({ fighters = [], loading = false, temporary = false } = {}) {
  const entries = Array.isArray(fighters) ? fighters : [];
  return `<section class="menu-record-page menu-leaderboard-page" aria-labelledby="leaderboard-title">${navigation(loading)}<header class="menu-record-heading"><span class="eyebrow">The surviving champions</span><h1 id="leaderboard-title">Leaderboard</h1><p>Living fighters, ranked by total duel wins.</p></header>${temporaryNotice(temporary)}<div class="menu-live-list" aria-busy="${Boolean(loading)}">${loading && !entries.length ? emptyState('Reading the arena register…', '', true) : entries.length ? `<table class="menu-leaderboard"><caption class="sr-only">Surviving fighters ranked by total duel wins</caption><colgroup><col class="menu-rank-column"><col class="menu-name-column"><col class="menu-wins-column"><col class="menu-crowns-column"></colgroup><thead><tr><th scope="col">Rank</th><th scope="col">Fighter</th><th scope="col">Duel<br>wins</th><th scope="col">Tournament<br>wins</th></tr></thead><tbody>${entries.map((fighter, index) => `<tr><td class="menu-rank">${count(fighter?.rank ?? index + 1)}</td><th scope="row">${escape(fighter?.character?.name ?? 'Unnamed fighter')}</th><td>${count(fighter?.duelWins)}</td><td>${count(fighter?.tournamentWins)}</td></tr>`).join('')}</tbody></table>` : emptyState('The register is waiting.', 'Surviving fighters will appear here after entering the arena.')}</div></section>`;
}

function memorialDate(value) {
  if (value === null || value === undefined || value === '') return 'Date unrecorded';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unrecorded';
  const label = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  return `<time datetime="${escape(date.toISOString())}">${escape(label)}</time>`;
}

export function renderGraveyard({ graves = [], loading = false, temporary = false } = {}) {
  const entries = Array.isArray(graves) ? graves : [];
  return `<section class="menu-record-page menu-graveyard-page" aria-labelledby="graveyard-title">${navigation(loading)}<header class="menu-record-heading"><span class="eyebrow">In remembrance</span><h1 id="graveyard-title">Your graveyard</h1><p>A memorial for each of your fallen fighters.</p></header>${temporaryNotice(temporary, true)}<div class="menu-live-list" aria-busy="${Boolean(loading)}">${loading && !entries.length ? emptyState('Reading your memorials…', '', true) : entries.length ? `<ul class="menu-grave-list">${entries.map(grave => {
    const killer = typeof grave?.killedBy === 'string' ? grave.killedBy : grave?.killedBy?.name ?? grave?.killedBy?.character?.name;
    return `<li><article class="menu-grave"><span class="menu-memorial-mark" aria-hidden="true">◇</span><h2>${escape(grave?.character?.name ?? 'Unnamed fighter')}</h2><p class="menu-grave-date">${memorialDate(grave?.diedAt)}</p><dl class="menu-final-record"><div><dt>Duel wins</dt><dd>${count(grave?.duelWins)}</dd></div><div><dt>Tournament wins</dt><dd>${count(grave?.tournamentWins)}</dd></div></dl><p class="menu-grave-verdict">${killer ? `Fell to ${escape(killer)}.` : 'Fell in the arena.'}</p></article></li>`;
  }).join('')}</ul>` : emptyState('No fallen fighters.', 'Your fighters’ final records will be remembered here.')}</div></section>`;
}
