Status: done
Executor: Claude Code

## Parent

`.docs/frontend/design-system.md`

## What to build

A minimal shared toast component (bottom-right, hard border, hard shadow, auto-dismiss, stacking) and migration of every native `alert()` call to it — pack delete results, add-to-list confirmation feedback, login prompts, admin upload/build notices. Confirmation dialogs stay as in-site modals. Toast copy states what happened and, on errors, what to do next. The component lives with the other shared browser scripts and is loaded by every page that previously called `alert()`.

## Acceptance criteria

- [x] `grep -rn "alert(" assets/js` returns zero live call sites (comments excluded)
- [x] Toasts appear bottom-right with token-driven styling, auto-dismiss, and never block the thread
- [x] Delete-pack success/failure, add-to-list, and login-required paths each show the correct toast, verified live
- [x] Script cache busters bumped on all affected pages, `p/*` regenerated

## Blocked by

- `001-tokens-controls-cards.md`
