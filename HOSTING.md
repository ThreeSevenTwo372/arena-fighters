# Arena Fighters temporary hosting

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

Use the clean releases/Arena_Fighters_v0.8.6_v001 snapshot as the repository root, excluding private local data and historical work. Connect that private Git repository to Render. Run one Node web-service instance in Virginia on the Free plan, with build command node --check server.mjs and start command node server.mjs. Set SESSION_MODE=temporary and EMBED_ORIGINS to the origins in render.yaml. No disk or database is needed. The included Blueprint describes the same settings.

The server uses Render's RENDER_EXTERNAL_URL as its HTTPS public origin. Set PUBLIC_ORIGIN explicitly when adding a custom game domain; comma-separated exact origins are supported. Cross-site writes and forged proxy-origin headers remain rejected. Embedding permission applies only to the configured parent origins; it does not grant API access to those parents. Authenticated guests have individual poll quotas behind the proxy; unauthenticated guest starts retain a shared 30-per-minute socket quota for this small beta.

Free Render services can sleep after 15 idle minutes, take about one minute to wake, and restart at any time. This is a test deployment, with temporary games resetting on a restart. Avoid redeploying while players are in a tournament. Service/provider usage limits apply.

## Squarespace page

The destination is https://www.blackbooktattoo.com/arena-fighters. After Render supplies the actual live URL, generate the Code Block snippet:

```powershell
node tools/build-squarespace-embed.mjs https://ACTUAL-SERVICE.onrender.com
```

The script writes a new versioned artifact under artifacts/Temporary_Sessions_v001. Paste it into an HTML Code Block on the Arena Fighters page with Display Source off. It provides the embedded game and an Open full screen link. Iframe support requires a qualifying Squarespace plan; on an unsupported plan use a normal Squarespace button linking to the actual live game URL. A full-page link also avoids third-party browser-storage restrictions.

Verify the public page signed out, the game on desktop and narrow screens, and two real devices on different networks. Confirm refresh recovery, different fighters per fresh tab/device, departing-player forfeit, survivor reentry, mercy/crowd/execution, and server-restart recovery. Local/API fixtures are not public-network proof.

Documentation: https://render.com/docs/free, https://render.com/docs/environment-variables, https://support.squarespace.com/hc/en-us/articles/206543167-Code-blocks.
