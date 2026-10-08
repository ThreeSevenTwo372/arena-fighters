# Dark fantasy art and equipment — v0.4

The active character package is `assets/clean-gladiator/v003`, with the arena at `assets/arena/dark-arena-v001.png`. Worn steel, dark leather, muted cloth, solemn faces, and torchlit stone replace the brighter presentation while retaining the handheld pixel menus.

## Linked identity and equipment

Each of the nine hairstyle choices, including bald, has a complete registered head for both sexes and both portrait and chibi views. Face and hair are authored together to avoid fitting an unrelated hair overlay onto a head. The normalized appearance still selects six skin tones, eight hair colors, eight iris colors, Solemn or Intense expressions, and four male facial-hair settings. Facial hair hides on the female rig while its selection remains saved. Both views use the same appearance choices; a surviving character retains them.

Male and female light, medium, and heavy armor bodies share authored head, hand, and foot registration. Separate weapon images and glove overlays keep equipment attached to the hand. Menu weapons lean away from the face. Combat animation moves those registered layers rather than changing damage or character identity.

World heads use smaller skull proportions: the measured bald male and female alpha bounds are 28×32 and 29×34 pixels, against 70-pixel-high armor bodies. World helmets are 35 pixels high. These layers meet at the registered neck [96,86], with head/helmet pixels overlapping the collar rather than leaving a transparent gap. The world proportion correction changes geometry; portrait scale and the saved skin, hair, and iris palette choices remain unchanged. A file-backed regression check measures the actual PNG silhouettes and assembled collar coverage.

Head armor offers No Helmet, Closed Bascinet, Visored Barbute, and Greathelm. The three enclosed helmets conceal the full head in both views; selecting No Helmet restores the saved face and hairstyle. Helmets are cosmetic loadout choices selected before each new duel and fixed during that duel. Armor determines protection and stamina effects; helmet selection adds none.

## Weapon tradeoffs

All builds can equip any weapon before a duel. Costs below are base stamina costs; heavy armor adds one stamina to each attack. Ordinary Strike has priority 0.

| Weapon | Strike / technique cost | Technique | Counterplay and tradeoff |
| --- | --- | --- | --- |
| Sword | 3 / 4 | Feint, priority 0 | Bypasses Guard and half of armor. Affordable, reliable attacks with ordinary initiative. |
| Spear | 3 / 4 | Quick Thrust, priority +1 | Acts before ordinary attacks. Lower base power; Guard reduces its thrust. |
| Axe | 4 / 7 | Guard Break, priority −1 | Strong attacks and a costly Guard bypass. Low initiative; armor still protects. |
| Flail | 4 / 6 | Chain Sweep, priority 0 | Bypasses Guard with a swinging chain. Armor still protects; higher stamina cost and lower initiative than a sword. |
| Halberd | 4 / 5 | Hook Thrust, priority −1 | Only one quarter of armor protection applies. The committed move acts late and can be guarded. |
| Mace | 3 / 5 | Armor Crush, priority −1 | Ignores armor completely. Deliberate initiative and a technique that Guard can absorb. |
| Greatsword | 5 / 8 | Cleaving Arc, priority −1 | Highest ordinary attack power and a sweep through half of armor. Lowest weapon initiative, high stamina costs, and a Guard counter. |

These are prototype tuning values, not a claim of final competitive balance. Guard acts at priority +3 and reduces most attacks by 65%; Feint, Guard Break, and Chain Sweep bypass it. Recover acts at priority −2. Technique damage uses Might and Agility, while ordinary attacks favor Might.

Simple stepped animations provide flail chain follow-through, halberd thrust and hook, mace crush, and greatsword sweep alongside the existing cuts and chops. They are articulated idle artwork, rather than complete hand-drawn animation sheets. Playback reads resolved public events; canceled knockout responses do not animate. Skip and reduced-motion behavior preserve the same outcome.

## Production and preservation

The new raster artwork was produced with the built-in image generation tool. `ArtReview/Dark_Fantasy_v001` retains generated sources, production prompts, registration studies, and preparation receipts. Technical preparation crops alpha bounds, normalizes canvas registration, and records source/output hashes. The package does not assert a new stock-art license or public-domain status; existing project rights and generation terms still apply.

The native source project, `assets/dpixel-avatar/v001`, its renderer, and its comparison fixtures remain unchanged. Earlier `assets/clean-gladiator/v001` and `v002` packages remain available. The new appearance artwork preserves the established choice IDs without claiming pixel parity with those older heads. [AVATAR_PORT.md](AVATAR_PORT.md) and [CLEAN_ART.md](CLEAN_ART.md) document their historical implementations.

`artifacts/Before_Dark_Fantasy_v001` contains the pre-redesign UI/art files and their hashes. Its combat files may already include the newly added weapon data; it is not a complete rollback to the earlier three-weapon rules. Versioned art directories remain separate from this code snapshot.

## Scope and checks

Run `node --test` for native fixture, identity, equipment, combat, and animation checks. Combat coverage includes all 1,764 legal allocation/weapon/armor/trait builds, Guard and armor counters, hidden-choice isolation, and equivalent outcomes for every cosmetic helmet. Browser results and screenshots are separate runtime evidence.

The final local run passed all 48 tests. Browser verification exercised all seven weapon selections, all four head-armor selections, restored uncovered identities, and the articulated flail attack with no console errors. The corrected v0.4 arena was opened in a visible new tab; the user's earlier v0.3 duel was preserved. `artifacts/dark-arena-corrected-v04.jpg` records the corrected live preview. `ArtReview/Dark_Fantasy_v001/RELEASE_RECEIPT.json` seals the 71 texture files, two catalogs, preserved source atlases, arena, and validation result. `PROMPTS.json` contains the built-in image-generation prompt set.

This remains a local CPU or two-player pass-and-play duel prototype. It does not implement online rooms, remote spectators, durable character records, or the planned 2–8 player tournament. Character and duel records last only for the current browser session.
