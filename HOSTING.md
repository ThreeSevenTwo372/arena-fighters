# Arena Fighters temporary hosting

The v0.9.0 Pixel Menu and Memorial update retains this hosting contract. Public match browsing and the living leaderboard need no guest creation; private graveyard reads require the existing guest bearer. Browsing menus or spectating heartbeats an existing guest. Neither the leaderboard nor graves are permanent on this temporary deployment. Persisted online ownership/save storage is a separate planned milestone before coins and unlocks. Current release/deployment evidence is in artifacts/Main_Menu_v001/VERIFICATION.json; historical v0.8.6 evidence below remains preserved.

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
