# Shared combat and retained online duels, current v0.8.4

The default site now runs the eight-player sequential tournament documented in [TOURNAMENTS.md](TOURNAMENTS.md). Its first-tab Flux arrival leads to naming, creation, automatic lobby entry, gate preparation, and live matches with member spectators. The attributes, traits, equipment, combat rules, mercy, and durable character records below are shared by tournaments and the retained duel modes.

For a standalone two-player online duel, open `?duel-mode=1`, name and customize a fighter, create a room, and share its six-character code with a rival. Both players must visit the same running service using separate browser profiles or devices. Practice and Pass & play remain available. Surviving fighters keep their identity and skip naming. Two-player rematch controls apply to this retained flow; tournaments advance through their bracket instead.

Run `node server.mjs` and open `http://127.0.0.1:4173`. For two devices on the same network, run `node server.mjs --host 0.0.0.0 --port 4173` and use this computer’s LAN address on both devices. Only one process should own the default data store. This is a locally verified service; a public HTTPS deployment and real-device internet testing remain pending.

## Attributes

Allocate exactly 20 points, with each attribute from 0 through 8. Appearance, attributes, and the creation trait stay with the surviving character. Any character can use any weapon and armor; changing equipment before a duel changes its effectiveness.

| Attribute | Effect |
| --- | --- |
| Strength | Ordinary weapon damage, especially axes, maces, and greatswords; heavy-weapon initiative and stamina handling |
| Dexterity | Precise weapon damage and techniques, especially swords and spears |
| Speed | Initiative when both actions have equal priority; stamina recovery +2 per 4 points, up to +4 |
| Defense | Maximum health, personal protection, and additional medium/heavy armor protection |
| Intelligence | Technique damage and lower attack costs, plus a small fortune bonus to damage, initiative, health, stamina, recovery, and protection |

Intelligence’s fortune bonus starts at 6 and is capped at +1 under this point cap. Technique power also receives a smaller continuous Intelligence contribution. Fortune is deterministic and visible in equipment previews; there are no random misses. Costs cannot fall below 2 stamina for Strike or 3 for a technique. These are initial tuning values, not a certification of competitive balance.

The creator shows attribute values without explanations or preset buttons. New fighters start at 4 in every attribute; redistribute the same 20 points with the value controls. Ten lifelong traits are available:

| Trait | Bonus | Drawback |
| --- | --- | --- |
| Measured | Maximum stamina +2 | None; modest default |
| Relentless | Attack power +2 | Maximum stamina -2 |
| Steadfast | Maximum health +6 | Initiative -1 |
| Berserker | Attack power +4 | Maximum health -10; attack costs +1 |
| Fleetfoot | Initiative +4 | Maximum health -8 |
| Ironhide | Personal protection +2 | Initiative -3; stamina recovery -2 |
| Vigorous | Maximum stamina +5; stamina recovery +2 | Attack power -2 |
| Brawler | Strike power +4 | Strike cost +1; technique power -3 |
| Specialist | Technique power +4 | Technique cost +1; Strike power -3 |
| Efficient | Attack costs -1 | Attack power -2; minimum costs still apply |

Positive trait cost penalties apply after attribute discounts reach their minimums, so the drawback remains effective. Protection also applies against armor-piercing attacks. The original Measured/Relentless/Steadfast records retain their IDs and effects.

## Privacy and authority

Members see character attributes. Each equipment selection is sent only to its owner until both current duelists commit. The server then creates the duel and reveals both loadouts. Tournament spectators receive the public resolved duel, meters, and readiness flags; they cannot submit equipment, actions, or the winner's mercy choice. If the winner delegates to the crowd, eligible living spectators may each cast one Spare/Kill vote. Each combat round works the same way: clients submit one action, the service waits for both, resolves the shared rules, and reveals the outcome. Action priority acts before initiative; equal initiative alternates the first fighter. A defeated fighter cannot finish its action. Pending action values remain private from both rivals and spectators.

The command-window interface keeps the shared arena renderer, health/stamina HUD, battle message, and four commands in a two-by-two grid. Costs and damage stay visible; hover/focus reveals counterplay and priority. The countdown appears above the commands. Public readiness shows choosing, sending, locked, reconnecting, or revealed without identifying a private move. Battle chronicle and attribute details start collapsed. Short desktop windows fit the complete battlefield into a smaller frame without cropping fighter assemblies.

Animation plays resolved server events in full. Player battles have no Skip animation or Next round option. All modes advance automatically after playback; Pass & play retains a private device handoff between players. Copy code is disabled during animation so it cannot interrupt the round. A forfeiting player may still leave the duel.

Base health is now 90 (previously 48), before attribute and trait modifiers. Speed adds bounded recovery so faster builds remain competitive over longer fights. Weapon power, attack costs, trait modifiers, and armor mitigation retain their values. Across 2,520 representative matchups per offensive policy, median lengths are 10 rounds with CPU decisions, 8 with Strike/Recover, and 9 with Technique/Recover, versus 5/4/5 previously. At least 99.2% end by knockout; fewer than 1% reach the 24-round limit. Existing specialist/trait balance thresholds remain unchanged. These simulations support pacing, while human play will determine whether it feels right.

The service rejects invalid attributes/equipment, unauthorized room reads, stale round/duel commands, and changes to an already committed choice. Repeated command IDs cannot resolve a round, award a win, or execute a character twice. The client retries the same command after a lost response and reconciles room creation/joining through its guest session.

## Timers and records

| Window | Default |
| --- | --- |
| Equipment, 120 seconds | Sword, medium armor, no helmet for missing selections |
| Tournament entrance, 8 seconds | Gate film before the first action deadline starts |
| Combat action, 20 seconds maximum | Recover for missing choices |
| Disconnect, 90 seconds | The absent fighter forfeits; both absent yields a draw |
| Winner reveal, 5 seconds online / 1 second local | Displays the winner before mercy opens |
| Mercy, 20 seconds after winner reveal | Spare |
| Crowd ballot, separate 20 seconds after delegation | Execute only if Kill votes exceed Spare votes; ties/no votes spare |
| Tournament intermission, 6 seconds | Automatically call the next scheduled pair |

Both commitments resolve immediately; otherwise the server fills missing choices at the deadline and starts the following round automatically. Polling, refresh, and duplicate commands never extend the window. The next online deadline begins when the server resolves the prior round, so playback and network delay can leave less than 20 seconds to select. Local practice starts its clock after the controls finish rendering; Pass & play starts a separate clock for each player after the private handoff. Startup durably caps a restored older combat window to at most 20 seconds remaining while preserving shorter deadlines and existing commitments. Existing in-progress duels retain their saved health; new duels use the longer pacing.

Only the winner can choose Spare, Kill or Let crowd decide after the winner reveal. A crowd ballot is a distinct 20-second window; its deadline is not the remainder of the winner's mercy timer. Living tournament spectators still in the lobby, including bots, are eligible; neither active duelist can vote. Human votes lock once cast and bots submit scheduled votes without receiving guest authentication tokens. The retained two-player online room has no spectators, so delegation ends in Spare after the crowd window. Practice and Pass & play simulate six crowd members.

Execution retires the character and a replacement begins with a new identity and zero wins. The accepted execution keeps the player's battle frame and the spectator's stands frame through playback. The defeated player alone receives Hades takes your soul., then the preserved arrival film and fresh replacement naming after acknowledged departure. A spared defeated player sees You live to fight another day! and keeps their attributes, appearance and record. In retained two-player rooms, both living players must ready for a rematch and equipment is selected again. Tournaments proceed through seven scheduled pairings, resetting health/stamina and selecting equipment for every match. A spared loser is eliminated from the current bracket and may watch or leave once the verdict resolves. Leaving an active room forfeits; a departing loser must await the mercy/crowd verdict before entering another room. A future tournament entrant who withdraws must likewise await their scheduled forfeit and verdict before reusing the identity elsewhere. These waits survive refresh.

Guest identity is stored in the browser under the unchanged `last-laurel.guest.v1` key. The service atomically saves character, room, and tournament state in `.local-data/online-duels.json` before acknowledging game changes; it stores hashes of guest bearer credentials. The session's persisted `activeTournament` resumes the current roster, match, and bracket after reload. Keep that file when restarting the service. Source/review files, tests, credentials, and this data directory are outside served paths. Browser storage loss does not provide cross-device account recovery.

## Verification and boundaries

`node --test tests/*.test.js` checks the current project tests without counting historical snapshot tests. The v0.8.4 root run passes 355 tests with zero failures, cancellations or skips; its log is artifacts/Recovery_Mercy_Validation_v001/npm-test.log. Coverage includes all 3,951 legal attribute allocations, meaningful weapon/armor/stat tradeoffs, bounded duels, combat/animation parity, authentication, hidden choices, duplicate/stale commands, durable restart, timeouts, disconnects, mercy/crowd authority and persistence, loser outcomes, rematches, and client recovery. Current browser proof is in artifacts/Recovery_Mercy_v001/VERIFICATION.json, covering creator/armory, both battle facings, winner-first reveal, crowd delegation and authenticated human/bot voting, majority Kill, native player/spectator execution, personal loser outcomes and automatic arrival replay to empty replacement naming. All 1,255 asset/media files match v0.8.3 in artifacts/Recovery_Mercy_Validation_v001/assets-preservation.json. Portable tests and sealed archive results are recorded in artifacts/Recovery_Mercy_v001/portable-test.log and RELEASE_RECEIPT.json. Browser receipts below establish their stated historical versions.

Browser verification used separate localhost/127.0.0.1 origins against one isolated QA service. It covered creation/joining, private equipment/actions, refresh after each commitment, matching resolved health/stamina, attack animation, a complete duel, mercy, two-player rematch, forfeit, delayed execution, and creating a zero-win replacement. A 390-pixel iframe checked the responsive creator and battle layout with no horizontal overflow (375 usable pixels after its scrollbar). The browser viewport override was ineffective; this is browser layout evidence, not real phone validation. Evidence lives in `artifacts/Online_Duels_v001/browser`.

The QA proxy in `artifacts/Online_Duels_v001/responsive-review.mjs` relaxes framing only for the local test fixture. The production service retains `frame-ancestors 'none'`. QA state is separate from `.local-data`.

The v0.6.1 onboarding/trait update passed 126 current tests, followed by 17 focused UI checks after final navigation changes. Browser checks covered blank-name validation, Enter/Continue, compact customization, renaming without losing choices, attribute redistribution, ten trait choices, sequential Pass & play names, saved survivor locks, and mode switching. A Berserker/Ironhide online turn produced identical health/stamina and matching payable costs for both guests. Desktop naming fit its viewport without vertical overflow, and a 390-pixel iframe creator had no horizontal overflow. Captures and the verification receipt are in `artifacts/Onboarding_v001`; source rollback copies are in `artifacts/Before_Onboarding_v001`.

The v0.6.2 battle update passed 85 combat/service/client/animation/presentation/UI checks. Controlled-clock cases cover the exact 20-second boundary, delayed browser callbacks, stale callbacks, render readiness, private handoffs, queued online updates, complete unskippable playback, and single win credit. Browser checks used the separate QA service and guest origins: missing online and practice moves became Recover; full playback opened subsequent rounds; a fresh duel reached knockout in round 9; mercy/rematch retained the fighters and records. The desktop core fit a 1280×720 viewport, and a 390×844 iframe had no horizontal overflow and kept its countdown above the two-by-two grid. Captures and the receipt are in `artifacts/Battle_UI_v001`; earlier UI source copies are in `artifacts/Before_Battle_UI_v001`. A broader concurrent run passed 157 of 160 tests; its three failures were in `preset-polish.test.js`, the separate face-polish candidate still in progress.

The v0.7.0 focused flow suite passes 49 checks across tournament authority, actual app integration, spectator views, arrival playback behavior, and armory interaction. The backend/legacy-online run passes 28 checks, and 17 checks execute the actual app builders and handlers with controlled browser/network fixtures. The [receipt](artifacts/Tournament_Flow_v001/TEST_RECEIPT.json) distinguishes these checks from local browser captures; the [final full-suite log](artifacts/Tournament_Flow_v001/full-test.log) records all 218 tests passing. The historical v010 chin test now selects that catalog explicitly for reproduction, while those historical catalogs remain preserved. The unified v0.8.0 renderer now uses v013 for new preset recipes and v006 for saved legacy identities.

The separate [local browser proof receipt](artifacts/Tournament_Flow_v001/BROWSER_RECEIPT.json) follows all seven sequential matches through Aster's championship and three duel wins, then automatic reentry for Aster and spared Mira with identical saved identities and records. [Captures](artifacts/Tournament_Flow_v001/browser) also cover desktop and 390-pixel layouts. This is live local browser/service evidence, not an eight-person external tournament, real-device multiplayer, public deployment, or visual acceptance by the user.

Eight-player brackets, automatic waiting-lobby placement, live tournament-member spectators and delegated crowd verdicts are implemented locally. Cosmetic remote reactions, cross-device recovery, multi-process storage, and public HTTPS hosting remain separate work. The current v0.8.4 flow includes exact v013 presets; saved legacy identities still use exact v006. Historical preparation packages remain preserved. Mercy/crowd source rollback copies are in `artifacts/Before_Mercy_Crowd_v001`, with prior documentation in `artifacts/Recovery_Mercy_v001/before-docs`; earlier tournament and duel rollback folders remain preserved.

