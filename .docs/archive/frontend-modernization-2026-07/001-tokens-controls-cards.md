Status: done
Executor: Claude Code

## Parent

`.docs/frontend/design-system.md`

## What to build

Introduce the semantic token layer in `:root` (surface colors absorbing current hardcodes, `--radius-action: 6px`, hard-shadow pair `--shadow-rest`/`--shadow-lift`, transition durations, spacing scale) and apply it across the shared control and card language: all buttons and text inputs get the 6px action radius and a global custom focus outline; every blurred box-shadow on cards (pack, list, SBI result, history) is replaced by the hard-shadow rest/lift pair; transitions consume the duration tokens. Cards, header, and thumbnails stay square. Site-wide `style.css?v=` bump with `p/*` regeneration ships in the same change.

## Acceptance criteria

- [x] `:root` exposes the tokens named in the design system doc; `#dde7f1` / `#b9cadd` hardcodes are replaced by token references
- [x] Every button and text input site-wide renders 6px corners; no card/header/thumbnail gains a radius
- [x] Keyboard Tab shows the accent focus outline on links, buttons, and inputs instead of the browser default
- [x] No blurred box-shadow remains in `style.css`; card hover lifts with the hard shadow
- [x] Live check on home, pack detail, List, SBI after cache-busted deploy

## Blocked by

None - can start immediately
