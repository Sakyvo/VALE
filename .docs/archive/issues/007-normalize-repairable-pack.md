Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Deliver the first complete normalized-ingestion path for one repairable wrapped ZIP: classify it with a versioned VALE-owned Plot rule snapshot, produce a reproducible Normal pack, verify visual identity, plan the normalized product, and execute it through a fake/local remote boundary without ever treating the source bytes as uploadable. Already-normal input must pass through byte-for-byte unchanged. Covers PRD user stories 1-3, 9, 14-18, and 71-72.

## Acceptance criteria

- [x] A public normalization boundary classifies an already-normal ZIP and a single-wrapper repairable ZIP using an explicit normalization schema version
- [x] The repairable fixture produces a Normal pack with a stable product SHA-256 across repeated runs, while the normal fixture remains byte-for-byte unchanged
- [x] Planning fingerprints and allocates the normalized product rather than the original source archive
- [x] One-product repair preserves the complete visual-content hash and blocks execution when that invariant is violated
- [x] The end-to-end test uses real temporary archives and fake/local catalog and remote state, with no production API calls
- [x] Temporary products and remote-work directories are removed after successful and failed runs

## Blocked by

None - can start immediately
