import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuel, resolveRound } from '../src/combat.js';
import { renderTournamentLobby, renderTournamentSpectator, renderTournamentBracket, renderTournamentOutcome, renderTournamentEntrance } from '../src/tournament-view.js';

const character = index => ({ name: `Fighter ${index + 1}`, stats: { strength: 4, dexterity: 4, speed: 4, defense: 4, intelligence: 4 }, trait: 'balanced', color: '#b45143', appearance: { sex: index % 2 ? 'female' : 'male' } });
function fixture() {
  const players = Array.from({ length: 8 }, (_, index) => ({ character: character(index), alive: true, duelWins: index, tournamentWins: 0, left: false, connected: true, eliminated: false, seed: index + 1 }));
  const bracket = Array.from({ length: 7 }, (_, index) => ({ index, label: index < 4 ? `Quarterfinal ${index + 1}` : index < 6 ? `Semifinal ${index - 3}` : 'Final', round: index < 4 ? 'quarterfinal' : index < 6 ? 'semifinal' : 'final', slots: index < 4 ? [index * 2, index * 2 + 1] : [null, null], winner: null, loser: null, status: index === 0 ? 'active' : 'pending', advanceReason: null }));
  const duel = createDuel([
    { character: players[0].character, weapon: 'sword', armor: 'medium', helmet: 'none' },
    { character: players[1].character, weapon: 'spear', armor: 'light', helmet: 'none' },
  ]);
  return { type: 'tournament', code: 'ABC234', tournamentId: 'tournament-1', duelId: 'duel-1', phase: 'battle', revision: 4, you: 7, players, bracket, currentMatchIndex: 0, match: { code: 'ABC234', duelId: 'duel-1', revision: 4, you: null, slots: [0, 1], players: players.slice(0, 2), ready: [true, true], pending: [false, true], yourLoadout: null, duel, decision: null, deadline: Date.now() + 20000, rules: {}, canRematch: false }, spectator: true, nextMatchAt: null, champion: null, capacity: 8 };
}

test('the waiting lobby displays eight fighter slots and identities only for joined entrants', () => {
  const view = fixture();
  view.phase = 'waiting'; view.players = view.players.slice(0, 3); view.you = 1; view.currentMatchIndex = null; view.match = null;
  const before = structuredClone(view);
  const output = renderTournamentLobby(view);
  assert.equal((output.match(/data-roster-index=/g) ?? []).length, 8);
  assert.match(output, /3 \/ 8/);
  assert.match(output, /5 more fighters to join/);
  assert.match(output, /Copy code/);
  assert.match(output, /ABC234/);
  assert.equal((output.match(/data-fighter-slot=/g) ?? []).length, 8);
  assert.equal((output.match(/class="tournament-fighter-slot occupied/g) ?? []).length, 3);
  assert.equal((output.match(/class="tournament-slot-empty"/g) ?? []).length, 5);
  assert.equal((output.match(/class="tournament-slot-you"/g) ?? []).length, 1);
  assert.equal((output.match(/class="tournament-slot-stage"/g) ?? []).length, 8);
  assert.doesNotMatch(output, /Before the first fight|tournament-own-figure|tournament-gate-backdrop/);
  assert.equal((output.match(/data-tournament-match=/g) ?? []).length, 7);
  assert.doesNotMatch(output, /portrait|data-action="action"|data-action="lock-loadout"/);
  assert.deepEqual(view, before, 'Viewing the lobby must not change the draw or saved identity.');
});

test('joining and leaving seats updates the displayed roster without inventing fighters or exposing private equipment', () => {
  for (let count = 0; count <= 8; count++) {
    const view = fixture();
    view.phase = 'waiting'; view.players = view.players.slice(0, count); view.you = 0; view.match = null; view.bracket = []; view.currentMatchIndex = null;
    if (count) view.players[0].loadout = { weapon: 'PRIVATE-WEAPON', armor: 'PRIVATE-ARMOR', helmet: 'PRIVATE-HELMET' };
    const before = structuredClone(view);
    const output = renderTournamentLobby(view);
    assert.equal((output.match(/data-fighter-slot=/g) ?? []).length, 8);
    assert.equal((output.match(/class="tournament-fighter-slot occupied/g) ?? []).length, count);
    assert.equal((output.match(/class="tournament-slot-empty"/g) ?? []).length, 8 - count);
    assert.match(output, new RegExp(`${count} / 8 fighters`));
    assert.doesNotMatch(output, /PRIVATE-|data-action="(?:fight|weapon|armor|helmet|lock-loadout)"/);
    assert.deepEqual(view, before, 'Rendering cannot modify identity, seeding, or readiness.');
  }
  const departed = fixture(); departed.phase = 'waiting'; departed.players = departed.players.slice(0, 3); departed.players[1].left = true; departed.bracket = []; departed.match = null; departed.currentMatchIndex = null;
  const output = renderTournamentLobby(departed);
  assert.equal((output.match(/class="tournament-fighter-slot occupied/g) ?? []).length, 2);
  assert.equal((output.match(/class="tournament-slot-empty"/g) ?? []).length, 6);
  assert.match(output, /2 \/ 8 fighters/);
  assert.doesNotMatch(output, /Fighter 2/);
});

test('the waiting lobby identifies only joined bots and shows one authoritative fill countdown', () => {
  const view = fixture();
  view.phase = 'waiting'; view.players = view.players.slice(0, 2); view.you = 0; view.match = null; view.bracket = []; view.currentMatchIndex = null;
  view.nextBotAt = Date.now() + 20000;
  view.players[1].bot = true;
  view.players[1].character.name = 'Titus Invictus';
  view.players[1].loadout = { weapon: 'PRIVATE-WEAPON', armor: 'PRIVATE-ARMOR' };
  const before = structuredClone(view);
  const output = renderTournamentLobby(view);
  assert.match(output, /Slot 2: Titus Invictus, bot/);
  assert.match(output, /Joined <span class="tournament-bot">Bot<\/span>/);
  assert.equal((output.match(/class="tournament-bot"/g) ?? []).length, 1);
  assert.equal((output.match(/Next bot in/g) ?? []).length, 1);
  assert.match(output, new RegExp(`data-deadline="${view.nextBotAt}"`));
  assert.equal((output.match(/class="tournament-slot-empty"/g) ?? []).length, 6);
  assert.match(output, /Invite rivals with this code/);
  assert.doesNotMatch(output, /Invite seven rivals|PRIVATE-|data-action="(?:weapon|armor|helmet|lock-loadout)"/);
  assert.deepEqual(view, before, 'Bot labels and timers cannot alter a fighter identity or expose private equipment.');
});

test('bot countdowns disappear when the lobby is full, unscheduled, or past the waiting phase', () => {
  const view = fixture();
  view.nextBotAt = Date.now() + 20000;
  view.phase = 'waiting';
  assert.doesNotMatch(renderTournamentLobby(view), /Next bot in|data-deadline=/);
  view.players = view.players.slice(0, 1);
  for (const phase of ['equipment', 'entrance', 'battle', 'mercy', 'intermission', 'complete']) {
    view.phase = phase;
    assert.doesNotMatch(renderTournamentLobby(view), /Next bot in|data-deadline=/);
  }
  view.phase = 'waiting'; view.nextBotAt = null;
  assert.doesNotMatch(renderTournamentLobby(view), /Next bot in|data-deadline=/);
  view.players[0].bot = 'true';
  assert.doesNotMatch(renderTournamentLobby(view), /class="tournament-bot"/);
});

test('spectator and outcome rosters retain bot markers alongside the normal tournament status', () => {
  const view = fixture();
  view.players[0].bot = true;
  view.players[0].character.name = 'Titus Invictus';
  const before = structuredClone(view);
  const output = renderTournamentSpectator(view);
  assert.match(output, /Titus Invictus <span class="tournament-bot">Bot<\/span><\/strong><small>In the arena<\/small>/);
  assert.equal((output.match(/class="tournament-bot"/g) ?? []).length, 1);
  assert.doesNotMatch(output, /Next bot in/);
  assert.deepEqual(view, before);
  view.phase = 'complete'; view.champion = 0;
  assert.match(renderTournamentOutcome(view), /Titus Invictus <span class="tournament-bot">Bot<\/span><\/strong><small>Champion<\/small>/);
});

test('the bracket contains four quarterfinals, two semifinals, a final, and exactly one current pairing', () => {
  const view = fixture();
  view.bracket[1].status = 'active'; // Even stale flags cannot imply simultaneous fights.
  const output = renderTournamentBracket(view);
  assert.equal((output.match(/data-tournament-match=/g) ?? []).length, 7);
  assert.equal((output.match(/aria-current="step"/g) ?? []).length, 1);
  assert.match(output, /data-tournament-match="0" aria-current="step"/);
  assert.match(output, /Winner QF 1/);
  assert.match(output, /Winner QF 4/);
  assert.match(output, /Winner SF 1/);
  view.phase = 'intermission';
  view.bracket[0] = { ...view.bracket[0], status: 'complete', winner: 0, loser: 1, advanceReason: 'draw_seed' };
  const finished = renderTournamentBracket(view);
  assert.doesNotMatch(finished, /aria-current="step"/);
  assert.match(finished, /class="tournament-bracket-fighter advanced"/);
  assert.match(finished, /Draw · advancement by original seeding/);
});

test('live spectators see the real stands camera, public equipment, health, stamina, and choice readiness', () => {
  const view = fixture();
  const before = structuredClone(view);
  const output = renderTournamentSpectator(view);
  assert.match(output, /class="spectator-frame"/);
  assert.match(output, /spectator-rows-v\d+\.png/);
  assert.match(output, /viewBox="0 0 920 580"/);
  assert.match(output, /class="arena-stage"/);
  assert.match(output, /data-fighter-index="0"/);
  assert.match(output, /data-fighter-index="1"/);
  assert.match(output, /translate\(340 365\) scale\(\.5\)/);
  assert.match(output, /translate\(580 365\) scale\(-\.5 \.5\)/);
  assert.match(output, /Sword · Medium Armor/);
  assert.match(output, /Spear · Light Armor/);
  assert.equal((output.match(/class="meter health"/g) ?? []).length, 2);
  assert.equal((output.match(/class="meter stamina"/g) ?? []).length, 2);
  assert.match(output, /Choice locked/);
  assert.match(output, /Choosing a move/);
  assert.match(output, /data-deadline=/);
  assert.doesNotMatch(output, /data-action="(?:action|lock-loadout|gear|mercy)"|data-gear=|Execute rival|Spare rival/);
  assert.deepEqual(view, before);
});

test('spectator playback renders the supplied reveal state without changing or inspecting secret selections', () => {
  const view = fixture();
  const before = structuredClone(view.match.duel);
  const after = resolveRound(before, ['strike', 'technique']);
  view.match.yourLoadout = { weapon: 'PRIVATE-WEAPON', armor: 'PRIVATE-ARMOR' };
  view.match.pending = ['PRIVATE-CHOICE-ONE', 'PRIVATE-CHOICE-TWO'];
  const output = renderTournamentSpectator(view, { playing: true, duel: after });
  assert.match(output, /Moves revealed/);
  assert.match(output, /Both choices are revealed/);
  for (const fighter of after.fighters) assert.ok(output.includes(`${fighter.hp} / ${fighter.maxHp}`));
  assert.doesNotMatch(output, /PRIVATE-|Choices reveal in|data-action="action"/);
  assert.deepEqual(view.match.duel, before, 'Playback snapshots never mutate the authoritative duel.');
});

test('equipment and entrance waiting show the real gate while unrevealed loadouts remain private', () => {
  const view = fixture();
  view.phase = 'equipment'; view.match.ready = [true, false]; view.match.duel = null;
  view.match.yourLoadout = { weapon: 'PRIVATE-WEAPON', armor: 'PRIVATE-ARMOR' };
  const output = renderTournamentSpectator(view);
  assert.match(output, /Preparing for battle/);
  assert.match(output, /arena-gate\.jpg/);
  assert.match(output, /Choosing equipment/);
  assert.match(output, /<span>Ready<\/span>/);
  assert.match(output, /data-tournament-gate/);
  assert.doesNotMatch(output, /PRIVATE-|arena-svg|meter health|data-action="lock-loadout"/);
  view.phase = 'entrance'; view.match.duel = fixture().match.duel;
  const entrance = renderTournamentSpectator(view);
  assert.match(entrance, /The gates are opening/);
  assert.match(entrance, /Spectating begins in/);
  assert.match(entrance, /class="tournament-gate-video" muted playsinline/);
  assert.match(entrance, /arena-gate\.mp4/);
  assert.equal(entrance, renderTournamentEntrance(view), 'Spectators share the same preserved gate opening.');
  assert.doesNotMatch(entrance, /arena-svg|Sword · Medium Armor|Spear · Light Armor/);
});

test('both combatants and all six spectators receive the gate film before their respective battle views', () => {
  const view = fixture(); view.phase = 'entrance';
  for (let slot = 0; slot < 8; slot++) {
    view.you = slot;
    view.match.you = view.match.slots.includes(slot) ? view.match.slots.indexOf(slot) : null;
    const before = structuredClone(view), output = renderTournamentEntrance(view);
    assert.equal((output.match(/class="tournament-gate-video"/g) ?? []).length, 1);
    assert.match(output, /arena-gate\.mp4/);
    assert.match(output, view.match.you === null ? /Spectating begins in/ : /Battle begins in/);
    assert.doesNotMatch(output, /data-action="(?:fight|weapon|armor|helmet|lock-loadout|mercy)"|spectator-frame|arena-stage/);
    assert.deepEqual(view, before);
  }
});

test('intermission shows the completed pairing and countdown, with survivor and retired spectator states', () => {
  const view = fixture();
  view.phase = 'intermission'; view.nextMatchAt = Date.now() + 6000;
  view.bracket[0] = { ...view.bracket[0], status: 'complete', winner: 0, loser: 1 };
  view.players[7].eliminated = true;
  const output = renderTournamentSpectator(view);
  assert.match(output, /Fighter 1 advances/);
  assert.match(output, /Next match in/);
  assert.match(output, /Your surviving fighter keeps their identity and record/);
  assert.match(output, /Leave the stands/);
  assert.doesNotMatch(output, /aria-current="step"/);
  view.players[7].alive = false;
  assert.match(renderTournamentSpectator(view), /Your fighter has been retired/);
});

test('complete tournaments celebrate the champion and allow survivors or replacements into another tournament', () => {
  const view = fixture();
  view.phase = 'complete'; view.champion = 7;
  view.bracket.forEach(match => { match.status = 'complete'; });
  view.bracket[6].slots = [3, 7]; view.bracket[6].winner = 7;
  const output = renderTournamentOutcome(view);
  assert.match(output, /Fighter 8 takes the crown/);
  assert.match(output, /You are the arena’s champion/);
  assert.match(output, /Your champion survives with their identity and record/);
  assert.match(output, /Enter another tournament/);
  assert.match(output, /data-action="tournament-leave"/);
  assert.doesNotMatch(output, /aria-current="step"|data-action="rematch"/);
  view.you = 1; view.players[1].alive = false; view.players[1].eliminated = true;
  assert.match(renderTournamentOutcome(view), /Create a new fighter/);
  assert.match(renderTournamentSpectator(view), /Fighter 8 takes the crown/);
});

test('roster, bracket, champion, and arena text escape names and room codes', () => {
  const view = fixture();
  view.players[0].character.name = '<script>bad</script>';
  view.players[0].character.color = '" onload="bad';
  view.code = '"<img src=x>';
  for (const output of [renderTournamentLobby(view), renderTournamentSpectator(view), renderTournamentBracket(view), renderTournamentEntrance(view)]) {
    assert.doesNotMatch(output, /<script>|<img src=x>|onload="bad/);
    assert.match(output, /&lt;script&gt;bad&lt;\/script&gt;/);
  }
  view.phase = 'complete'; view.champion = 0;
  assert.match(renderTournamentOutcome(view), /&lt;script&gt;bad&lt;\/script&gt; takes the crown/);
});
