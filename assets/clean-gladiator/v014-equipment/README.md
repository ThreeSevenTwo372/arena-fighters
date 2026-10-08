# Dagger equipment overlay v001

One original hand-authored Roman pugio joins the existing weapon registry. The
lossless 16 × 36 texture uses grip `[7,29]`, an upward blade and source facing W.
Its leaf blade, center ridge, bronze guard/pommel and leather wrap use literal
owned palette cells. No existing image was edited, resized or generated.

`dagger.source.json` is the authored pixel source. `prepare-dagger.mjs` emits
the matching integer-cell SVG, exact RGBA PNG and preparation receipt. Re-running
it permits only missing or byte-identical output and refuses changed artwork.

The optional manifest merges into the current v013 preset and v006 survivor
renderers through `src/current-avatar.js`. Both historical source manifests
remain valid on their own with their original seven weapons. New equipment
cannot replace a preserved weapon or use an external texture location.

The existing six bodies, all hand grips, identity/helmet transforms and outward
weapon angles remain unchanged. The armory uses the same texture at integer 2x
size and all eight weapons have their own rack slot. Gameplay belongs to the
combat/service registry; art does not grant authority or modify saved identities.

`verify-preservation.mjs` compares v003, v006 and v013 bytes against the independent
v0.9.0 release and emits `REGISTRATION_RECEIPT.json`. `render-controls.mjs` saves
the actual complete runtime renderer's P05 male/female pair at native and 2x
sizes; `--all-armors` emits all six body combinations after that first control.
Those local SVG rasters support browser verification and do not establish user
acceptance of the artwork.

There is no paid-provider job or third-party stock asset. This is project-specific
original artwork, without a new stock-license or public-domain claim.
