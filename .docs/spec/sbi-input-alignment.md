# SBI Input Alignment

Status: accepted design; implementation measured but gates not met.

The first end-to-end measurement of this contract is recorded in [SBI 035 Aligned Route Decision](../reports/sbi-035-aligned-route-decision.md): all three delivery gates fail, and the report states the per-stage diagnosis together with a bounded retraining proposal awaiting user approval. It supersedes the placeholder claims that preceded it but does not amend this contract.

This is the authoritative contract for the alignment-first revision of [ADR-0006](../adr/0006-sbi-matching-rewrite.md). [Batch 029](../tasks/029-sbi-input-alignment.md) owns the work; [task 028](../tasks/028-ship-sbi-matching-winner.md) owns final shipment. This document does not declare the current worktree or deployed site compliant.

## Scope and order

1. Establish a trustworthy baseline and browser/offline observation parity.
2. Verify and repair crop geometry; preserve native item-region pixels.
3. Align query/reference sampling and exclusion masks, then evaluate compact coarse retrieval plus native-size refinement.
4. Verify the complete synthetic acceptance corpus, nine real screenshots and cold-cache transfer budget.
5. Decide whether remaining failures justify retraining embeddings. Do not automatically train because a score misses its target.

Matching remains browser-side on static hosting. Reuse the existing engine, generator, corpus renderer and evaluation harness before adding alternatives. Preserve the UI, crop controls, diagnostics, HUD/widget capabilities, catalog exclusions and [observable-group semantics](../adr/0005-observable-group-equivalence.md). Item types may label the UI but must not be hard gates that exclude other reference item types from matching.

## Crop geometry and native observations

- Derive item positions, slot spacing, widget and HUD coordinates from one verified hotbar geometry. For a validated standard 182-unit-wide hotbar, use its measured width divided by 182 as the shared scale; do not combine that rectangle with an independently selected slot scale.
- A screenshot may have been resized. Its effective scale can be fractional even if the original GUI scale was integral. Integer snapping alone is not proof of correctness.
- Check first and last slot bounds, vertical alignment and original screenshot overlays. Do not certify a crop merely because its downstream ranking improved.
- Retain each native item-region crop, its source rectangle and dimensions until refinement. A 16px feature preview is not a native crop and must not be enlarged to impersonate one.
- Validate empty-slot handling on sparse hotbars, full hotbars and repeated identical items. A median image is not necessarily an empty plate; do not discard genuine repeated items or subtract an unverified plate.
- Keep invalid/empty observations explicit. Record extraction failures instead of silently removing them from evaluation denominators.

## Pairwise comparison resolution

For square item regions, the refinement side length is:

`comparisonSize = min(queryNativeSize, referenceNativeFrameSize)`

| Query native region | Reference native frame | Refinement |
| --- | --- | --- |
| 48x48 | 128x128 | 48x48 |
| 96x96 | 128x128 | 96x96 |
| 96x96 | 32x32 | 32x32 |

Retain source resolution/frame provenance. Animated strips are not single square frames; keep the existing frame-selection policy explicit and tested, rather than resizing an entire strip into an icon. Do not invent a new animation policy in this batch.

Only downsample the larger side. Do not obligatorily enlarge to 512, collapse every refinement input to 16, or cap all references at 48. Compact coarse features are separate from this rule and may be low resolution; their size must not destroy the native source used later.

Use a shared, explicitly tested downsampling policy. Area averaging is the initial candidate from the design discussion; it is not interchangeable with Lanczos, nor proof of Minecraft's rendering behavior. Specify coordinate rounding, sampling phase, alpha treatment and color handling, and verify numerical parity on representative Node/browser inputs before accepting a policy. Equal output dimensions alone do not imply equal preprocessing. Do not claim to recover screenshot detail absent from the source.

## Exclusion masks

Use the approved fixed mask in 16x16 logical item coordinates:

- bottom two rows: `y >= 14`;
- lower-right 6x6 corner: `x >= 10 && y >= 10`.

Map their union proportionally to the actual comparison grid on both query and reference. Excluded pixels must contribute neither agreement nor disagreement, including color, alpha/shape and normalization terms; a transparent replacement must not be counted as background agreement. Apply the same exclusion semantics to item features used for coarse retrieval where applicable.

Test asymmetric edge pixels and small grids. This mask deliberately discards some real item evidence; it is not a zero-loss guarantee. Keep diagnostics that expose how much unmasked evidence remains. Do not silently remove this mask or replace it with a learned overlay detector when accuracy is low.

## Reference generation and retrieval

- Generate reference representations through the authoritative data command, `npm run sbi:data`, not manual JSON edits.
- Keep compact coarse retrieval and on-demand refinement distinct. Preserve sufficient reference information to fulfill the pairwise rule, including the 96-versus-128 case.
- Compare all supported item types without relying on hard type inference. Diagnose wrong crop, source/preprocessing mismatch, candidate loss and refinement error separately.
- Record recall at the actual coarse shortlist size before refinement. A true group missing from that shortlist cannot be recovered by reranking.
- Do not fix the shortlist at 200 or any earlier experimental value without validating recall, latency and actual transfer at that value.
- Version generated schemas, fingerprint constants, preprocessing and HTML cache references together. Inspect deterministic regeneration and stale-data rejection.

## Evaluation contract

### Corpora and provenance

Keep the existing light corpus and historical results as a versioned control. Create a separately versioned acceptance corpus covering screenshot resizing/fractional effective scales, JPEG and brightness changes, stack counts and durability bars. Include sparse/full/repeated-item hotbars. Heavy-tier stress tests remain diagnostic rather than an automatic new delivery gate.

Freeze the manifest, truth mapping, seeds, perturbation settings and development/acceptance allocation before tuning. Keep related variants out of conflicting training/acceptance partitions; the nine real screenshots are acceptance queries, not training examples. Record hashes of source textures, corpus, engine, reference data and any model. Changing geometry or preprocessing invalidates incompatible observation caches.

### Same observable behavior

Run full-corpus evaluation offline, reusing the production extraction and ranking path. Validate it against headless browser observations on representative fixtures. Preserve all consumed inputs in replay caches, including slot variants/activity, geometry, masks and structured HUD/widget evidence. No palette-only score may be presented as the complete browser pipeline's score.

Stream large caches with completeness/provenance checks and restart-safe writes. A truncated cache, old schema or missing sample is not a passing evaluation.

### Separate measures

Report each stage independently:

1. Geometry/crop correctness against known or reviewed rectangles.
2. Coarse group recall@K before refinement, with K recorded.
3. Final group top-1 and expected-member presence in the displayed group.
4. Extraction failures, missing data and other invalid cases, with their disposition and the full denominator.
5. Cold-load and warm-query latency, peak working memory and download bytes.

Use a fixed full manifest denominator for acceptance. Missing predictions count as failures; invalid truth must be documented and resolved rather than silently dropped to improve a rate. Small-sample sweeps are development results only. Compare baseline and candidate on the same corpus/version before attributing improvements to a change.

## Delivery gates

All gates apply together:

- Nine real screenshots: **9/9 group-level top-1**, retaining the expected member in the winning group.
- Complete versioned synthetic acceptance corpus: **group-level top-1 >=80%**.
- **Cold-cache first-query download <=8MB**, from opening SBI until the first complete refined result. Count actual transferred resources required by that run: page/runtime assets, metadata, coarse/refinement data and any model. Lazy loading and prefetching do not exempt bytes. Use a consistent byte unit and report exact byte totals; do not substitute MiB or per-file zlib estimates for this gate.
- Required syntax, regression, generation/version-linkage and UI checks pass. Distinguish known unrelated baseline failures, skipped manual checks and environment-unverified checks from passes.

A 7/9 result is progress, not final acceptance or permission to close task 028. Sampled compression estimates do not prove the budget. Browser caches must actually be cold; an inability to measure a resource's transfer size is an evidence gap, not zero bytes.

If budget, native-size refinement and accuracy cannot all be satisfied, present measured alternatives for a user decision. Do not silently truncate candidates, lower refinement resolution, relax the budget or switch to a server matcher.

## Embedding decision and experiment retirement

Evaluate retraining only after crop/preprocessing correctness and measurement parity are proven. Analyze remaining cases and compare a proposed model against the aligned classical baseline; low hit count alone does not establish a domain gap, and failed earlier models do not disprove all embedding methods.

If the classical route meets every gate, do not introduce a model. Remove obsolete model/runtime/training implementation through the approved cleanup task while retaining experiment conclusions and enough provenance to reproduce the comparison. The earlier model is not a validated fallback.

If retraining is justified, task 035 must provide the evidence and bounded training/evaluation proposal for user approval before reactivating 026/027. Retain static inference, the total cold-cache budget, training-free CI and single-command reference generation if that route is subsequently approved.

## Evidence limits

Low rank does not prove incorrect pack textures or labels. Different crops, sampling, masks, reference coverage and aggregation remain competing explanations. Source identity must be checked from source evidence before proposing corrections; this batch does not authorize remote pack replacement, deletion, relabeling or changes to observable equivalence to make tests pass.
