Status: done
Executor: Claude Code

## Parent

`.docs/frontend/design-system.md`

## What to build

Move the legacy inline styles in admin markup and List page templates (admin panel, list management modals, list-detail search box and admin buttons rendered from JS template literals) into shared classes in `style.css`, consuming the 001 tokens. Zero behavior change; DOM structure may gain class attributes but interactions and layout stay identical. This clears the debt noted in `component-guidelines.md`.

## Acceptance criteria

- [x] No `style="..."` attributes remain in admin/List reusable UI templates (one-off positional tweaks may stay only with a code comment justifying them)
- [x] Admin panel and List management flows verified live with unchanged behavior
- [x] New classes reuse tokens; no new hardcoded colors or ad-hoc spacing values

## Blocked by

- `001-tokens-controls-cards.md`
