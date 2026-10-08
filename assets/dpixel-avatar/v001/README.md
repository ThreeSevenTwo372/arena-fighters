# D-PIXEL linked avatar browser layer export

This versioned library contains exact decoded pixels from the source-selected
linked-avatar and linked-equipment stores in the accepted CommanderQuest build.
The user authorized this local cross-project character-creator migration.

The browser selects independent appearance layers rather than loading the native
228 MB avatar pack or downloading pre-rendered character combinations. Each PNG
is a lossless RGBA8, noninterlaced palette strip; a `variants` rectangle selects
the exact source pixels for the chosen skin, hair, or eye palette. Images are
intended to load lazily for the current appearance.

The supported appearance choices are male/female, nine hair choices including
bald, six skin palettes, eight hair palettes, eight iris palettes, classic/sharp
eye shapes, and four beard choices. The source ignores beard rendering for the
female preset. Portraits retain all twelve expression phases. World idle and
four-frame walking poses retain their four native directions. Battle poses are
static and W-facing; they are not a new attack animation set.

`manifest.json` contains the original appearance structures and placement
commands. `avatar.layers[id]` and `equipment.assets[id]` contain image URLs,
dimensions, three material-axis flags (skin, hair, iris), and palette rectangles.
Variants use the original active-axis index order. Avatar commands referencing
the original outfit/world bodies are marked `externalBodyPlaceholder`; the
equipment composition replaces those passes. Source `seated_idle` metadata is
retained for provenance, but it describes a mounted pose and is not a supported
gladiator preview action. Mount images and JRPG class collections are excluded.

Equipment bodies are kept separate from weapons and shields. Arena armor aliases
are cloth → plain, leather → Bow, plate → SwordShield. Greatsword body frames are
also preserved as an optional stance. The browser can omit source held gear and
draw the game's separate sword, spear, or axe without a baked duplicate weapon.

The extraction receipt is `ArtReview/DPIXEL_Reuse_v001/browser_export_receipt.json`.
It binds both entire native packs and registries by SHA256, verifies every used
decoded block's CRC32, records per-variant hashes, and confirms each exported PNG
rectangle reproduces the original RGBA bytes, including transparent RGB.
`tools/export-dpixel-avatar.py` performs the read-only source extraction and
rejects overwriting different output in an existing version directory.

Source provenance identifies project-specific supplied and generated artwork.
Existing source rights and applicable generation-service terms remain attached
to the respective inputs. This migration grants no new third-party license and
does not declare the art public domain. No confidential canon, story dialogue,
provider prompts, or source-project changes are included.
