# Current Arena Fighters version

## Anchored First-person Motion v001 — v0.14.2, October 10, 2026

Current local source is **v0.14.2**. Complete arm-and-weapon poses now pivot near their forearm roots and extend beyond the viewport so their cropped sleeve ends remain hidden throughout motion. Sword cuts, axe/mace chops, flail swings, spear/trident thrusts, dagger thrusts and two-handed attacks have separate windup, contact and recovery paths. Guard, Focus, recoil, execution and reduced motion retain the same connected holds. Source artwork, authored grips, frame registration and rival/spectator avatars remain exact; the inward-facing v004 axe remains active.

The disposable `/?first-person-art-review=1` controls now include an attack-frame inspector using the actual renderer. Attack duration remains 665 ms with contact at 43%; combat clocks, resolved-event playback, saved identities, name drafts and verdict authority are unchanged. The independent snapshot is `releases/Arena_Fighters_v0.14.2_v001`; local verification is `artifacts/First_Person_Motion_v001/VERIFICATION.json`. V0.14.1 and all earlier releases remain preserved. This snapshot is local; the published game remains v0.14.1 pending separate deployment verification. Automated checks and internal browser review do not establish user art acceptance.

## Historical v0.14.1

## Axe Facing Correction v001 — v0.14.1, October 10, 2026

Current local source is **v0.14.1**. The first-person axe's cutting edge now faces inward toward the rival, with its blunt poll facing outward. The additive v004 axe overlay retains the complete arm, grip, shaft and original shield across all three armor versions and six skin tones. Other held poses retain their exact v003 paths; explicit v003 remains available as the prior axe comparison.

The independent local snapshot is `releases/Arena_Fighters_v0.14.1_v001`; evidence is separate in `artifacts/First_Person_Axe_Direction_v001/VERIFICATION.json`. Original and generated sources, prompts and bounded preparation receipts are preserved in `ArtReview/First_Person_Axe_Direction_v001`. V0.14.0 and all earlier releases remain preserved. The axe correction changes no combat rules, saved identity or verdict authority.

**Published October 10, 2026:** v0.14.1 is live at https://www.blackbooktattoo.com/arena-fighters through the existing free temporary-session Render service. Commit `08b4f7c0e5f93c9ab38f9d936bb3bfe9c3bbec8b`, deploy `dep-db5904d9fdbs73c19s50`, completed at 19:21:24 UTC. Separate publication evidence in `artifacts/Live_Release_v0141_v001/VERIFICATION.json` records 400 exact public file comparisons, the website's v0.14.1 menu, a first-person combat round and the live corrected axe. Earlier local evidence and sealed snapshots remain unchanged; historical unpublished notes below describe their original verification dates.

## Historical v0.14.0

## Complete First-person Holds v001 — v0.14.0, October 10, 2026

Current local source is **v0.14.0**. Every first-person weapon pose is drawn with its arms, hands, sleeves and held equipment together in one original source. The v003 catalog preserves those complete grips, six skin palettes and three authored armor versions for all nine weapons. One-handed moves animate the complete arm and held object; greatsword and halberd animate one image containing both arms and the continuous weapon. Palette changes preserve the finished pose, and source foreshortening supplies depth. Rival and spectator identities remain exact; typed names still survive mode switches.

New duels retain the v5 rules below. Raw sources, prompts, explicit skin masks and preparation receipts are in `ArtReview/First_Person_Whole_v001`. The independent local snapshot is `releases/Arena_Fighters_v0.14.0_v001`; verification is separate in `artifacts/First_Person_Whole_v001/VERIFICATION.json`. V0.13.0, its modular v002 artwork and earlier releases remain preserved. This revision has not been published. Internal source and browser checks do not establish user art acceptance.

## Historical v0.13.0

## HD First-person Art v001 — v0.13.0, October 10, 2026

Current local source is **v0.13.0**. Playable battles use the versioned `assets/first-person/v002` pixel parts: six skin palettes, three armor cuffs, all nine foreshortened weapons, an angled shield and a hanging net. A broad near grip, receding weapon silhouette and smaller far hand establish depth. Fingers draw over their registered handle; two-handed hands and weapon move together. The exact rival identity and spectator renderer remain intact. Typed names survive switching play modes, including the optional second-player name.

New duels retain the v5 four-attribute and server-owned choice-time rules documented in [FIRST_PERSON_COMBAT.md](FIRST_PERSON_COMBAT.md). Active v3/v4 duels, private choices, saved identities, menu-only music and mercy/crowd authority remain unchanged.

The independent local snapshot is `releases/Arena_Fighters_v0.13.0_v001`; v0.12.0 and earlier releases remain preserved. Separate source, raster, browser, preservation and portable checks are recorded in `artifacts/First_Person_HD_v001/VERIFICATION.json`. Raw artwork and source preparation are preserved in `ArtReview/First_Person_HD_v001`. This revision has not been published. Automated and browser checks do not imply human art acceptance or physical-phone/public-network proof.

## Historical v0.12.0

## First-person Combat v001 — v0.12.0, October 10, 2026

Current local source is **v0.12.0**. Playable battles and the three optional lessons now use visible first-person hands and equipment, short public-event animations and the exact existing rival avatar. Spectators retain the two-avatar stands view. New duels use **v5**: four attributes, with faster accepted choices determining initiative at equal move priority. Guard/Riposte priority remains. Active v3/v4 duels finish unchanged; saved five-stat identities remain preserved.

October 10 local follow-up: typed names now survive switching Online duel, Practice and Pass & play, including an entered second-player name. Focused verification is in `artifacts/Name_Mode_Preservation_v001/VERIFICATION.json`. The sealed v0.12.0 snapshot below preserves the original first-person milestone before this source follow-up.

The independent local snapshot is `releases/Arena_Fighters_v0.12.0_v001`, with v0.11.0 preserved as rollback. Verification is separate in `artifacts/First_Person_v001/VERIFICATION.json`. This revision has not been published. See [FIRST_PERSON_COMBAT.md](FIRST_PERSON_COMBAT.md) for the exact timing, saved-stat and presentation contracts.

## Historical v0.11.0 and earlier

The notes below describe their original versions. The v5 contract above governs new duels.

## Stamina and Focus v001 — v0.11.0, October 9, 2026

Current local source is **v0.11.0, Stamina and Focus v001**. New duels use **combat rules v4**. The published game remains **v0.10.1**; this local revision has not been published. The independent snapshot location is `releases/Arena_Fighters_v0.11.0_v001`, with v0.10.1 preserved as rollback. Source, browser, package and deployment evidence are recorded separately in `artifacts/Stamina_Focus_v001/VERIFICATION.json`.

After both moves resolve, each living fighter automatically restores `max(1, 2 + floor(Dexterity / 8) + trait adjustment)` stamina, capped at their maximum, before the round-limit tiebreak. Base recovery is 2 at Dexterity 0–7 and 3 at Dexterity 8; Vigorous adds 1 and Ironhide subtracts 1. Speed improves initiative and discounts attack costs by `floor(Speed / 4)`, with minimum Strike cost 2 and Technique cost 3.

The fourth command is **Focus**: zero stamina, priority −2, and +3 raw attack power before defenses on the next round's Strike or Weapon Technique, including a triggered Riposte counter. It leaves the fighter open, never stacks, expires after that next round if unused, and clears Entangle when executed. A missed choice defaults to Focus in v4.

Active **v3** matches retain Recover, their old stamina behavior and already acknowledged choices through completion. Their rules are not converted mid-match; newly created duels use v4. The three optional coached lessons now teach Guard against Strike, sword Feint against Guard, and Focus against Riposte, with actual passive restoration and the queued bonus shown.

Menu-only music, intro-caption removal, saved identities, exact artwork, private choices, records and verdict authority carry forward. Free temporary hosting remains selected; existing durable localhost/private saves remain protected.

## Historical release notes — v0.10.1 and earlier

The notes below describe their recorded versions. Earlier Recover behavior and release/publication claims do not override the current local v4 contract above.


### Intro Caption Removal — v0.10.1, October 9, 2026

Current local source is **v0.10.1, Intro Caption Removal**. The opening caption beneath the arrival film has been removed. This release carries forward all v0.10.0 additions, menu-only music and the preserved film, playback controls, character artwork and combat rules.

The independent snapshot is `releases/Arena_Fighters_v0.10.1_v001`; `releases/Arena_Fighters_v0.10.0_v001` remains the preserved rollback. Source, portable-package and publication evidence are recorded separately in `artifacts/Live_Release_v0101_v001/VERIFICATION.json`. Packaging alone does not establish publication. Free temporary hosting remains the selected scope, and existing private saves remain protected.

### Preserved v0.10.0 release notes

### Release Readiness v001 — v0.10.0, October 9, 2026

The menu now offers **Learn to fight**, three optional coached rounds using the shared combat rules and exact current male/female avatars, and **Quick Duel**, the existing private two-player flow with a shareable invitation link. Lessons are disposable, untimed, repeatable and guest-free; they preserve an owned surviving fighter and keep the condensed creator unchanged. Invitation URLs carry a public code and mode only, prefill the matching join field and never auto-join, replace an active match, or carry authentication.

Later online rounds reserve a server-owned **four-second presentation interval**, followed by the full **20-second action window**. Early commands are rejected; bots act three seconds after opening. The final round reserves presentation before the five-second winner reveal and full mercy window. Clock boundaries survive refresh/restart in durable localhost mode; clients never choose their own deadlines.

Bots have stable **Aggressive, Cautious or Patient** styles, displayed in the roster and battle. They keep legal stats and equipment and use only resolved public information. Practice cycles these styles between duels. Styles grant no hidden-choice access or combat bonuses.

Tournament spectators can **Cheer, Applaud or Throw tomato**. Short effects stay inside each viewer's current battle/spectator frame without remounting playback. Three-second server cooldowns, six-second retention and a bounded 24-event room queue apply. Public reads create no guest or seat; first sending obtains an ordinary guest only. Current duelists receive effects but cannot send, and reactions grant no move, equipment, mercy or ballot authority. Reaction history is process RAM only even in durable localhost mode; command retries do not duplicate a throw.

The ninth weapon is **Trident & Net**, supplied through additive equipment overlay v015 with the exact v014 dagger entry retained. **Entangle** trades damage for a +3 stamina surcharge on the rival's Strike/Technique next round only. Guard reduces its damage, prevents the net and clears an existing net; Recover clears it when executed. Nets never stack and expire at the end of that next round, death, forfeit or duel completion. Exact command costs include the surcharge, while base equipment values and saved identities stay intact. The authored trident and offhand net follow existing grips; source catalogs, heads, bodies, hands, helmets and every prior asset remain preserved.

Only **Where the Stars Remember** remains active as music. Active manifest public/audio/soundtrack-v002/manifest.json contains no battle playlist or recorded victory cue. Menu/arrival continuity, mute, separate volume settings and hidden-page pause remain; procedural gameplay effects remain enabled. All v001 battle tracks, the old victory clip, original soundtrack sources and previous releases are preserved for the user's later song selection. Battles, their entrance and verdict sequences have no score music.

Free temporary hosting and session-scoped records remain the selected scope. Durable online progression, coins and unlocks remain separate milestones. This is a **local implementation and independent release**, not a publication claim. Current automated, browser, preservation, package and deployment evidence is recorded separately in artifacts/Release_Readiness_v001/VERIFICATION.json. The preserved rollback is releases/Arena_Fighters_v0.9.4_v001. Physical phone/public-network play and fresh human balance/art judgment remain distinct from automated and resized-browser proof.

### Preserved v0.9.4 documentation

Current local source: **0.9.4, Arena Lobby Chat v001**, October 8, 2026.

Each tournament has one shared **Arena lobby chat**, available while its lobby fills and while players watch the match. The same conversation remains available through loadout, entrance, battle and verdict presentation; it preserves the player's open/closed choice, and a first view as an active duelist starts collapsed. Its separate DOM host preserves drafts and focus across game polls and resolved animations. Departing, starting local play, or entering the defeated player's outcome/arrival sequence hides the chat.

Reading the public chat creates no guest, fighter or tournament seat. A first send creates only an ordinary guest session. The server supplies a tournament member's actual fighter name or a numbered Spectator label, accepts plain text up to 240 Unicode code points, and enforces two seconds between messages and ten messages per minute. Commands retain their exact ID and text across retries. Up to sixty recent messages per room are kept for one hour in RAM; chat history expires and is lost on restart in both temporary hosting and durable localhost modes. It never enters the fighter save file or changes combat, ballot, verdict or record authority.

The independent snapshot is releases/Arena_Fighters_v0.9.4_v001; releases/Arena_Fighters_v0.9.3_v001 is the rollback. Source, preservation, browser and deployment status are recorded separately in artifacts/Arena_Chat_v001/VERIFICATION.json. Packaging or local tests alone do not establish that v0.9.4 is deployed. Free hosting, temporary tab sessions, protected private saves, exact character assets and the v0.9.3 intro/menu soundtrack remain unchanged.

Previous local source: **0.9.3, Intro Theme v001**, October 8, 2026.

**Where the Stars Remember** is requested as the sky-to-arena arrival begins, and the same playing menu theme continues into the menu without restarting. Death-replay arrival uses the same theme. Fresh visits make a best-effort audible autoplay attempt; when browser policy requires an interaction, the first trusted game interaction or **Enable sound** retries playback. Saved mute is respected, and hidden pages continue to pause sound. The video elements remain muted, and every existing soundtrack, cinematic and artwork file is unchanged.

The existing shuffled eleven-song battle playlist, four-second victory cue, public-event effects, separate music/effects volume and sound-only browser preference storage remain intact. Audio has no authority over combat, private choices, saved identities, guest authentication, records or verdicts. Hosting remains free with temporary RAM/tab sessions; durable online progression remains deferred.

The independent snapshot is releases/Arena_Fighters_v0.9.3_v001; releases/Arena_Fighters_v0.9.2_v001 is the rollback. Source, preservation, browser and deployment evidence is recorded separately in artifacts/Intro_Theme_v001/VERIFICATION.json. Preparation and v0.9.2 soundtrack evidence remain preserved in artifacts/Soundtrack_v001.

Previous local source: **0.9.2, Soundtrack and Sound Effects v001**, October 8, 2026.

The downloaded DEICIDE/Suno menu song, **Where the Stars Remember**, accompanies the menu, records, creator, equipment and waiting lobbies. Eleven full-length battle songs are shuffled without an immediate repeat; one song is selected for each distinct duel and retained across rounds, private action handoffs, spectator updates, mercy and execution. The selected song loops if needed. A four-second **Victory Noise** cue plays once for a fresh winner reveal. Simple procedural effects accompany interface confirmation, round reveal, weapon swing, hit, parry, Guard, Recover, defeat and the confirmed execution impact. Effects follow resolved public presentation events and never inspect hidden choices or resolve gameplay.

Sound starts through a user gesture. A persistent sound panel provides mute plus separate music/effects volume, including a retry when playback is unavailable. Only those sound preferences are stored in the separate arena-fighters.audio.v1 browser key; guest authentication, fighter identity and private saved data retain their existing storage contracts. Arrival and death-replay films stay silent, preserved videos remain muted, and hidden pages pause music and effects. Prepared copies and provenance are versioned in public/audio/soundtrack-v001; the original soundtrack library remains read-only.

The independent snapshot is releases/Arena_Fighters_v0.9.2_v001; releases/Arena_Fighters_v0.9.1_v001 is the rollback. Source, media, browser and deployment evidence is recorded separately in artifacts/Soundtrack_v001/VERIFICATION.json. Free RAM/tab-session hosting remains unchanged. Persistent online saves, lasting coins, unlocks and betting remain deferred; more strategic weapons and worn equipment remain planned in DESIGN.md. Audio is local presentation and does not change combat, saved appearances, authentication, records or verdict authority.

Previous local source: **0.9.1, Dagger and Riposte v001**, October 8, 2026.

The eighth weapon is a fast Roman dagger with the conditional Riposte technique. It readies before ordinary attacks, spends its stamina immediately, halves only an incoming Strike after armor, and counters once if the dagger fighter survives. Any weapon technique bypasses the stance; Guard, Recover, or another Riposte gives it no opening. The counter uses full enemy armor and the displayed conditional damage; it does not spend stamina twice. Public-state-only bots can use the dagger, and public observers see only authoritative revealed parries and counters. All seven earlier weapon rules remain exact. New equipment is supplied through an additive versioned catalog shared by the exact v013 and v006 identity renderers; prior artwork, source frames, appearances and saved IDs remain preserved.

The independent snapshot is releases/Arena_Fighters_v0.9.1_v001; releases/Arena_Fighters_v0.9.0_v001 is the rollback. Test, preservation, browser and deployment evidence is recorded separately in artifacts/Weapon_Dagger_v001/VERIFICATION.json. The user chose to keep hosting free, so live RAM/tab sessions remain temporary. Persistent online saves, lasting coins, unlocks and betting remain deferred until a durable hosting budget is chosen. More weapons, worn equipment and soundtrack remain separate milestones.

Previous local source: **0.9.0, Pixel Menu and Memorial v001**, October 8, 2026.

The preserved sky-to-arena arrival now leads to the main menu. Its background is the exact final decoded frame of the playable film (frame 479, 19.958333 seconds), preserved in public/cinematics/menu-v001 with its preparation receipt. The menu uses original integer-size bitmap lettering, crisp command panels and a bronze/bone/red palette inspired by early-2000s GBA games in a Roman gladiator setting. FIGHT resumes an active tournament or enters the existing fighter creator; SPECTATE browses public tournaments without taking a fighter seat; LEADERBOARD ranks living human fighters by total duel wins with tournament titles separate. Graveyard lists the authenticated guest's executed fighters, each archived once with their saved identity, final record, death time and opponent. Replacement does not erase earlier graves. Public observers receive only public equipment and revealed moves and cannot vote or control a duel.

Live temporary mode still resets on restart and guest expiry; its leaderboard and graves explicitly describe that limitation. Durable localhost saves retain their behavior, and the new archive survives restart there. Earlier deaths which were never archived cannot be reconstructed. Coins, betting, unlocks, additional equipment and soundtrack remain planned in DESIGN.md; this release does not implement them. Existing artwork, media, faces, registration, battle rules, mercy and execution remain preserved. The independent release is releases/Arena_Fighters_v0.9.0_v001; v0.8.6 is the rollback. Local/browser/deployment evidence is recorded separately in artifacts/Main_Menu_v001/VERIFICATION.json.

The temporary hosting mode uses RAM-only multiplayer state and tab-scoped guest identities, with refresh recovery and 90-second departure expiry. It adds hosting PORT/HTTPS configuration, restricted Squarespace embedding and a public health check. Local saved-fighter mode remains the default. The v0.8.5 Roman Manuscript game, artwork and media remain preserved; releases/Arena_Fighters_v0.8.5_v001 is the rollback snapshot. Hosting instructions are in HOSTING.md. Publication status and verification are recorded separately in artifacts/Temporary_Sessions_v001/VERIFICATION.json; a packaged release or local test does not establish a public deployment.

The main local entry is http://127.0.0.1:4173/; run Start-Prototype.ps1 or node server.mjs. The independent current snapshot is releases/Arena_Fighters_v0.9.4_v001. Intro Theme, Soundtrack and Sound Effects, Dagger and Riposte, Pixel Menu and Memorial, Temporary Sessions, Roman Manuscript and Mercy and Crowd snapshots remain preserved at v0.9.3, v0.9.2, v0.9.1, v0.9.0, v0.8.6, v0.8.5 and v0.8.4. Earlier preview ports and review packages remain historical evidence.

Roman Manuscript v001 adds warm parchment pages, Palatino/Georgia serif type, red rubric headings and actions, fine ruled borders, and restrained laurel ornament through src/roman-manuscript.css, loaded after all scene styles. Naming, the compact creator, equipment annotations, tournament registers/brackets, battle commands, and mercy/crowd controls share that presentation. The existing illustrated scenes and media remain preserved. The theme does not change gameplay, source artwork, v013/v006 dispatch, complete figure dimensions, equipment/animation registration, saved identities, authentication or verdict authority.

| Contributing chat | Current contribution |
| --- | --- |
| Find OpenAI GPT game contest — 01a11826-edeb-77d2-86e0-af8f89dbd85d | v013 face presets; original-source female reduction, grouped male/female seating, source-traced features, replacement-helmet fit |
| Work on other game aspects — 01a1192b-02a1-7232-89d7-b5fbed362a03 | Private online choices, five attributes, ten traits, concise naming/creator flow, automatic full battle animations and 20-second choices |
| Create Colosseum Storyboards — 01a11940-8bdc-7dd3-ac11-3f132ca03c86 | Preserved newer Flux sky-to-arena opening and accepted gate-opening film |
| Add arena-seat spectator framing — 01a11964-3a05-7fb0-9393-0b01e1324cd7 | Full arena presentation, elevated tier rows, larger crowd, hair-over-cloak correction, spectator-rows-v004 |
| Add arena opening and gear selection — 01a119ac-a759-77e1-bd7c-2ed1535c4a4c | Eight-avatar lobby, lowered grounded lobby figure, shared gate, weapon rack, armor displays, sequential seven-match tournament, surviving character reentry |
| Unify latest game changes — 01a11a24-3d35-7ff2-8bd7-9c2710053b32 | Normal-flow v013 creator, preset arrows beside the selected whole figure, default 05, no eye-color picker, timed Roman-inspired lobby bots, confirmed pixel execution playback, legacy survivor parity, shared rendering, diagnostic recovery fix, narrow HUD separation, versioned v0.8.3 snapshot; subsequent mercy/crowd and loser-outcome draft recovered from the stalled chat |
| Continue game changes here — 01a11c00-f3f0-7690-8dc5-c6e26bab51e3 | Continues the recovered mercy/crowd draft, preserves the original work and prior release, verifies current source and browser behavior, and seals the v0.8.4 Mercy and Crowd snapshot |
| Roman Manuscript UI — 01a11c14-6d06-7892-a24c-8adaa4a7ed66 | Ancient Roman literature/book-inspired parchment, serif, rubric and laurel presentation in a final shared stylesheet; versioned rollback and independent asset preservation audit; desktop and 320-pixel browser checks, resolved attack playback and exact-renderer verdict specimens verified |

The latest character candidate is now selected for new fighters by the user's express instruction in the unification chat. Saved appearance IDs, legacy identities, raw artwork and prior packages remain preserved. The release applies the existing v013 geometry exactly once; it adds no artwork resampling, redraw, neck paint or generation. No additional paid media work or public publication was done.

The winner reveal precedes a full 20-second MERCY? window with Spare, Kill and Let crowd decide. Online matches use a five-second winner reveal; Practice and Pass & play use one second. Delegation opens a distinct 20-second crowd ballot. Living tournament spectators who remain in the lobby can cast one vote, including paced votes from spectator bots; the active pair cannot vote. Only a Kill majority executes, with ties and no votes resolving to Spare. The retained two-player online route has no eligible spectators; local modes use a simulated six-member crowd.

Execution still uses the selected weapon, recorded grip, procedural red pixels, collapse and aftermath. It plays once after an accepted Kill verdict inside each viewer's existing battle or spectator scene, retaining the resolved match while newer snapshots queue. Reduced motion uses a short static cue. The defeated player alone receives the outcome overlay: You live to fight another day! for Spare, or Hades takes your soul. for Kill. Death recovery acknowledges departure, preserves the final record, replays the preserved arrival film and returns to fresh replacement naming. Saved bearer authentication, living identities and records retain their existing contracts. Prior artwork, sources and release directories remain preserved.

Roman manuscript final root suite: **356 passing, zero failures, cancellations or skips**, recorded in artifacts/Roman_Manuscript_UI_v001/final-test.log. The exact package test script ran directly with node --test tests/*.test.js because npm is unavailable in the current shell. The independent preservation receipt artifacts/Roman_Manuscript_UI_v001/asset-preservation.json verifies all **1,255 asset/media files and 48,307,554 bytes are SHA-256 identical to the sealed v0.8.4 snapshot**, with no added, removed or changed files. Rollback copies are in artifacts/Roman_Manuscript_UI_v001/before. Browser verification is recorded in artifacts/Roman_Manuscript_UI_v001/VERIFICATION.json, with actual creator, lobby, armory, both arena facings, player and spectator attack playback, and 320-pixel layout captures. Mercy/crowd and spared-overlay presentation was inspected using exact current renderer outputs in a static diagnostic specimen; verdict behavior remains covered by the full suite and preserved v0.8.4 integration evidence. Human art acceptance remains separate. The snapshot manifest and artifacts/Roman_Manuscript_UI_v001/RELEASE_RECEIPT.json record independent file hashes, portable test scope and archive verification.

The sealed v0.8.4 evidence remains preserved: its full root suite recorded **355 passing, zero failures, cancellations or skips** in artifacts/Recovery_Mercy_Validation_v001/npm-test.log. Its browser evidence is in artifacts/Recovery_Mercy_v001/VERIFICATION.json: creator/armory, both battle facings, winner reveal, crowd delegation and voting, majority Kill, native battle/spectator execution, loser overlays and automatic arrival replay to empty replacement naming. Its portable test count, ZIP SHA-256 and source/snapshot/archive parity are recorded in artifacts/Recovery_Mercy_v001/RELEASE_RECEIPT.json, with the portable run in artifacts/Recovery_Mercy_v001/portable-test.log. All **1,255 asset and media files were byte-identical to v0.8.3**, as independently verified in artifacts/Recovery_Mercy_Validation_v001/assets-preservation.json. Disposable local fixtures do not establish eight physical devices, public-network operation, or full-roster human art acceptance. artifacts/Execution_v001/VERIFICATION.json retains prior v0.8.3 execution evidence; bot-fill, preset-arrow and unified-flow proofs remain in their prior artifact folders. Source provenance and preparation evidence remain in their versioned ArtReview folders. Tests that require that historical evidence are retained in the root and explicitly excluded from the portable release test scope. Source rollback copies are in artifacts/Before_Mercy_Crowd_v001 and that continuation's previous docs are in artifacts/Recovery_Mercy_v001/before-docs.
