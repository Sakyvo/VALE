Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Provide a read-only Normalization migration audit over every registry archive. Stream each remote source through the versioned normalizer, preserve its current visibility model, emit a registry- and hash-bound migration manifest, maintain the canonical internal audit ledger and human summary, and validate explicit decisions without performing catalog or remote writes. Covers PRD user stories 40-41, 50-54, 58-61.

## Acceptance criteria

- [x] Selection covers every registry key, including entries absent from the public index, extraction records, and Lists
- [x] Each selected source is downloaded to temporary storage, verified against registry size and archive SHA-256, classified, normalized when needed, and cleaned up
- [x] The manifest binds the registry digest, every selected source identity, normalization schema version, product hashes, visibility, catalog effects, and remote effects
- [x] The audit ledger records stable source/remote identity, causes, products, lifecycle state, and timestamps without archive bytes or machine-specific absolute paths
- [x] A deterministic Markdown summary identifies normal, repairable, collection, illegal, oversize, safety-blocked, conflict, and deferred entries
- [x] Reviewed decisions support explicit defer and naming/duplicate choices; unresolved blockers keep the manifest non-executable
- [x] Registry or remote source changes invalidate stale evidence, and the entire audit path performs no catalog commit, upload, or deletion

## Blocked by

- `009-collection-product-ingestion.md`
