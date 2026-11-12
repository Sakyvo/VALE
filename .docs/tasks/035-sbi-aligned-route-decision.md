Status: done
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Evaluate the aligned production matcher end-to-end against the frozen real/synthetic gates and actual delivery budget, then issue an evidence-based route decision. Keep this decision separate from task 028's final shipment; neither a successful experiment nor a failed model closes outstanding implementation requirements.

## Acceptance criteria

- [x] Publish a reproducible report with source/data/corpus hashes, complete denominators, geometry evidence, actual shortlist recall@K, final group top-1, member presence, latency/memory and cold-cache bytes on the same candidate.
- [x] Re-run all nine real images and the entire versioned synthetic acceptance corpus through the actual ranking path. Mark the three delivery gates independently: 9/9, >=80%, <=8MB. Seven of nine or a good subsample never counts as delivery.
- [x] Analyze every remaining failure by stage: geometry, source/preprocessing, candidate recall or refinement. Low rank is not proof of a wrong source or an embedding-only solution.
- [x] If classical matching meets every gate, select it without adding a model. Retire obsolete experimental model/training/runtime implementation after preserving experiment conclusions, provenance, reproducible revision/commands and verifying there are no live callers. Do not prematurely remove shared tooling.
- [x] If failures remain after proven alignment, produce a bounded retraining proposal with relevant evidence, held-out evaluation, static inference and budget constraints. Seek explicit user approval before activating 026/027; this decision task may record a completed diagnosis without claiming product acceptance.
- [x] Reconcile 025's comparison record and 026/027's conditional status. Never mark unmet model quantization, generator integration or budget criteria as passed; document supersession when the model route is not selected.
- [x] Prepare task 028's verification inputs and remaining work, including legacy-CLIP cleanup, version/cache linkage and product acceptance. Update spec/ADR routing and evidence without declaring an unverified candidate shipped.
- [x] Preserve required failing gates as failures and original baselines as baselines; distinguish headless passes, unrelated suite failures, manual checks and environment gaps. Run batch wrap-up only after implementation verification and applicable acceptance actually finish.

## Progress log

Report published at [sbi-035-aligned-route-decision.md](../reports/sbi-035-aligned-route-decision.md).

Measured on the aligned candidate (fingerprint v24, cache buster 118, aligned `alignmentVersion` 1):

| Gate | Requirement | Measured | Verdict |
| --- | --- | --- | --- |
| Nine real screenshots | 9/9 | 1/9, recall 5/9 | fail |
| Complete acceptance corpus | >=80% | 2516/7335 | fail |
| Cold-cache first query | <=8MB | 5 complete: 4 pass, 1 fail at 10,705,902 B; 4 incomplete gaps | fail |

Development partition (tuning side, 1665): 583 top-1 (35.02%), coarse recall 749 (44.98%), geometry 1347 (80.90%), failure stages geometry 318 / retrieval 664 / refinement 107 / execution 0.

Nine-shot stage split: 1 pass, 4 retrieval failures, 4 refinement failures (ranks #3, #3, #6, #10), 0 geometry failures. The superseded legacy matcher scored 3/9 on the same set, so the aligned candidate is currently a regression on this gate.

Budget failure is structural, not incidental: `aligned/index.json` is 9,970,582 bytes raw / 2,439,807 gzip, and one query fetched 164 full-resolution reference PNGs totalling 7,234,970 bytes. Both are required for the first complete refined result, so lazy loading cannot recover the gate. Of nine cold runs, five finished measuring (four under 8,388,608 bytes, one at 10,705,902 which fails) and four are incomplete gaps caused by failed remote `pack.png` / `.mcmeta` requests — gaps are not passes.

Complete acceptance partition (7335, no sampling), scored through the same ranking path the browser uses:

| Measure | Result |
| --- | --- |
| Group top-1 | 2516/7335 (34.30%) |
| Coarse recall@48 | 3357/7335 (45.77%) |
| Expected-member presence | 3357 |
| Geometry within 1px | 5895/7335 (80.37%) |
| Execution errors | 0 |
| Failure stages | geometry 1440, retrieval 2866, refinement 555, execution 0 |
| Latency per image | total p50 2188 ms, p95 3565 ms, p99 4487 ms (7335/7335 measured) |

The partition was scored as two resumable shards (0-3700 and 3700-7335) with every row persisted and fsynced, after earlier single-process runs died during finalization without writing a report. Peak sampled process RSS was 1235 MB. Per-image latency is recorded on every row so the sharding does not affect it; total compute across the partition was 16,156 s. Wall-clock throughput of the sharded run is not presented as a single elapsed figure.

Stage reading: geometry now clears 80% on the acceptance partition while top-1 sits at 34.30%, so the dominant remaining cause is coarse candidacy (2866 retrieval failures) rather than cropping (1440 geometry failures) or reranking (555 refinement failures). That ordering is the same as on development, which is evidence the two partitions measure the same behaviour.

Rejected and reverted change, recorded for the record: fitting a per-row background plate plus a vertical gradient in `compareNativeItem` and penalising unexplained foreground passed its seven focused unit tests but dropped the 12-image development slice from 6/12 to 1/12 top-1 (recall 7/12 to 4/12). It was reverted rather than tuned.

Remaining open item: the batch wrap-up itself. No gate is reported as passed, and 026/027 stay inactive pending explicit approval of the bounded retraining proposal.

Category ledger required by the last criterion, so nothing is silently upgraded:

| Category | Items |
| --- | --- |
| Preserved failures | nine-shot 1/9; acceptance 34.30% vs >=80%; cold-cache 10,705,902 B vs 8,388,608 B |
| Preserved baselines | historical light corpus 1584/2092 = 75.72% with recall@48 1999/2092, kept as a separate control and never pooled with the versioned partitions |
| Headless passes | all nine-shot runs and the full acceptance partition ran headless Chrome / Node, not an interactive browser |
| Unrelated suite failures | `npm test` 242/245: two pre-existing `plot-compatible-ingestion` failures plus one Windows `ENOTEMPTY` temp-dir flake that passes 10/10 in isolation |
| Manual checks | no interactive product-acceptance walkthrough was performed |
| Environment gaps | four cold-cache measurements incomplete because remote `pack.png` / `.mcmeta` requests failed; counted as gaps, never as passes |

This card records a completed diagnosis. It does not claim product acceptance, and task 028 remains blocked. Batch-level wrap-up and archiving belong to the batch anchor [029](029-sbi-input-alignment.md) and are not performed here.

## Blocked by

- `032-sbi-native-pair-refinement.md`
- `033-sbi-alignment-acceptance-corpus.md`
- `034-sbi-cold-query-delivery.md`
