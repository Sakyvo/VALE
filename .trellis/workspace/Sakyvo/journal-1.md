# Journal - Sakyvo (Part 1)

> AI development session journal
> Started: 2026-05-23

---



## Session 1: Upload Sakyvo pack collection

**Date**: 2026-07-03
**Task**: Upload Sakyvo pack collection
**Branch**: `main`

### Summary

Uploaded accepted Sakyvo packs to remote storage, created the Sakyvo list, regenerated site metadata, documented oversize packs, and recorded pack ingestion contracts.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2348f37a` | (see git log) |
| `f498bccf` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Frontend polish: nav icons and detail page fixes

**Date**: 2026-07-07
**Task**: Frontend polish: nav icons and detail page fixes
**Branch**: `main`

### Summary

Batch frontend improvements (no task per user): added style-consistency principle to AGENTS.md; pack detail page - force title wrap, normal letter-spacing on DOWNLOAD/Preview/ADMIN headings, uniform-width admin buttons with red DELETE PACK, sky-blue (#87CEEB) armor card matching GUI card; 1px right black text-shadow on home pack names for light-color legibility; replaced ADMIN/LOGIN/HISTORY nav text with SVG icons via auth.js and sbi/index.html; added SBI icon link to home topbar; unified 64px header height across pages; bumped auth.js/pack-detail.js/style.css cache versions and regenerated 741 p/* pages.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `fadb2d90` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Switch repo references to Sakyvo/VALE

**Date**: 2026-07-07
**Task**: Switch repo references to Sakyvo/VALE
**Branch**: `main`

### Summary

Repo was renamed Sakyvo/Sakyvo.github.io -> Sakyvo/VALE with custom domain vale.cc.cd (CNAME present, old user site 404s, new raw URLs verified 200). Updated all hardcoded references: auth.js REPO_NAME (maintenance fetch), admin.js REPO_NAME (git data API), pack-detail.js delete API URLs, generate-index.js fallback download URLs, AGENTS.md repo doc, design.md (repo/deploy URLs). Updated local git remote origin. Bumped auth.js->v5, pack-detail.js->v5, admin.js->v3 and regenerated 741 p/* pages. data/ had no old references (all packs resolve via registry to packs-NNN).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5b0d2d88` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Header alignment, armor viewer fix, button and border polish

**Date**: 2026-07-08
**Task**: Header alignment, armor viewer fix, button and border polish
**Branch**: `main`

### Summary

Third frontend batch (no task): LOGOUT on admin page now uses log-out SVG icon; pack detail pages gained the SBI nav icon (pack.html template + 741 regenerated); removed all .sbi-page header/nav CSS overrides so VALE logo and nav buttons align identically across home and SBI pages; fixed armor viewer drifting to top-left on fast first load by adding ResizeObserver-driven resize() (initial clientWidth/Height could be 0 before layout settled, leaving a 200x280 canvas stuck top-left); thinned card border lines 2px -> 1.5px across pack/detail/preview/list/admin/SBI cards (controls keep 2px); buttons got cursor:pointer, hover shades and translateY(2px) press feel; DELETE PACK confirm() replaced with in-site modal (btn-danger DELETE / CANCEL). Versions: auth.js v6, pack-detail.js v6, armor-viewer.js v3, sbi style.css v27.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `007c8d1b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Pixel font for names, pdir font stack for UI

**Date**: 2026-07-08
**Task**: Pixel font for names, pdir font stack for UI
**Branch**: `main`

### Summary

Font polish (no task): subset local Minecraft-AE.ttf (16MB, includes CJK pixel glyphs) to 18.5KB woff2 covering Basic Latin + Latin-1 + every character actually used in pack/list names (extracted from data/index.json + l/lists.json); added scripts/subset-font.py for regeneration and noted the workflow in AGENTS.md. Applied 'Minecraft AE' via --font-mc CSS var to .pack-card .name, .list-grid .list-item .name, .sbi-result-name, .main-card-info h1, .detail-info h1 (weight normal to avoid synthetic-bold blur). Body font switched to pdir stack (--font-ui, adds 'Noto Sans SC'). Bumped sbi style.css to v28.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c67aa024` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Full-corpus SBI release

**Date**: 2026-07-14
**Task**: Full-corpus SBI release
**Branch**: `main`

### Summary

Released deterministic full-corpus SBI, exact observable groups, Overlay/Conquest exclusions, content-identity safeguards, and verified local/deployed 9-image accuracy plus 1000-group performance budgets.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `db7e11e9` | (see git log) |
| `7a40f470` | (see git log) |
| `f397ae57` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
