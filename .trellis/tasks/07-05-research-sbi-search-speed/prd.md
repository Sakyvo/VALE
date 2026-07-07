# Research SBI search speed improvements

## Goal

Find a practical path to keep Search by Image fast after SBI fingerprints expand from the current small subset to most or all accepted resource packs.

## Requirements

- Preserve SBI as a core product feature: full/near-full pack coverage is expected eventually.
- Improve search speed without weakening current top-1 accuracy on `test_img`.
- Treat the expanded Sakyvo corpus as the target scale, not the current 192-pack SBI subset.
- Keep the site static-hosting compatible; any server-side service must be justified as a separate product/ops decision.
- Reuse existing fingerprint concepts where possible: shard loading, signature buckets, dHash, histogram, color moments, edge density, and HUD/widget signals.
- Do not implement changes in this planning task until an approach is chosen and approved.

## Acceptance Criteria

- [x] Identify current SBI bottlenecks from code and test evidence.
- [x] Compare candidate speed strategies with accuracy, complexity, and static-hosting trade-offs.
- [x] Recommend an MVP optimization path for full Sakyvo-scale fingerprints.
- [x] Define validation metrics: load time, match time, total process time, top-1 accuracy, and top-1 margin on `test_img`.
- [x] Produce an implementation plan only after the product constraint question is answered.

## Confirmed Facts

- Current SBI fingerprint version is `14`.
- Current SBI shards cover 192 packs.
- Current thumbnail directories: 744.
- Current uncompressed shard size is about 1.84 MB total; base shards excluding `food` are about 1.57 MB.
- Current compressed shard estimate: about 0.21 MB gzip or 0.13 MB brotli for all eight shards.
- Full Sakyvo-scale SBI would likely be around 1100+ packs after the current upload/List expansion, roughly 5.8x the current candidate count.
- `assets/js/sbi.js` loads seven base shards before extraction/matching: `widget`, `health`, `hunger`, `armor`, `diamond_sword`, `ender_pearl`, `splash_potion`.
- `food` is loaded lazily only when slot inference suggests steak/golden carrot.
- `scripts/generate-sbi-data.js` already writes per-shard `_index` bucket maps for texture signatures.
- `matchPacks` already calls `getSignaturePrefilterCandidates`, but also does an all-pack widget pre-scan before the main scoring loop.
- `matchPacks` computes detailed per-pack scoring and stores details for every evaluated pack, which makes CPU and memory scale with candidate count.
- `test_sbi.py` already captures timings for `decode`, `fingerprints`, `extract`, `food`, `match`, and total `process`.
- Baseline on 2026-07-05 with `python test_sbi.py --quiet`: 9/9 passed.
- Baseline first query including fingerprint load: 0.96s total, with `fingerprints=0.18s`, `extract=0.54s`, `match=0.06s`.
- Baseline warm queries: 0.45s to 1.00s total, with `extract` usually 0.35s to 0.85s and `match` 0.04s to 0.10s.
- Current bottleneck is screenshot extraction on warm searches; after full fingerprint generation, first-load JSON parse and per-pack match work are the main scale risks.

## Candidate Strategy Summary

- Tighten candidate generation before scoring: use DS/EP/HL signature buckets as the first gate, then score only a top candidate set.
- Add a two-stage matcher: cheap coarse score over all indexed candidates, then full expensive HUD/widget/slot scoring only for top-K.
- Deduplicate identical texture fingerprints into groups so repeated edits do not multiply scoring work.
- Split or lazily load shards by item type and possibly by bucket so first load does not require all pack data.
- Move matching into a Web Worker to keep UI responsive, even if total CPU time is unchanged.
- Cache parsed/normalized fingerprints in memory and optionally IndexedDB after first load.
- Consider generated numeric/vector arrays for faster scoring only if JSON/object iteration remains the bottleneck after candidate reduction.

## Open Question

- Answered 2026-07-05: SBI must remain fully static and GitHub Pages compatible for this optimization pass.

## Final Planning Decision

- Recommended MVP: keep the browser-side static architecture, add instrumentation, strengthen DS/EP/HL candidate indexes, then introduce conservative candidate-first matching with full-score fallback.
- Server-side search is out of scope for this pass.
- Approved 2026-07-05: first implementation should include instrumentation, DS/EP/HL candidate index enhancement, candidate-first two-stage matching, and full fallback. Deduplication, binary formats, IndexedDB, and Web Worker are deferred.

## Notes

- Current upload task remains separate and excludes SBI regeneration.
- Implementation note 2026-07-05: direct regeneration over all current thumbnails produced 738 fingerprinted packs, but `test_sbi.py --quiet` fell to 3/9 because similar/duplicate packs displaced the existing expected top-1 results. The committed SBI data should remain on the existing 192-pack allowlist until a dedupe/canonical ranking pass is designed.
