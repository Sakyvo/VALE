Status: open
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Evaluate the aligned production matcher end-to-end against the frozen real/synthetic gates and actual delivery budget, then issue an evidence-based route decision. Keep this decision separate from task 028's final shipment; neither a successful experiment nor a failed model closes outstanding implementation requirements.

## Acceptance criteria

- [ ] Publish a reproducible report with source/data/corpus hashes, complete denominators, geometry evidence, actual shortlist recall@K, final group top-1, member presence, latency/memory and cold-cache bytes on the same candidate.
- [ ] Re-run all nine real images and the entire versioned synthetic acceptance corpus through the actual ranking path. Mark the three delivery gates independently: 9/9, >=80%, <=8MB. Seven of nine or a good subsample never counts as delivery.
- [ ] Analyze every remaining failure by stage: geometry, source/preprocessing, candidate recall or refinement. Low rank is not proof of a wrong source or an embedding-only solution.
- [ ] If classical matching meets every gate, select it without adding a model. Retire obsolete experimental model/training/runtime implementation after preserving experiment conclusions, provenance, reproducible revision/commands and verifying there are no live callers. Do not prematurely remove shared tooling.
- [ ] If failures remain after proven alignment, produce a bounded retraining proposal with relevant evidence, held-out evaluation, static inference and budget constraints. Seek explicit user approval before activating 026/027; this decision task may record a completed diagnosis without claiming product acceptance.
- [ ] Reconcile 025's comparison record and 026/027's conditional status. Never mark unmet model quantization, generator integration or budget criteria as passed; document supersession when the model route is not selected.
- [ ] Prepare task 028's verification inputs and remaining work, including legacy-CLIP cleanup, version/cache linkage and product acceptance. Update spec/ADR routing and evidence without declaring an unverified candidate shipped.
- [ ] Preserve required failing gates as failures and original baselines as baselines; distinguish headless passes, unrelated suite failures, manual checks and environment gaps. Run batch wrap-up only after implementation verification and applicable acceptance actually finish.

## Blocked by

- `032-sbi-native-pair-refinement.md`
- `033-sbi-alignment-acceptance-corpus.md`
- `034-sbi-cold-query-delivery.md`
