# VALE Design System (Modernization Contract)

> Decisions locked in the 2026-07-20 grill session. This is the single source of truth
> for the frontend modernization refactor. Identity assets are non-negotiable; tokens
> and elevation are the modernization surface.

## Identity (must survive the refactor)

- Minecraft AE pixel font for pack/List names (8px-grid; sizes must stay multiples of 8).
- Colored §-code pack names with 1px right black text-shadow.
- Pixelated texture thumbnails, feather-style line icons, black 64px header.
- Hard black borders: 1.5px cards, 2px controls.
- Blue-gray palette tuned by Sakyvo (`#d4e0ec` page base).

## Tokens (to be added to `:root` in `assets/css/style.css`)

| Token | Value | Notes |
|---|---|---|
| `--surface` | `#dde7f1` | Card cover / raised surfaces (absorbs current hardcode) |
| `--surface-deep` | `#b9cadd` | Name rows / recessed strips (absorbs current hardcode) |
| `--radius-action` | `6px` | Buttons and inputs ONLY. Cards, header, thumbnails stay square. Max allowed anywhere: 8px. |
| `--shadow-rest` | `2px 2px 0 rgba(0,0,0,.15)` | Hard shadow, no blur, resting cards |
| `--shadow-lift` | `4px 4px 0 rgba(0,0,0,.18)` | Hover lift; replaces all blurred box-shadows |
| `--t-fast` / `--t-base` | `100ms` / `180ms` | ease-out; all transitions use these |
| Spacing scale | 8 / 12 / 16 / 24 / 32 / 48 | No ad-hoc values in new/refactored rules |

Global focus style: `outline: 2px solid var(--accent); outline-offset: 2px` on all
interactive elements (replaces browser default).

## Signature element

**REJECTED after live review (2026-07-21).** The inventory-slot inset bevel on search
boxes shipped, was reviewed live by Sakyvo, and was rolled back the same day. Do not
reintroduce slot bevels or other skeuomorphic inventory styling. Search boxes use the
standard control language (radius + hard border). The site's signature remains the
pixel-font colored pack names; no additional signature element is planned.

## Dialogs and feedback

- All native `alert()` calls become a minimal site toast (bottom-right, hard border,
  hard shadow, auto-dismiss). Confirmations stay as in-site modals.
- Errors state what happened and what to do next; no apologies, no vagueness.

## Explicitly out of scope

- **Dark mode: never planned.** Do not scaffold for it, do not propose it.
- No framework adoption; the native template/class model stays (see component-guidelines).
- Rounded corners beyond 8px anywhere.

## Delivery batches (each verified live by Sakyvo before the next)

1. Tokens + button/control system (radius, focus, hard shadows) + card system.
2. Slot-bevel signature (home + List search) + SBI page token adoption.
3. Toast component replacing alerts + admin inline-style cleanup + mobile refinement.

Cache rule applies every batch: bump `style.css?v=` site-wide and regenerate `p/*`.
