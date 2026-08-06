Status: done (rolled back after live review; signature permanently rejected, see design-system.md)
Executor: Claude Code

## Parent

`.docs/frontend/design-system.md`

## What to build

The signature element: the home and List index search boxes get a Minecraft inventory-slot inset bevel (dark top/left edges, light bottom/right edges, pure CSS borders — no images). Implemented as one isolated modifier class applied in the two HTML files, with its rules in a single commented block so rollback is deleting the class attribute and the block. The search button inside the box keeps the standard control language from 001.

## Acceptance criteria

- [x] Home and List search boxes render the inset slot bevel; no other element on any page uses it
- [x] Rollback path verified: removing the modifier class restores the plain 001-style control
- [x] Input remains fully usable (placeholder legible, focus outline visible, mobile tap target intact)
- [x] Live check after cache-busted deploy

## Blocked by

- `001-tokens-controls-cards.md`
