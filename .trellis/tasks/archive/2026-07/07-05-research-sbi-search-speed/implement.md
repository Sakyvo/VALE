# Full-Corpus SBI Implementation Plan

## Delivery Rule

Complete the phases in order. Do not publish full SBI data, delete a remote archive, or resolve existing duplicate groups automatically. Preserve the committed version 15 / 192-pack data until the full-corpus accuracy and performance gates pass.

## Phase 0: Baseline and Safety Snapshot

- [x] Pull `main` and record the exact baseline commit used by the 192-pack rollback path.
- [x] Run `python test_sbi.py --quiet` and retain the 9/9 names, margins, candidate counts, and stage timings.
- [x] Record current shard byte sizes and confirm `SBI_FINGERPRINT_VERSION` agrees between generator and client.
- [x] Confirm the worktree contains no `.zip`, `resourcepacks/`, or persistent `packs-NNN` clone before and after each later phase.

Checkpoint: no behavioral or generated-data change.

## Phase 1: Canonical Visual-Content Fingerprint

- [x] Extract nested archive-root resolution from `extract-textures.js` into a reusable helper without changing existing extraction behavior.
- [x] Add `scripts/lib/pack-content-fingerprint.js` with explicit visual-path classification, exact raster decoding, supported config canonicalization, stable manifest ordering, SHA-256 aggregation, and resource limits.
- [x] Return aggregate hash, archive hash, entry count, and effective stone/iron/diamond pixel hashes.
- [x] Treat duplicate canonical paths, unsupported visual formats, invalid PNG/config data, unsafe expansion, and ambiguous roots as blockers.
- [x] Add Node tests that create archives only in OS temporary directories.
- [x] Cover ignored metadata, exact duplicates, every required visual difference, animation/config normalization, and failure behavior.

Validation:

```text
node --test tests/pack-content-fingerprint.test.js
node --check scripts/lib/pack-content-fingerprint.js
```

Checkpoint: hashing library only; upload and remote repositories remain unchanged.

## Phase 2: Remote Content Index and Manual Scan

- [x] Define versioned `data/internal/pack-content-index.json` and alias/resolution schemas.
- [x] Add a sequential remote scanner that resolves URLs from `pack-registry.json`, streams each archive to OS temp, fingerprints it, and removes it in `finally`.
- [x] Add resumable checkpoints and retry of explicit failures without trusting filename alone.
- [x] Compute and validate a canonical registry digest and index coverage.
- [x] Emit exact duplicate groups as a review manifest and readable docs report; do not mutate packs, registry, Lists, or public indexes.
- [x] Smoke-test a small registry subset, assert temp cleanup, then run the full scan.
- [x] Review scan failures before marking the operational index complete.

Validation:

```text
node --check scripts/scan-pack-content.js
node scripts/scan-pack-content.js --limit 3 --output <temporary-path>
node scripts/scan-pack-content.js --resume
```

Checkpoint: a complete content index and unresolved duplicate report exist; no deletion occurs.

## Phase 3: Upload Duplicate Blocking and Resolution

- [x] Refactor `upload-folder.js` planning to await incoming archive fingerprints before repository allocation.
- [x] Refuse upload execution when the content index is absent, incomplete, stale, or has unresolved scan failures relevant to comparison.
- [x] Emit `blocked_content_duplicate` entries containing incoming archive hash, visual hash, existing matches, and index digest.
- [x] Add a reviewed resolution manifest whose decisions are rejected if source or index hashes changed.
- [x] Implement keep-existing: skip upload, add retained pack to the requested List, and persist the discarded alias.
- [x] Implement keep-incoming as explicit stages: upload and verify, migrate/deploy references while old remains, then separately clean up only after verification.
- [x] Ensure all temporary remote clones and copied archives are removed after successful push and on handled failure.
- [x] Prevent `--skip-blockers` from bypassing content-index integrity or unresolved duplicate decisions.
- [x] Test upload plans with runtime-created archives and mocked registry/index data; do not write remote repositories in automated tests.

Checkpoint: dry-run duplicate behavior and local migration planning require human review before any live execution.

## Phase 4: Conquest/Overlay Management

- [x] Preserve `stone_sword.png` in future thumbnail extraction for inspection.
- [x] Add a versioned special-pack override file with `forceInclude`, `forceExclude`, and mandatory reasons.
- [x] Classify Conquest from archive-index effective sword hashes using the any-two-of-three exact rule.
- [x] Generate a stable classification report with matched pair or override reason.
- [x] Update/create the `Conquest` List while preserving non-managed fields.
- [x] Update both `Conquest` and `Overlay` descriptions with their SBI-exclusion reason.
- [x] Generalize SBI exclusions to the exact List-name set `Overlay`, `Conquest`.
- [x] Separate list detection from SBI generation/version bumping; support a mutation-free dry-run.
- [x] Add tests for all three matching pairs, no-match, missing/default textures, and both override directions.

Validation:

```text
node scripts/detect-special-packs.js --dry-run
node --test tests/special-pack-detection.test.js
node scripts/generate-index.js
```

Checkpoint: inspect List diffs and confirm excluded packs remain publicly discoverable through their Lists.

## Phase 5: Deterministic Full-Corpus SBI Build

- [x] Remove the temporary 192-pack allowlist from the production generation path while retaining `--pack-list` for diagnostics.
- [x] Compute stable per-surface keys and exact full-observable group IDs for all eligible packs.
- [x] Choose deterministic representatives and sorted member arrays.
- [x] Compute per-surface group frequencies and bounded rarity metadata.
- [x] Emit versioned `data/sbi-fp/meta.json`; change shard pack/index keys from pack names to group IDs.
- [x] Emit excluded counts and assert no `Overlay`/`Conquest` member appears in metadata or shards.
- [x] Add a repeat-generation byte comparison and schema validation.
- [x] Keep version 15 active while tuning; do not bump public cache versions yet.

Validation:

```text
node --check scripts/generate-sbi-data.js
node scripts/generate-sbi-data.js
node scripts/generate-sbi-data.js
git diff --exit-code -- data/sbi-fp data/sbi-fingerprints.json
```

The deterministic check should use clean snapshots or hashes rather than reverting unrelated worktree changes.

Checkpoint: generated group counts and duplicate families agree with diagnostics; exclusions are zero-leak.

## Phase 6: Group-Aware Retrieval and Ranking

- [x] Load and version-check SBI metadata before merging typed shards.
- [x] Convert signature/dHash candidate votes and metrics to group IDs.
- [x] Keep indexed retrieval conservative and measure expected-group recall separately from final rank.
- [x] Replace expensive all-pack fallback with an all-group cheap coarse pass followed by bounded full scoring.
- [x] Apply per-surface rarity to strong matching evidence with global floors/caps; retain DS/EP/HL/food semantic priorities.
- [x] Remove repeated full diagnostics outside the bounded set and visible results.
- [x] Decide fallback and margins on distinct groups before result expansion.
- [x] Expand exact members to equal raw/display scores and deterministic ordinary cards without labels.
- [x] Keep non-identical near duplicates independently ranked regardless of margin.
- [x] Assert Overlay/Conquest results cannot be constructed even from stale client state.

Checkpoint: tune only global parameters. No pack-name exception or canonical-name priority is allowed.

## Phase 7: Regression and Performance Harness

- [x] Extend `test_sbi.py` to accept exact top-score group membership while retaining exact-name top-1 for distinguishable packs.
- [x] Report pre-full-score candidate recall and fail if an expected group is absent.
- [x] Add `--base-url` for deployed-site checks without starting a local server.
- [x] Add repeatable cold/warm benchmark modes with p50/p95 output.
- [x] Add a forced global-fallback benchmark and include its match time in the reported fallback distribution.
- [x] Record load, extraction, coarse, full-score, expansion, render, total, candidate counts, and fallback rate.
- [x] Tune rarity and retrieval parameters until the current 9 screenshots pass against the full eligible corpus.
- [x] Test with a generated/sampled corpus of at least 1,000 group records for the performance gate without claiming extra accuracy coverage.

Required gates:

```text
correctness: 9/9 under exact-name or exact-group semantics
candidate recall: 9/9 expected groups reach full scoring
cold total p95: <= 2.0s
warm total p95: <= 1.2s
match p95: <= 150ms, including forced/global fallback
```

Checkpoint: retain reports in the task evidence. Explicitly state that only 9 real screenshots were tested.

## Phase 8: Quality Gate and Atomic Release

- [x] Run syntax checks on every changed JavaScript file and all targeted Node tests.
- [x] Run special List dry-run, deterministic SBI generation, 9-image regression, and full benchmark suite.
- [x] Run `trellis-check` and inspect generated/data diffs for unrelated churn.
- [x] Verify the main repository contains no `.zip`, `resourcepacks/`, or persistent pack-repository clones.
- [x] Record the exact pre-release 192-pack commit for rollback.
- [x] Increment `SBI_FINGERPRINT_VERSION` in generator/client and increment the `sbi.js` cache buster together.
- [x] Regenerate all full-corpus shards once under the release version.
- [x] Commit matcher, metadata, shards, List/index changes, tests, and version bumps atomically at the workflow commit phase.
- [x] Push `main`, wait for the GitHub Pages workflow, and confirm the deployed commit/artifact.
- [x] Verify all production shards load and run the 9 screenshots through `--base-url https://vale.cc.cd`.

Do not finish while a deployment/test process is still running.

## Verification Evidence

- Release commits: `db7e11e9` (atomic full-corpus release) and `7a40f470` (deployed readiness probe); rollback baseline: `4bce87ba`.
- Published cache contract: fingerprint version `16`; `sbi.js` cache buster `103`.
- Corpus: 699 searchable packs, 659 exact observable groups; 23 Overlay and 22 Conquest List members excluded with zero shard leakage.
- Content identity: 1113/1113 registry archives indexed, zero failures, registry digest `5a90459dead1f676f06776eefc1c51d3ffe9a917467cc10070b61dd6f0a76899`.
- Determinism: two version-16 generations produced identical SHA-256 hashes for every SBI output.
- Tests: `npm test` 37/37; 18 changed JavaScript files pass `node --check`; special List dry-run reports 22 Conquest and 23 Overlay packs.
- Accuracy: local and deployed 9/9 top-1, candidate recall 9/9. This is evidence for the 9 known screenshots only, not corpus-wide accuracy.
- 1,000-group Edge benchmark, 45 searches per mode: warm p95 922.9 ms total / 114.2 ms match; cold p95 1046.8 ms / 148.5 ms; forced-fallback warm p95 839.0 ms / 112.2 ms; forced-fallback cold p95 991.8 ms / 143.0 ms.
- Repository boundary: no tracked zip, no tracked `resourcepacks/`, and no persistent `.vale-pack-upload` staging directory.

## Rollback Procedure

Use this only if production loading, exclusions, accuracy, or budgets fail:

1. Restore the matcher and 192-pack data behavior from the recorded baseline without destructive worktree commands.
2. Set a fingerprint version greater than the failed full-corpus release.
3. Increment the `sbi.js` HTML cache buster again.
4. Regenerate/validate the restored shards under the new version.
5. Commit and push the rollback atomically.
6. Wait for Pages deployment and rerun the production 9-image smoke test.

Never roll the numeric fingerprint version backward.

## High-Risk Files and Review Points

- `scripts/upload-folder.js`: remote-write ordering and blocker enforcement.
- `scripts/lib/pack-content-fingerprint.js`: false duplicate risk and archive safety.
- `data/internal/pack-content-index.json`: completeness and registry binding.
- `scripts/detect-overlay.js` / proposed special detector: managed List preservation.
- `l/lists.json`: large generated membership diffs and descriptions.
- `scripts/generate-sbi-data.js`: deterministic grouping, frequency metadata, and exclusions.
- `data/sbi-fp/*.json`: schema/size/version consistency.
- `assets/js/sbi.js`: candidate recall, fallback cost, ranking semantics, and expansion.
- `test_sbi.py`: exact-group correctness and percentile methodology.
- `sbi/index.html`: cache-buster coordination.

Remote archive cleanup and full SBI release are separate explicit review points even when all earlier code is complete.
