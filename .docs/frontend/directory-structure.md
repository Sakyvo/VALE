# Directory Structure

## Overview

VALE is a static multi-page site. Browser code is plain HTML, CSS, and JavaScript; Node.js scripts generate pack metadata, pages, Lists, thumbnails, and SBI data. There is no `src/` tree, bundler, or framework component directory.

## Ownership Map

| Path | Ownership |
| --- | --- |
| `index.html`, `pack.html`, `sbi/index.html`, `admin/index.html` | Hand-edited page shells |
| `assets/css/style.css` | Shared visual system for every page |
| `assets/js/*.js` | Browser behavior, one file per page/feature |
| `scripts/*.js`, `scripts/lib/*.js` | CommonJS build, ingestion, and data-generation tools |
| `tests/*.test.js`, `test_sbi.py` | Node unit/integration tests and Edge SBI regression |
| `data/extracted.json`, `l/lists.json`, `data/pack-registry.json` | Source data used by generators |
| `data/index.json`, `data/pages/`, `data/packs/` | Generated public indexes and pack records |
| `p/<pack-id>/index.html`, `l/<list-id>/index.html` | Generated route pages |
| `thumbnails/<pack-id>/` | Generated/extracted visual assets |
| `data/internal/` | Operational data that browser code must not load |

## Module Organization

- Put page behavior in the matching `assets/js/<feature>.js` file. For example, Explore search lives in `assets/js/main.js`, List behavior in `assets/js/list.js` and `assets/js/list-detail.js`, and SBI in `assets/js/sbi.js`.
- Put reusable Node ingestion logic under `scripts/lib/`; keep command entry points under `scripts/`.
- Keep shared styling in `assets/css/style.css`. The project does not split CSS per page.
- Change source data or generators, then regenerate outputs. Do not hand-edit hundreds of files under `data/packs/`, `data/pages/`, or `p/`.

The page shell loads dependencies in explicit order:

```html
<!-- index.html -->
<script src="assets/js/auth.js?v=6"></script>
<script src="assets/js/pack-loader.js?v=5"></script>
<script src="assets/js/main.js?v=6"></script>
```

## Naming Conventions

- Browser and script filenames use lowercase kebab-case: `pack-loader.js`, `list-detail.js`, `generate-sbi-data.js`.
- Browser classes and IDs use kebab-case: `.pack-grid`, `#search-input`, `.sbi-result-card`.
- JavaScript constructors use PascalCase; functions and variables use camelCase.
- Pack/List route directories use the project's sanitized public ID, not an independently invented slug.
- Generated pack records use `data/packs/<pack-id>.json`; generated pages use `p/<pack-id>/index.html`.

## Common Mistakes

- Do not introduce `src/components`, React/Vue/Svelte files, or a bundler for a local change; no existing runtime consumes them.
- Do not edit generated pack pages as the source of truth. Update the generator or source data and rerun the relevant command.
- Do not place remote resource-pack zip files in this repository. Their durable home is `Sakyvo/packs-NNN`.
- Do not expose files from `data/internal/` through browser scripts.
