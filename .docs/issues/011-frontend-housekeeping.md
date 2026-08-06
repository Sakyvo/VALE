Status: done
Executor: Claude Code

## Parent

Grill session 2026-08-01 (high-version packs, overlay grouping, frontend consistency)

## What to build

Three unrelated pieces of frontend housekeeping that each stand on their own.

The armour preview's pause/play control is the last emoji icon on the site; every other icon is a line-drawn SVG. Replace it with matching pause and play glyphs and move its hardcoded inline styling into a shared class following the control language — dark surface, light icon, action radius, and an accessible label that names the action.

The pack detail page's DELETE PACK button targets an archive path in the main repository, but packs moved to the numbered pack repositories long ago, so the button can only ever report that the file is missing. Comment it out rather than repairing it: a correct implementation must go through the two-phase deletion contract, which is out of scope here.

`assets/js/list-detail.js` is loaded by no page — both the List index and List detail pages run from `list.js`. Delete it. It has already cost maintenance twice in recent work by looking live.

## Acceptance criteria

- [x] Armour preview toggles playback with SVG pause/play icons, styled from a shared class with no inline style block, and carries an accessible label reflecting the current action
- [x] No emoji icon remains in any site script
- [x] DELETE PACK is commented out and no longer reachable from the pack detail admin section; the surrounding admin actions still work
- [x] `assets/js/list-detail.js` is gone and no page or test references it
- [x] Affected script cache busters bumped and generated pack pages regenerated

## Blocked by

None - can start immediately
