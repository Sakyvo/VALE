# SBI 030 Observation Baseline

This report records the completed pre-alignment measurement, not the current worktree's accuracy or a delivery verdict. Task 030 owns measurement fidelity; tasks 031-035 own subsequent alignment and candidate verification.

## Full historical light run

Command: `node scripts/sbi-eval-bench.js current --report .target/030-full-baseline.json` (equivalent public entry: `npm run sbi:eval -- --report <path>`).

The first run stopped after 1101 complete observations without an explanatory error. The checkpoint was validated; the next samples decoded successfully. `.target/030-run-baseline.cjs` resumed under unchanged provenance and completed the full manifest. A later newline-repair regression changed persistence code; it did not retroactively change this baseline.

| Measure | Result |
| --- | --- |
| Manifest denominator | 2092 |
| Final group top-1 | 1584/2092 = 75.7170% |
| Pre-refinement coarse recall@48 | 1999/2092 = 95.5545% |
| Expected member present in final ranking | 1982/2092 |
| Errors counted as failures | 8 |
| Scoring replay time | 880106ms |
| Engine/data version | 23 |
| Node / canvas / sharp | v26.11.1 / 1.1.0 / 0.33.5 |

All non-error predictions used 48 candidate groups. Error rows have no candidates. The eight failures are two images each for `KOTH_Sword_Overlay_v1`, `Anti_-_Invisibility_overlay`, `JaspayBuu_nooverlay`, and `KOTH_Sword_Overlay_v4`. They remain in the historical corpus but their packs are in the current Overlay exclusion list and absent from reference metadata. They were not removed from the denominator or relabeled.

The historical manifest has no independent crop rectangles. Therefore this run does **not** prove crop correctness. New `measureGeometry` reports native/widget bounds against explicit known geometry for versioned corpora, separately from ranking. An absence of extraction errors is not equivalent to correct crop geometry.

## Browser/direct/replay evidence

Evidence was collected with the then-current shared `prepare/load -> extract -> searchObservation` semantics (the `prepareSearch` method name was introduced later). Browser normal search and the test hook share the ranking function. Cache records preserve typed arrays, activity, variants, refinement views, widget/HUD structure and geometry instead of flattening HUD evidence.

- Real PNGs `Large - Blue 128x.png` and `Large - PvPMen.png`: identical observed values, candidates and rankings between Node and headless Chrome.
- JPEG `Large - Eum3 Blue Revamp.jpeg`: 12 differing numeric values, maximum difference 1, no structural difference; identical candidates and ordering, maximum score difference `0.000005223333432113897`. This is the measured fixture tolerance, not permission to accept changed candidate membership or top-1 elsewhere.
- Sparse, full and repeated-item synthetic hotbars: observations, candidates and rankings identical between Node and headless Chrome.
- Direct observation versus JSON cache replay: regression tests compare results and candidate IDs; separate structural tests preserve typed-array kinds, native rectangles, all slot variants and structured HUD fields.
- Cache tests cover schema/provenance/manifest mismatches, interrupted writes, trailing corruption and a missing final newline. Only complete validated caches may be evaluated as full runs.

The real-shot harness at this baseline reported **3/9**, candidate recall **5/9**, in 18.69s. That is a failed delivery gate, not a parity failure. Later native candidate runs must identify their own code/data and are not this baseline.

## Provenance and working evidence

Full per-case results and all input-file hashes are in `.target/030-full-baseline.json`. The source snapshot is `.target/030-baseline-source/`; the extracted cache is `.target/sbi-bench/observations-v1-08c424c99ae84c69d99d474d.ndjson`. These working artifacts remain needed by this batch and must not be cleaned as obsolete experiments.

| Artifact | SHA-256 |
| --- | --- |
| Full report | `c963bb53cc6616f65730c306f642776753834d3fcba56a2786bb2ef7f7ad76df` |
| `.target/030-provenance.json` | `74e98a9aa6b775a69aacb5ce4badf98d9b46c538a99354a53f8d7178d387b551` |
| Baseline `sbi-engine.js` | `6a2bad3af7098e9b688bc51273323f64f3e0407e7c5c2507e74254230f33cabe` |
| Baseline `sbi-eval-bench.js` | `7ac960fd1a896a891ee1f80dc52963fc95031091afe5bbd6866a3a0c5e856ea5` |
| Baseline `sbi.js` | `789efa2ba30ef413254c152cc2ce819da33f19c21dbdb970e2818410f585ebe5` |
| Historical manifest | `691a7f1236625103fb549dc617611534612c0916630de4ddbc8b65f7fc1230f7` |
| Image-list content digest | `cc712b4537c739e8cb176db886b2a2d0dc2c3528d598dfb23b6092ab2fa0b050` |
| `.target/030-browser-parity.json` | `4f7d57340c964b8f13d6a090d9d8349591e3568d2712678053f6502239568299` |
| `.target/030-browser-fixtures.json` | `fac89779f3fde21ea51a24046d6225c0f00ee93d807a399b26c1be3141748f7e` |

Reproduction must use these source and reference hashes, not today's engine against yesterday's cache. The report includes reference hashes; current v24 generation has since changed the reference files. This document does not imply the full v23 inputs are all archived or that a clean checkout alone recreates the run.

## Reconciliation and remaining evidence

- Task 016 says 2092 generated but 2090 evaluated, with a v19 heading; task 018 repeats the rates under v20 and labels 2092. The two omitted historical rows are not identified by the available records. Those rates cannot be retroactively relabeled as 2092-denominator measurements. The new run uses all 2092 and records every failure.
- Task 023's original bitwise score-parity claim remains **unproven**. Equal 2/9 counts and top-1 names are weaker evidence; the later engine snapshot includes ranking changes. Current browser/replay parity does not prove historical pre/post-split equivalence.
- The latest project suite run in `.target/033-project-suite.log` reports 228/230 passing, with the two previously recorded `plot-compatible-ingestion` folder-container failures. This is not an all-green suite. Relevant source files are unchanged by the SBI patch; no ingestion changes are authorized by this batch.
- Required follow-up: refresh parity for the final aligned candidate, complete independently checked geometry reporting, preserve source/data reproduction inputs at wrap-up, and verify final version/cache linkage. These gaps keep task 030 open until its checklist is audited; they do not invalidate the completed measured baseline above.
