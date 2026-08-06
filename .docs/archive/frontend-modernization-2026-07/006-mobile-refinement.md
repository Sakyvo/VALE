Status: done
Executor: Claude Code

## Parent

`.docs/frontend/design-system.md`

## What to build

Mobile refinement pass across the existing breakpoints (1200/900/700/600): spacing-scale compliance, tap-target sizes for the new control language, slot-bevel search usability on small screens, toast placement above mobile browser chrome, and card grid rhythm. Desktop rendering must be pixel-unchanged — this slice only touches media-query rules.

## Acceptance criteria

- [x] All interactive elements ≥ 40px tap target at 600px width
- [x] Slot search box, toasts, and card grids verified in a 375px-wide viewport
- [x] No desktop visual regression (rules confined to media queries)
- [x] Live check on a real phone or devtools emulation after cache-busted deploy

## Blocked by

- `001-tokens-controls-cards.md`
- `002-slot-search-signature.md`
- `003-sbi-token-adoption.md`
- `004-toast-alerts.md`
- `005-admin-inline-cleanup.md`
