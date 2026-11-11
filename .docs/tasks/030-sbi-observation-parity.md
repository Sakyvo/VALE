Status: open
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Make a screenshot produce equivalent observations and rankings through the browser, direct offline engine and cached replay. Reuse the existing engine/bench seams; preserve all consumed slot, geometry, mask, HUD and widget evidence. Produce a versioned baseline with clearly separated extraction, candidate and final-ranking measurements before further algorithm changes. This slice owns the outstanding verification work routed from 023/024.

## Acceptance criteria

- [x] Regression tests fail when replay loses activity, variants, refinement inputs, native geometry or structured HUD/widget evidence; fixed replay matches direct scoring.
- [x] Headless browser and offline observations are compared on representative PNG/JPEG, sparse/full/repeated-item hotbars. Explain and bound any numerical decode tolerance; do not silently accept changed candidate membership or top-1.
- [x] Cache streaming, atomic completion/resume and provenance checks reject truncated, partial, stale-schema and incompatible-source caches; a small extract cannot masquerade as a full corpus run.
- [ ] A single documented evaluation command validates or generates its cache and completes the full historical light manifest offline, reporting geometry failures, actual coarse recall@K, final group top-1 and member presence with the same denominator.
- [ ] Capture source/engine/reference/corpus hashes, commands, sample counts and baseline test failures. Reconcile the historical 2090-versus-2092 reports; do not silently exclude missing predictions/truth.
- [x] Resolve 023's unproven bitwise score-parity claim with exact-version evidence or record it as unproven; do not compare the behavior-preserving split with later ranking changes as though they were one patch.
- [ ] Update 023/024 with the evidence this slice actually establishes. Syntax and new focused tests pass; run the project suite and existing real-shot harness without changing acceptance labels.

## Blocked by

None - can start immediately

## Verified baseline and remaining work

See [the source-pinned baseline report](../reports/sbi-030-observation-baseline.md) for commands, exact hashes, parity tolerances and per-case evidence locations. The completed historical run is 1584/2092 top-1, coarse recall@48 1999/2092, member presence 1982/2092, with all eight missing-reference errors retained in the denominator. PNG and sparse/full/repeated fixtures matched browser/direct/replay exactly; the tested JPEG preserved candidates and order with the bounded numerical differences in that report.

The historical 2090-versus-2092 discrepancy is documented, not invented away: the two previously omitted rows cannot be identified from available records. The old corpus lacks independent rectangle truth, so geometry accuracy is not certified by this run. New manifest geometry reporting has direct tests but still needs its full-corpus verification in 033. The latest recorded project suite is 228/230, with two existing ingestion failures; no all-green claim is made.

Task remains open for final checklist audit, source/data reproduction completeness, geometry reporting and final browser/offline linkage after the subsequent slices. These are distinct from the already verified pre-alignment baseline; do not rerun it under a different hash and call it the same run.
