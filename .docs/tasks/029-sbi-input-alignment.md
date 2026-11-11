Status: anchor
Executor: pi

## Problem

Players need the corresponding resource-pack group first, not a visually unrelated sword. Previous matcher experiments did not meet delivery gates and mixed component results, partial corpora and browser results. Crop geometry, native pixels and replay fidelity must be verified before blaming reference sources or choosing another model.

This is the explicitly approved batch 029 on the VALE task board, continuing its existing numbering convention. It repairs the prerequisites of batch 022; it does not declare tasks 023-028 complete or authorize automatic implementation from this documentation approval.

## Decisions

The authoritative contract is [SBI Input Alignment](../spec/sbi-input-alignment.md), with rationale in [ADR-0006](../adr/0006-sbi-matching-rewrite.md).

- Verify crop geometry and preprocessing first, then evaluate a classical route before deciding on retraining.
- Preserve native observations and references for pairwise `min(queryNativeSize, referenceNativeFrameSize)` refinement; keep compact coarse features separate.
- Retain the approved logical-coordinate overlay exclusion mask and validate its contribution/normalization semantics.
- Upgrade and version the synthetic acceptance corpus; retain the historical corpus as a separate control.
- Final shipment still requires real 9/9, full synthetic >=80%, static browser-side matching and <=8MB cold-cache first-query download. No silent trade-offs.
- Keep UI, HUD/widget behavior, exclusions and observable equivalence. Type labels must not gate matching.
- Treat previous experimental models as unvalidated. Retire obsolete experiment implementation if the classical route meets all gates, preserving conclusions and reproduction provenance; otherwise request evidence-based retraining approval before activating 026/027.

## Out of scope

- Compulsory 512px upscaling, fixed 16/48px refinement caps, server-side matching or relaxed acceptance.
- A new neural architecture/training run before the retraining gate.
- Replacing/deleting remote packs, relabeling truth from ranking failures, or changing group equivalence to pass tests.
- UI redesign, new animation semantics, training on the nine real acceptance queries or making heavy-tier stress tests a new shipping gate.
- Unrelated dependency-directory cleanup. Existing dirty source/dependency files must not be discarded as part of this batch.

## Testing strategy

TDD at meaningful seams: observation round-trip, geometry-to-ranking, reference generation-to-refinement, loader-to-cold-result and corpus-to-evaluation. Reuse the existing engine, data generator, synthetic renderer and headless harness. Each slice must exercise a complete narrow behavior, not only helper functions.

Start with source/data/corpus hashes and a verified baseline. Keep full manifest denominators and separate geometry correctness, pre-refinement recall@K, final top-1, member presence and latency/transfer. Test browser/offline parity and direct/cached equivalence. A component scorer or sample sweep cannot certify task 028.

Run required syntax, tests, version/cache linkage and deterministic regeneration for affected implementation. Avoid foreground interference; only human acceptance remaining means `review`, not `done`. No archive or closure while required verification remains.

## Ownership and dependency handoff

- 030 owns the old 023 parity evidence and 024 measurement/replay gaps; those cards point here rather than creating a second implementation queue.
- 031-034 own aligned production behavior and its evaluation/delivery prerequisites.
- 035 owns the same-scale route decision, reconciles the old 025/026/027 evidence, and prepares task 028's final verification package.
- 028 retains release/legacy-CLIP cleanup responsibility. Batch 029 does not depend on 028, avoiding a dependency cycle.
- 026/027 remain uncompleted and deferred to 035's decision. If retraining is approved, remove that decision dependency before 035 waits for their new evidence; otherwise record their supersession explicitly, never mark unmet criteria as passed.
