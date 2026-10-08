# Linked character creator port — v0.2

The user authorized reusing the D-PIXEL linked anime portrait/chibi creator in this browser game, including male/female selection and appearance customization. Subsequent direction requested HD pixel art and menus inspired by early-2000s handheld RPGs.

## Source and preservation

The accepted source is `C:/DPIXEL/v0.5.72_CommanderQuest_v001`, verified against D-PIXEL's current baseline. The linked avatar and equipment registries supply the actual runtime pixels. Exported files are a separate versioned collection at `assets/dpixel-avatar/v001`; the D-PIXEL artwork was not replaced or integrated with new art.

`tools/export-dpixel-avatar.py` reproduces the read-only extraction. `ArtReview/DPIXEL_Reuse_v001/browser_export_receipt.json` binds the native source packs/registries, checks decoded block CRCs, and records palette variant and PNG hashes. The exported manifest closes the roster of 856 lossless PNG atlases, approximately 20.5 MiB, loaded as needed. Existing source rights and generation-service terms remain attached; no new third-party license or public-domain status is asserted.

No private canon, story dialogue, or named JRPG cast was copied. The browser uses generic customizable fighters.

## Supported creator

- Male and female rigs share one normalized appearance structure with stable IDs.
- Nine hairstyle choices include bald; six skin tones, eight hair colors, eight eye colors, and classic/sharp eyes retain native palette pixels.
- Four facial-hair settings are available for the male rig. Switching to female hides facial hair while preserving the choice for a later switch back.
- Portrait and world/arena appearances derive from the same identity. Attributes do not stretch or reshape the source artwork.
- Creation freezes the surviving character's appearance and combat attributes. Execution unlocks a replacement; rematches preserve the survivor and allow new equipment.

The source's twelve portrait phases and four-direction idle/walking layers are retained in the manifest. The current interface displays static portraits, idle previews, and the native static battle pose. It does not implement a new attack animation set, mounts, or JRPG classes.

## Equipment and presentation

Cloth, leather, and plate bodies map to light, medium, and heavy armor. Native sword/shield imagery is used for sword loadouts. Spear and axe use separate original weapon overlays anchored to the source's hand registration. The arena mirrors the western source pose to face the opponent.

The new arena background was produced with the built-in Image Generation tool. `ArtReview/DPIXEL_Reuse_v001/generated_art_receipt.json` preserves its prompt and provenance. The earlier detailed cutout study is retained for review and is not used by the playable game. The selected creator direction supersedes the earlier detailed-figure production proposal in `REUSE_PLAN.md`.

The source prototype is preserved in `artifacts/Before_Linked_Avatar_v001`, with its original file hashes. Runtime files have no external JavaScript dependencies. Menus use local fonts, pixel borders, high-contrast selections, responsive layouts, and reduced-motion styling.

## Verification

The avatar renderer matches 34 independent native-source RGBA fixtures byte for byte, covering both rigs, multiple hairstyles, palette extremes, eyes, armor outfits, portraits, battle, and walking. Automated tests also cover facial-hair visibility, corrupt PNG rejection, straight alpha, safe markup, attachment coordinates, and metadata immutability. Existing combat simulations remain part of `node --test`.

Browser checks cover linked palette changes, sex switching, equipment portraits, a completed duel, executed-character replacement with survivor appearance locked, and narrow creator/arena layouts. The renderer blocks stale controls while asynchronous artwork loads, preserving private handoffs.

This remains a local duel prototype. Online rooms, tournament brackets, durable records, and combat animation are separate milestones.
