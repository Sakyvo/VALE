# SBI 035 Aligned Route Decision

Status: **decision record, gates not met.** This report does not claim product acceptance and does not authorize shipping. Task 028 remains blocked.

The alignment-first contract is [SBI Input Alignment](../spec/sbi-input-alignment.md); the governing decision record is [ADR-0006](../adr/0006-sbi-matching-rewrite.md).

## Provenance

| Artifact | SHA-256 |
| --- | --- |
| `assets/js/sbi-engine.js` | `84793b957cdd28ed4d4fbbfef46099cf9ba3f11ac27847c03a9e7da2871f220e` |
| `assets/js/sbi.js` | `3f4d34c8489ece9e114eb6b4a1b8bfe15ed386534cde124f58dea06348943b32` |
| `scripts/sbi-eval-bench.js` | `355559ea4536704b18c6430d0ef26546217bf61cb5c1adda4614e7bd279f5ea6` |
| `scripts/generate-sbi-data.js` | `c8f25cbca20d61e4628f23d17a392b9c19692f4e278f00b4aa24846eee3e86e0` |
| `scripts/lib/synthetic-corpus.js` | `ab7fe5181ab67953968aa842acbba3b10de909c69bae4d400d40aca068c5bfc3` |
| `test_sbi.py` | `f0a41d70b6af75c5949fc2c8176b474a1412dec440fdbcd7acd988d1b5d0fa60` |
| `sbi/index.html` | `337d166c7dcd526c3132b527c6f77dd78b8b33df077855f634bbc8a183cc5736` |
| `data/sbi-fp/aligned/index.json` | `8eda7b14e330cfbe08e3d0fd7cf917f189557e1cb738c28b3509c3623d455ae9` |
| `.target/sbi-alignment-v2/manifest.json` | `1324b66908ab411fed6153f4b7ff310b710cfe7728b3bf014294a6b24c573e8c` |
| `.target/sbi-alignment-v2/plan.json` | `5d42b75d2585a940b4a2a14c0704ffb717d293423271d6cad06239079af5dd73` |

Reference metadata is fingerprint version **24** with **2694** groups. The aligned reference index is `alignmentVersion` **1** with 2694 groups and 5784 native textures. Corpus integrity receipt: manifest hash `96c5c4917f424e692f2732a43b7f95fbf9a7c84a0d7af2bd8315a7aec77abc09`, plan hash `f5a401de644b07db0446cbf270387fbbbbdaf8a5b2cd2e6b35d90c33f43318c8`, 9000 images (173,108,858 bytes), all image hashes verified, group roles disjoint. Runtime: isolated Node v22.23.4, `sharp.cache(false)`, `sharp.concurrency(1)`.

`data/sbi-fp/aligned/` (5785 files, 129.13 MB) is generated output and is not committed; it is reproduced by `npm run sbi:data`.

## Corpora

| Partition | Images | Groups | Role |
| --- | --- | --- | --- |
| development | 1665 | 514 | tuning and diagnosis |
| acceptance | 7335 | 2180 | gate measurement only |

Cross-role group overlap is **0**, so no development variant can leak into the acceptance denominator. Both partitions derive from the same frozen plan; queries, source hashes, perturbations and geometry are pinned per image.

The historical light corpus (2092 images, fingerprint v23-era) remains a separate control and is **not** pooled with either partition. Its recorded baseline is **1584/2092 = 75.72%** group top-1 with coarse recall@48 1999/2092 = 95.55% for the superseded legacy matcher ([report](sbi-030-observation-baseline.md)).

## Gate results

### Gate 1 — nine real screenshots: **FAIL (1/9)**

Measured through the browser path (`python -B test_sbi.py --matcher aligned --benchmark cold --runs 1`) against the aligned candidate, 93.40 s.

Candidate recall was **5/9**.

| Image | Result | Winning group | Expected group rank |
| --- | --- | --- | --- |
| Large - Blue 128x.png | FAIL | P0KEMONRevamped_MCBEPORT | not in candidates |
| Large - Eum3 Blue Revamp.jpeg | FAIL | l9NotRamix_64x | not in candidates |
| Large - Eum3Blue Revamp (2).jpeg | FAIL | l9NotRamix_64x | #6 |
| Large - Eum3Blue Revamp.jpeg | FAIL | Blue_128x_Revamp | #3 |
| Large - Mav War.jpeg | PASS | Dryft_War | #1 |
| Large - OTB FPS.jpeg | FAIL | Supamen | not in candidates |
| Large - PvPMen.png | FAIL | Moid | #3 |
| Large - Tory Eum3 v1 [Revamp].jpeg | FAIL | denqy_mash | not in candidates |
| Small - Eum3 Blue Revamp.jpeg | FAIL | Eum3_Blue_Revamp_Edit_4mod | #10 |

Stage attribution: **1 pass, 4 retrieval failures, 4 refinement failures, 0 geometry failures.**

The superseded legacy matcher scored 3/9 on the same nine images with the same 5/9 candidate recall, so the aligned candidate is currently **worse** on this gate. That is recorded as a regression against the legacy path, not as an improvement.

### Gate 2 — complete acceptance corpus: **FAIL**

Measured over the full 7335-image acceptance partition through the same ranking path used by the browser (`bench.evaluate` → `searchObservation`), with pinned inputs and an input-hash re-check after the run.

| Measure | Result |
| --- | --- |
| Denominator | 7335 (no sampling) |
| Group top-1 | 2516/7335 (34.30%) |
| Coarse recall@48 | 3357/7335 (45.77%) |
| Expected-member presence | 3357 |
| Geometry within 1px | 5895/7335 (80.37%) |
| Execution errors | 0 |
| Failure stages | geometry 1440, retrieval 2866, refinement 555, execution 0 |
| Peak RSS | 1235 MB sampled peak (per shard process) |
| Latency per image (7335/7335 measured) | total p50 2188 ms, p95 3565 ms, p99 4487 ms, max 11129 ms |
| Coarse stage | p50 1021 ms, p95 1431 ms, p99 1726 ms |
| Refinement stage | p50 1171 ms, p95 2269 ms, p99 3091 ms |
| Total compute | 16,156 s across the partition |

The partition was scored as two resumable shards (0-3700 and 3700-7335) with every row persisted and fsynced, after earlier single-process runs died during finalization without writing a report. The latency figures above are per-image measurements recorded on every row, so they are unaffected by that sharding; wall-clock throughput of the sharded run is not offered as a single elapsed figure.

The development partition, measured first and with the same engine, gives the tuning-side picture:

| Measure | Result |
| --- | --- |
| Denominator | 1665 |
| Group top-1 | 583 (35.02%) |
| Coarse recall@48 | 749 (44.98%) |
| Expected-member presence | 749 |
| Geometry within 1px | 1347/1665 (80.90%) |
| Failure stages | geometry 318, retrieval 664, refinement 107, execution 0 |
| Peak RSS | 948 MB |
| End-to-end | 67.26 min |

Both partitions fail the >=80% gate by a wide margin, and the failure is **not** concentrated in geometry: geometry clears 80.90% on development while top-1 sits at 35.02%.

### Gate 3 — cold-cache first-query download <=8MB: **FAIL**

Each of the nine images was loaded with a cold browser cache; every HTTP attempt was counted from CDP `Network.loadingFinished` (encoded bytes, redirects included, pending and failed requests treated as gaps rather than zero).

| Image | Bytes | Measurement | Budget |
| --- | --- | --- | --- |
| Small - Eum3 Blue Revamp.jpeg | 5,194,860 | complete | pass |
| Eum3 Blue Revamp.jpeg | 5,634,661 | incomplete | gap |
| Eum3Blue Revamp.jpeg | 5,745,283 | incomplete | gap |
| Eum3Blue Revamp (2).jpeg | 5,923,455 | incomplete | gap |
| Large - Blue 128x.png | 6,398,508 | complete | pass |
| Large - Mav War.jpeg | 6,539,061 | complete | pass |
| Large - OTB FPS.jpeg | 6,551,248 | complete | pass |
| Large - PvPMen.png | 8,349,431 | incomplete | gap (39,177 under so far) |
| Large - Tory Eum3 v1 [Revamp].jpeg | 10,705,902 | complete | **fail** |

One complete measurement exceeds the 8,388,608-byte budget by 2,317,294 bytes, so the gate fails on measured evidence. Four measurements are incomplete because remote `pack.png` / `.mcmeta` requests failed; an incomplete measurement is an evidence gap and is never counted as a pass. `PvPMen` currently sits 39,177 bytes **under** the limit, so it may land on either side once complete — finishing it cannot repair the gate, because the Tory failure is already complete and independently over budget.

The failure is structural, not incidental. For the Tory query the transfer decomposes as:

| Bucket | Requests | Bytes |
| --- | --- | --- |
| `data/sbi-fp/aligned/textures/*` | 164 | 7,234,970 |
| `data/sbi-fp/aligned/index.json` | 1 | 2,440,076 (gzip; 9,970,582 raw) |
| `favicon.png` | 1 | 325,821 |
| `data/index.json` | 1 | 126,398 |
| fonts + two pack thumbnails + engine | 5 | 792,637 |

Two independent problems follow: the published reference index alone is ~2.4 MB compressed and 9.5 MB raw, and refinement fetches up to ~164 full-resolution PNGs per query because every group in the 48-candidate shortlist can contribute several members and several item types. No amount of lazy loading fixes either, because both are required to produce the first complete refined result.

## Stage analysis

The dominant failure on synthetic data is **coarse retrieval**, not refinement:

- development: retrieval 664, refinement 107, geometry 318 of 1665 (39.9%, 6.4%, 19.1%)
- nine real screenshots: retrieval 4, refinement 4 of 9

Refinement, once the true group is in the shortlist, reorders it to the top only occasionally — nine-shot ranks were #3, #3, #6 and #10, and development keeps 107 groups that were shortlisted but not won. But the larger bucket is candidacy: at 2694 groups the compact coarse descriptor (50% sparse palette overlap + 50% 16px spatial agreement) does not place the true group inside the top 48 in roughly 55% of synthetic cases and in 4 of 9 real screenshots.

Geometry is repaired but not perfect. 318/1665 development images still miss the 1px rectangle tolerance, concentrated in the `full` profile (555 images, resized to 1600×900 with a bottom offset). Geometry is therefore a contributing but not dominant cause; the gate would not pass with perfect geometry at 35.02% top-1.

## Route decision

The classical route, with the alignment contract implemented, **misses all three gates**. Under [ADR-0006](../adr/0006-sbi-matching-rewrite.md) this authorizes a bounded retraining proposal for explicit user approval; it does not authorize activating tasks 026/027 unilaterally, and it does not authorize declaring the classical route exhausted on rank evidence alone.

Two distinct problems are separated here, and only one of them needs a model:

1. **Budget and payload shape (engineering, no model needed).** The aligned reference index and per-query native texture fetching are structurally incompatible with the 8 MB gate. Any route — classical or learned — must first publish a compact index and stop fetching dozens of full-resolution PNGs per query. Until that is fixed, the budget gate is unreachable regardless of matching quality.
2. **Coarse discriminative power (this is what a learned descriptor would address).** 664/1665 development failures and 4/9 nine-shot failures are candidacy failures at 2694 groups.

A rejected change is recorded for the record: fitting a per-row background plate with a vertical-gradient model and penalizing unexplained foreground in `compareNativeItem` passed its seven focused unit tests but reduced the 12-image development slice from 6/12 to 1/12 top-1 and 7/12 to 4/12 recall. It was reverted rather than tuned, because a change that only passes contrived unit tests while regressing real matching is not evidence.

## Bounded retraining proposal (requires explicit approval)

Scope, if approved: replace only the **coarse** stage with a compact learned descriptor, keep native-size pixel refinement as the verifier, keep browser-side static inference.

- Input: the five supported item textures per group, rendered through the same corpus renderer and the same degradation model already used by `scripts/lib/synthetic-corpus.js`, so training pairs match the capture pipeline rather than an idealised one.
- Architecture: small CNN under MobileNet scale; 128-dimensional output; ONNX export; int8 quantization target **<=3 MB**, weights committed to the repository, no training in CI.
- Embedding shard: 2694 groups x 5 types x 128d must fit inside the remaining budget **after** the index compaction in item 1 above; the current 8 MB gate counts it.
- Evaluation: development partition for tuning; the acceptance partition and the nine real screenshots for the decision, reported with the same `computeMetrics` stage split used here. A model is adopted only if acceptance >=80% **and** nine-shot 9/9 **and** the measured cold-cache total <=8 MB.
- Held-out rule: the nine real screenshots are acceptance queries and never training data; development and acceptance groups stay disjoint.

Nothing in this proposal is started until the user approves it, and item 1 is a prerequisite for any route.

## Reconciliation

- **025 (classical bake-off):** measured. The aligned classical candidate reaches 583/1665 = 35.02% on development and 1/9 on the nine real screenshots, with the cold-cache gate structurally failing. It does not meet the gates and is not selected as the final matcher.
- **026 (training pipeline):** remains **not activated**. No model was trained or adopted for this decision; the earlier 28 KB ONNX experiment is not a validated fallback and is not referenced as one.
- **027 (embedding bake-off):** remains **not activated** for the same reason. Its 8 MB shard-budget criterion was never demonstrated and is explicitly still open.
- **028 (ship winner):** remains **blocked**. Its five criteria are all still unmet; this report supplies diagnosis and inputs, not shipment evidence.

### Embedding experiment repository state

The earlier experiment is half-materialised, and the asymmetry is deliberate rather than accidental:

| Path | Git state | Role |
| --- | --- | --- |
| `scripts/ml/train_embed.py` | tracked | reproducible training command |
| `scripts/ml/render_hotbar.py` | tracked | reproducible training-pair renderer |
| `scripts/lib/sbi-embedding.js` | tracked | inference helper, `require('onnxruntime-node')` |
| `assets/models/sbi-embed.onnx` + `.data` | **untracked** | derived weights, 28,431 + 624,128 bytes |

`scripts/lib/sbi-embedding.js` hard-codes `MODEL_PATH = path.join(ROOT, 'assets', 'models', 'sbi-embed.onnx')`, which does not exist at HEAD. Verified: **no module under `src/`, `scripts/` or `tests/` imports `sbi-embedding`, and `node --test "tests/*.test.js"` never loads it**, so nothing in the shipping path or the suite is broken by this. It is dead code relative to runtime and must not be presented as a usable fallback.

Retention decision: the training scripts are kept because they are the reproducible basis for the bounded proposal below, and the criterion for this task requires preserving reproducible revision and commands. The weights stay out of git as derived output regenerable by `scripts/ml/train_embed.py --out assets/models/sbi-embed.onnx`. Deletion of this experiment is task 028's cleanup decision, not this task's, and must not happen before the user answers the proposal.

## Regression and suite status

`npm test` (`node --test "tests/*.test.js"`) reports **245 tests, 242 pass, 3 fail**. None of the three is caused by this batch, and none is being counted as green:

| Failing test | Class | Note |
| --- | --- | --- |
| `scans top-level folder packs and ZIP content with a wrong extension while ignoring junk` | pre-existing baseline failure | `tests/plot-compatible-ingestion.test.js:81`, `1 !== 2`; fails identically before this batch |
| `unwraps ZIP and folder containers through depth ten and rejects depth eleven` | pre-existing baseline failure | same file, expected folder container not detected |
| `keep-existing resolution skips upload, adds retained List id, and records alias` | environment / flake | `ENOTEMPTY: directory not empty, rmdir ...\Temp\vale-upload-plan-*` — Windows temp-dir cleanup race; the file passes **10/10** when run alone (`node --test tests/upload-folder-content.test.js`) |

All SBI suites pass: `tests/sbi-engine.test.js`, `tests/sbi-eval-bench.test.js`, `tests/generate-sbi-data.test.js`, `tests/synthetic-corpus-render.test.js` (46/46), plus `tests/test_sbi_transport.py` (3/3). Syntax checks pass for `assets/js/sbi-engine.js`, `assets/js/sbi.js`, `scripts/sbi-eval-bench.js`, `scripts/generate-sbi-data.js`, `scripts/generate-synthetic-corpus.js`, `scripts/lib/synthetic-corpus.js`.

Headless smoke test of the acceptance path: `--role acceptance --limit 2` returned geometry 2/2, confirming the evaluator wires correctly before the full run. That is a wiring check, not an accuracy result.

Manual and environment gaps, stated as gaps: no interactive browser session was used for the nine-shot runs (all headless Chrome); the four incomplete transfer measurements are unresolved because remote `pack.png` / `.mcmeta` requests failed; and no product-acceptance UI walkthrough was performed in this batch.

## Required before any shipment

1. Compact the coarse/reference index so a cold first query can be served inside 8 MB including refinement payloads.
2. Resolve the 318 development geometry misses in the `full` profile, or demonstrate they do not affect acceptance.
3. Raise coarse candidacy so the true group enters the shortlist substantially more often than 45% (development) and 5/9 (nine shots).
4. Re-run all three gates on the same candidate and report them independently.

## Evidence locations

Working evidence for these numbers is under `.target/`, which is not committed:

- `.target/035-acceptance/report.json` and `run.log` — acceptance partition, pinned inputs and source snapshot
- `.target/035-development/report.json` — development partition
- `.target/035-nine-cold.json` and `.target/035-nine-cold.log` — nine real screenshots with per-request transfer accounting
- `.target/033-corpus-integrity.json` — corpus hash verification receipt
- `.target/035-nine-cold.log` — per-image `margin` and `Expected@#` ranks

Durable artifacts are this report, the spec, ADR-0006, the task cards, and the committed engine/generator/test sources whose hashes appear above.