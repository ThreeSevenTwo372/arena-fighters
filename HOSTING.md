# Arena Fighters temporary hosting

## Published v0.14.1 — October 10, 2026

The existing [Arena Fighters page](https://www.blackbooktattoo.com/arena-fighters) now serves the sealed v0.14.1 release from [the existing Render host](https://blackbook-arena-fighters.onrender.com/). It includes complete first-person holds for all nine weapons, the inward-facing v004 axe, v5 choice-time combat and typed-name preservation. Spectators retain their original two-avatar view. The Free plan, temporary-session mode, manual deployment setting and Squarespace embed configuration remain unchanged.

Deployment `dep-db5904d9fdbs73c19s50` completed at 19:21:24 UTC from commit `08b4f7c0e5f93c9ab38f9d936bb3bfe9c3bbec8b` on `codex/temporary-sessions`. Source, sealed release, deployment candidate and Git index matched before publication. All 400 checked public files matched after publication, including all 335 first-person asset files. The published iframe displayed v0.14.1 and completed a first-person lesson round; the corrected axe was inspected directly on the public host. Publication evidence is separate in `artifacts/Live_Release_v0141_v001/VERIFICATION.json`; earlier snapshots and local evidence remain unchanged. Zero public tournaments were active before the deployment. Temporary sessions restarted under the existing hosting contract; localhost services and private saves were untouched.

The earlier release sections below describe their original dates.

## Release Readiness v001 — v0.10.0, October 9, 2026

The menu now offers **Learn to fight**, three optional coached rounds using the shared combat rules and exact current male/female avatars, and **Quick Duel**, the existing private two-player flow with a shareable invitation link. Lessons are disposable, untimed, repeatable and guest-free; they preserve an owned surviving fighter and keep the condensed creator unchanged. Invitation URLs carry a public code and mode only, prefill the matching join field and never auto-join, replace an active match, or carry authentication.

Later online rounds reserve a server-owned **four-second presentation interval**, followed by the full **20-second action window**. Early commands are rejected; bots act three seconds after opening. The final round reserves presentation before the five-second winner reveal and full mercy window. Clock boundaries survive refresh/restart in durable localhost mode; clients never choose their own deadlines.

Bots have stable **Aggressive, Cautious or Patient** styles, displayed in the roster and battle. They keep legal stats and equipment and use only resolved public information. Practice cycles these styles between duels. Styles grant no hidden-choice access or combat bonuses.

Tournament spectators can **Cheer, Applaud or Throw tomato**. Short effects stay inside each viewer's current battle/spectator frame without remounting playback. Three-second server cooldowns, six-second retention and a bounded 24-event room queue apply. Public reads create no guest or seat; first sending obtains an ordinary guest only. Current duelists receive effects but cannot send, and reactions grant no move, equipment, mercy or ballot authority. Reaction history is process RAM only even in durable localhost mode; command retries do not duplicate a throw.

The ninth weapon is **Trident & Net**, supplied through additive equipment overlay v015 with the exact v014 dagger entry retained. **Entangle** trades damage for a +3 stamina surcharge on the rival's Strike/Technique next round only. Guard reduces its damage, prevents the net and clears an existing net; Recover clears it when executed. Nets never stack and expire at the end of that next round, death, forfeit or duel completion. Exact command costs include the surcharge, while base equipment values and saved identities stay intact. The authored trident and offhand net follow existing grips; source catalogs, heads, bodies, hands, helmets and every prior asset remain preserved.

Only **Where the Stars Remember** remains active as music. Active manifest public/audio/soundtrack-v002/manifest.json contains no battle playlist or recorded victory cue. Menu/arrival continuity, mute, separate volume settings and hidden-page pause remain; procedural gameplay effects remain enabled. All v001 battle tracks, the old victory clip, original soundtrack sources and previous releases are preserved for the user's later song selection. Battles, their entrance and verdict sequences have no score music.

Free temporary hosting and session-scoped records remain the selected scope. Durable online progression, coins and unlocks remain separate milestones. This is a **local implementation and independent release**, not a publication claim. Current automated, browser, preservation, package and deployment evidence is recorded separately in artifacts/Release_Readiness_v001/VERIFICATION.json. The preserved rollback is releases/Arena_Fighters_v0.9.4_v001. Physical phone/public-network play and fresh human balance/art judgment remain distinct from automated and resized-browser proof.

## Preserved v0.9.4 documentation

v0.9.4 Arena Lobby Chat adds one shared conversation per tournament, available during the waiting lobby and match spectating, with the same conversation through equipment, entrance, battle and verdict presentation. Anonymous GET reads create no guest or seat; sending requires an ordinary guest bearer and lazily creates a guest without a fighter when needed. The server owns author labels and enforces 240 Unicode code points per message, a two-second send interval and ten messages per minute. Each room retains at most sixty messages from the past hour in process RAM. Chat is never written to the fighter store: it expires and resets on restart in both temporary hosting and persistent localhost modes. No additional service, database or billing change is required.

v0.9.3 introduced the DEICIDE/Suno menu theme during arrival and death replay, then kept it playing into the menu without restarting. That behavior retains the existing free Render service and temporary-session contract. One menu song, eleven full battle songs and the four-second victory cue are served as versioned local MP3 files; procedural effects run in the browser. Fresh visits make a best-effort audible autoplay attempt while respecting browser policy and saved mute; the first trusted interaction or Enable sound retries blocked playback. One song stays with each duel across rounds and spectator updates, preserved video elements remain muted, and hidden pages pause sound. Mute and separate music/effects volume use an independent sound-only browser preference key.

The user explicitly chose to keep hosting free on October 8, 2026. No paid plan, disk, database, billing change or persistent online progression was enabled. Durable localhost and its private saved data remain untouched. Current source/release/deployment status is in artifacts/Arena_Chat_v001/VERIFICATION.json; local packaging is not proof of public deployment. The independent v0.9.4 snapshot is releases/Arena_Fighters_v0.9.4_v001, and v0.9.3 Intro Theme is the rollback with its evidence in artifacts/Intro_Theme_v001. v0.9.2 Soundtrack and Sound Effects and earlier Dagger and Riposte evidence remain in artifacts/Soundtrack_v001 and artifacts/Weapon_Dagger_v001.

The v0.9.0 Pixel Menu and Memorial update retains this hosting contract. Public match browsing and the living leaderboard need no guest creation; private graveyard reads require the existing guest bearer. Browsing menus or spectating heartbeats an existing guest. Neither the leaderboard nor graves are permanent on this temporary deployment. Persisted online ownership/save storage is a separate planned milestone before coins and unlocks. Its release/deployment evidence remains in artifacts/Main_Menu_v001/VERIFICATION.json; historical v0.8.6 evidence below remains preserved.

The hosting release is based on v0.8.5's complete Roman Manuscript game. All art, media, combat, mercy/crowd behavior and legacy appearance recipes remain preserved. The independent v0.8.5 release is the rollback version.

## Session behavior

SESSION_MODE=temporary selects a fresh process-local MemoryStore. It neither reads nor writes .local-data/online-duels.json, even if a save file exists. The browser uses a separate last-laurel.temporary-guest.v1 key in sessionStorage; the durable localStorage key remains untouched. Refresh normally recovers the fighter within the same tab. Starting a fresh tab starts a separate guest; duplicated tabs can inherit tab storage. The full-page launch link uses noopener.

While a player is in online mode the open page heartbeats. Ninety seconds without a heartbeat expires the guest, removes their token/profile and resolves their departure for other players. A backgrounded mobile tab may stop its heartbeat and expire; returning then creates a new fighter. Short network interruptions can reconnect within that grace. An expired participant's necessary match/bracket snapshot remains only until the live contest no longer needs it. Unreferenced games are collected, with a brief leave-retry receipt window for still-present guests.

Server restart or redeployment loses all temporary fighters and games. Invalid old tokens recover to new naming, rather than resuming stale matches. If a browser blocks tab storage, the current visit still works using memory and displays a warning that refresh starts a new fighter.

Without SESSION_MODE, localhost retains the existing persistent behavior. No existing save data is migrated or deleted.

## Local verification

```powershell
$env:SESSION_MODE = 'temporary'
node server.mjs --port 4186
```

Use a separate PowerShell window for this command so the regular local launcher stays unchanged. Open http://127.0.0.1:4186/. /healthz confirms the mode. The server defaults to localhost; the host becomes 0.0.0.0 when a provider supplies PORT. A host/port CLI override still works.

## Render test deployment

The clean releases/Arena_Fighters_v0.8.6_v001 snapshot was uploaded to https://github.com/ThreeSevenTwo372/arena-fighters on branch codex/temporary-sessions at commit 6887db87b8cb5c943f3aa585c3535270e185f663. Private local data and historical work were excluded. The user made the repository public so Render could download it without a private Git-provider connection.

The live game is https://blackbook-arena-fighters.onrender.com/. Render service blackbook-arena-fighters (srv-db3s7gom7kps73fs9iqg) runs one Node 24 instance in Virginia on the Free plan in the user-confirmed My Workspace. Build command is node --check server.mjs and start command is node server.mjs. SESSION_MODE=temporary and EMBED_ORIGINS match render.yaml. No disk or database is needed. Automatic deploys are off, so a later repository push requires a deliberate manual deploy. The API-created service uses its default health-check configuration; /healthz was verified directly and reports temporary mode. The included Blueprint additionally specifies /healthz as the health check.

The server uses Render's RENDER_EXTERNAL_URL as its HTTPS public origin. Set PUBLIC_ORIGIN explicitly when adding a custom game domain; comma-separated exact origins are supported. Cross-site writes and forged proxy-origin headers remain rejected. Embedding permission applies only to the configured parent origins; it does not grant API access to those parents. Authenticated guests have individual poll quotas behind the proxy; unauthenticated guest starts retain a shared 30-per-minute socket quota for this small beta.

Free Render services can sleep after 15 idle minutes, take about one minute to wake, and restart at any time. This is a test deployment, with temporary games resetting on a restart. Avoid redeploying while players are in a tournament. Service/provider usage limits apply.

## Squarespace page

The published destination is https://www.blackbooktattoo.com/arena-fighters. It contains an HTML Code Block with the live game iframe and an Open Arena Fighters full screen link. Generate the exact snippet with:

```powershell
node tools/build-squarespace-embed.mjs https://blackbook-arena-fighters.onrender.com
```

The script writes a new versioned artifact under artifacts/Temporary_Sessions_v001. Paste it into an HTML Code Block on the Arena Fighters page with Display Source off. It provides the embedded game and an Open full screen link. Iframe support requires a qualifying Squarespace plan; on an unsupported plan use a normal Squarespace button linking to the actual live game URL. A full-page link also avoids third-party browser-storage restrictions.

The live API smoke passed 13 checks with all eight disposable QA guests withdrawn. Browser checks covered the published iframe, native complete-figure creator, normal eight-fighter bot lobby, refresh recovery to the same fighter/lobby, a fresh full-page visit, a live combat round, withdrawal, and a 390px phone-width page with no horizontal overflow. Details and screenshots are in artifacts/Temporary_Sessions_v001/VERIFICATION.json. These checks used one browser and API clients; two physical devices on different networks and a full human tournament remain separate user checks.

Documentation: https://render.com/docs/free, https://render.com/docs/environment-variables, https://support.squarespace.com/hc/en-us/articles/206543167-Code-blocks.
