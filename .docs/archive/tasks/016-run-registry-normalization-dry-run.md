Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Run the completed normalization system against the full live registry in read-only mode and produce the exact reviewed evidence needed for execution. Reconcile every classification, blocker, proposed identity/List/visibility change, storage destination, and retirement action, then stop before any remote or catalog mutation. Covers PRD user stories 40, 50-54, 59-61, and 74.

## Acceptance criteria

- [x] Preflight verifies the current registry/content index relationship, GitHub authentication, temporary workspace safety, and absence of tracked archive content
- [x] The audit processes every registry entry and produces a complete hash-bound manifest, audit ledger update, and deterministic Markdown summary with no unexplained omissions
- [x] Every illegal entry, collection split, content/name conflict, safety/oversize blocker, exact duplicate, and proposed defer is reviewed and represented by an explicit decision or remains blocking
- [x] Planned repository destinations respect the 5 GiB soft threshold, sticky full markers, different-repository replacement rule, and 100 MiB product limit
- [x] Registry-only/public visibility and non-derived/managed List effects are reconciled against current catalog state
- [x] The run performs no upload, registry/List/generated-data write, or remote deletion and leaves no downloaded archive or temporary clone behind
- [x] The exact reviewed decision artifact required by execution is recorded; the issue stops before mutation if review is not granted

## Blocked by

- `010-close-archive-write-bypasses.md`
- `013-migrate-registered-collections.md`
- `014-retire-registered-illegal-material.md`
- `015-scale-sbi-fingerprint-shards.md`
