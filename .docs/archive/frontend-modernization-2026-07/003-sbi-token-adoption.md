Status: done
Executor: Claude Code

## Parent

`.docs/frontend/design-system.md`

## What to build

Bring the SBI page's own widget set (scale-preset buttons, action buttons, mode toggle, upload dropzone, tools/debug cards, search-scores input) onto the shared token language from 001: action radius on controls, hard shadows instead of any soft ones, duration tokens, focus outline. Purely visual adoption — no matcher, fingerprint, or search-flow logic changes, so no SBI version-constant bump; only the style cache buster.

## Acceptance criteria

- [x] SBI controls visually match the site-wide control language (radius, focus, press feel)
- [x] No SBI JavaScript files change; `python test_sbi.py` not required per AGENTS.md rule
- [x] Upload dropzone and result cards keep their layout and behavior pixel-identical except for token-driven surfaces
- [x] Live check of a full search flow after cache-busted deploy

## Blocked by

- `001-tokens-controls-cards.md`
