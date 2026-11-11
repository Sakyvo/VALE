# Search By Image

SBI identifies Minecraft PvP resource packs from screenshots. Matching remains browser-side and compatible with static hosting.

## Authoritative routes

- For crop geometry, sampling, native-resolution refinement, masks, evaluation and first-query transfer, read [SBI Input Alignment](spec/sbi-input-alignment.md).
- For the architecture decision and superseded assumptions, read [ADR-0006](adr/0006-sbi-matching-rewrite.md).
- For group identity, follow [ADR-0005](adr/0005-observable-group-equivalence.md); do not alter equivalence to raise evaluation scores.
- [Batch 029](tasks/029-sbi-input-alignment.md) owns alignment and verified comparison work. [Task 028](tasks/028-ship-sbi-matching-winner.md) remains the final shipping gate.

The spec is approved design, not a declaration that the current worktree or deployed site implements it.

## Existing implementation and worktree experiments

The original pipeline extracts hotbar slots, infers item types, constructs candidates from fingerprint shards, combines item/HUD/widget evidence and refines a shortlist. Exact observable groups are displayed together. Packs in the `Overlay` and `Conquest` Lists remain browsable through Lists but are excluded from SBI generation and results.

The current worktree separates the engine into `assets/js/sbi-engine.js` and leaves UI behavior in `assets/js/sbi.js`. It also contains experimental cross-size spatial comparison, median-slot filtering and sparse palette scoring. The complete `matchPacks` path still includes legacy scoring and refinement; calling the palette scorer alone is not an end-to-end browser evaluation. These worktree changes have not been certified as a released winner by this documentation update.

`inferDisplaySlotTypes` must ultimately be a display aid, not a hard exclusion gate. Preserve existing HUD/widget capabilities during that migration.

## Reference data and generation

`scripts/generate-sbi-data.js` builds references from the existing extracted-texture inputs through `npm run sbi:data`, writing sharded data under `data/sbi-fp/`. Change the generator and regenerate, rather than hand-editing generated JSON. Do not retain a second durable/runtime monolithic `data/sbi-fingerprints.json` copy.

The current format includes `dhash`, `hist`, `moments`, `edge`, `sig` and separately loaded `pix`. Item shards cover diamond sword, ender pearl, splash potion and food; widget/HUD shards cover the hotbar, health, hunger and armor. Metadata carries groups, rarity, exclusions and version information. Pixel grids and loading behavior in the old format are not the new native-resolution contract.

There is no total stored-corpus size ceiling. Keep each generated shard near a 32 MiB target and split by a deterministic key when needed. This storage rule is independent of the **8MB total cold-cache first-query transfer gate**; a corpus can be large on disk without being downloaded in full by each query. Actual requests, including overfetch from pixel buckets, must be measured.

## Approved design, pending implementation

The full contract is in the routed spec. In brief:

- Establish trustworthy browser/offline measurements before judging a matcher.
- Use one validated geometry for item, widget and HUD extraction and retain native query crops.
- Use compact coarse retrieval, then pairwise refinement at the smaller native size without upscaling or a universal 16/48px cap.
- Exclude the approved bottom-row and lower-right overlay regions using common logical coordinates and normalization semantics.
- Upgrade the synthetic acceptance corpus without overwriting its historical control; diagnose geometry, shortlist recall and ranking separately.
- Verify the real nine-shot gate, full synthetic gate and actual cold-cache download budget together.
- Decide on retraining only after alignment correctness is established and remaining failures analyzed.

## Historical measurements, not current acceptance

| Record | Scope | Interpretation |
| --- | --- | --- |
| Tasks 016/018: 39.1% group top-1, 65.0% coarse recall, 96.3% member presence | v20-era light corpus; 2092 generated, 2090 evaluated in 016 | Historical control; reconcile denominator and version before comparison |
| Session nine-shot runs: 2/9 before experiments; later 3/9 with reported candidate recall 5/9 | Nine real images in the local browser harness | Historical local results, not a deployment claim or a guaranteed current baseline |
| Session palette run: 1621/2092 (77.5%) | Standalone palette scorer over cached observations | Component result, not the full browser matcher; replay fidelity still requires verification |
| Session embedding experiments: 0/9; reported mean ranks changed with preprocessing | Experimental model and rendering pipelines | Not accepted for production; not proof against all embedding approaches |

Small-sample results such as 82.9% on 398 usable rows do not satisfy full-corpus acceptance. Do not merge measurements with different denominators, preprocessing, loaded reference coverage or ranking paths into an apparent improvement curve. A low rank does not prove an incorrect source texture, and a median slot is not necessarily empty.

## Versioning and verification

- Keep fingerprint version constants synchronized across the generator and every runtime consumer, including the extracted engine. Reject stale incompatible data.
- After matcher/fingerprint changes, update SBI HTML cache references; follow the root AGENTS.md linkage rule for shared assets and generated pages.
- Run `node --check` on changed JavaScript, `npm test`, `python test_sbi.py`, and the task's full offline and transfer checks. Inspect authoritative regeneration diffs when generator/data changes.
- The current evaluation entry point has `extract`, `current` and `palette` modes. Do not report any mode as validated until its observation round-trip and production-path parity have passed the batch's tests.
- Final gates are **9/9 real-shot group top-1**, **>=80% full synthetic acceptance group top-1**, and **<=8MB cold-cache first-query download**, as defined by the spec. Seven of nine is progress only.
- Report `passed`, `failed`, `skipped-manual` and `unverified-environment` separately. Record unrelated baseline failures rather than calling a partially failing suite green. Do not broaden accuracy claims beyond the measured corpus.
