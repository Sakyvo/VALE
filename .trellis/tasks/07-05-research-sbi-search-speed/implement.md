# Implementation Plan

## Proposed MVP

Keep SBI static and make matching candidate-first. The first implementation should not change the scoring formula; it should reduce the number of packs that reach existing full scoring and prove that `test_img` top-1 and margins remain stable.

Server-side search is not part of this implementation pass. All changes must work as static files on GitHub Pages.

Approved scope on 2026-07-05: instrumentation, DS/EP/HL candidate index enhancement, candidate-first two-stage matching, and full fallback. Deduplication, binary formats, IndexedDB, and Web Worker are deferred.

## Checklist

1. Add SBI debug metrics exposed through `window.__sbiTest.getSummary()`:
   - loaded shard count;
   - fingerprint pack count;
   - signature prefilter candidate count;
   - full-score candidate count;
   - match substage timings.
2. Strengthen generated indexes in `scripts/generate-sbi-data.js`:
   - keep current coarse signature buckets;
   - add per-type exact/near hash buckets for DS, EP, and HL;
   - optionally add texture-group IDs for identical fingerprints.
3. Refactor candidate selection in `assets/js/sbi.js`:
   - build anchor candidates from DS/EP/HL;
   - use conservative union plus minimum vote threshold;
   - add fallback to current all-pack path when the candidate set is too small or missing.
4. Split matching into two stages:
   - coarse score candidate packs with cheap slot anchor checks;
   - run current full `matchPacks` scoring on top-K plus fallback candidates.
5. Preserve result details only for visible or top-ranked packs unless debug mode needs all diagnostics.
6. Validate with `python test_sbi.py --quiet` and compare:
   - 9/9 top-1 accuracy;
   - top-1 margin per image;
   - first-query `fingerprints`, `match`, and `process`;
   - warm-query `match` and `process`;
   - full-score count per image.

## Initial Targets

- Current 192-pack baseline: keep 9/9 passing and avoid increasing total time.
- Full Sakyvo-scale target: keep warm `match` under about 150ms on a normal desktop.
- First-query target: keep total process around current second-level behavior after caching, and keep first-load growth bounded by shard size rather than all-pack full scoring.

## Validation Results

- `node --check assets/js/sbi.js`: passed.
- `node --check scripts/generate-sbi-data.js`: passed.
- `node scripts/generate-sbi-data.js --pack-list data/sbi-fingerprints.json`: regenerated the existing 192-pack SBI set with version 15 indexes.
- `python test_sbi.py --quiet`: 9/9 passed.
- Direct all-thumbnail generation produced 738 packs but only 3/9 regression passes, so full corpus activation needs a later duplicate/canonical ranking pass.

## Risk Points

- False negatives from over-strict prefiltering.
- DS/EP missing or generic in screenshots, requiring fallback behavior.
- Potion rendering differences, especially composited splash potion variants.
- Duplicate List entries or near-identical packs making margins small even when top-1 remains correct.
- Debug diagnostics relying on `details` for every evaluated pack.
