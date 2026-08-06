Status: done
Executor: Claude Code

## Parent

Grill session 2026-08-01 (high-version packs, overlay grouping, frontend consistency)

## What to build

Make pack naming a second, independent route into the Overlay List, so partial packs stop slipping through.

The existing pixel classifier requires all eleven core textures to equal default, which by construction can never catch a sword overlay — it changes the sword. Seventeen packs (the KOTH Sword Overlay series and Overlay Gapple Money, all under 0.1MB) are named as overlays yet sit outside the List today.

Add a shared naming rule: a pack whose display name or catalog slug contains `overlay`, case-insensitively, belongs to the Overlay List. Match on the cleaned display name so Minecraft colour codes cannot split the word. The rule unions with the pixel classifier and is additive only — the twelve packs currently in the List through pixel detection alone stay, regardless of their names.

Call the same helper from both the authoritative overlay classifier and the upload path's List assignment, so a newly uploaded overlay joins the group on arrival instead of waiting for someone to rerun a manual script. A manual-only rule would not have prevented the current gap.

Accepted consequence: Overlay membership withholds a pack from the homepage grid and from Search by Image fingerprints. These seventeen packs will leave both. That is correct — a pack that is default everywhere except one item is exactly the false attractor the Overlay mechanism exists to suppress.

## Acceptance criteria

- [x] One shared helper decides overlay-by-name and is unit-tested for case variations, colour-code-bearing names, and non-overlay names
- [x] Running the overlay classifier adds all seventeen name-matched packs and removes none of the existing members
- [x] Uploading a pack named as an overlay places it in the Overlay List without a separate classifier run
- [x] The seventeen packs disappear from the homepage grid and from regenerated Search-by-Image fingerprints
- [x] Overlay List membership count moves from 24 to 41 and the generated List page reflects it

## Blocked by

None - can start immediately
