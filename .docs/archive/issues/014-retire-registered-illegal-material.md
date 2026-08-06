Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Retire registered illegal material through an explicit two-phase catalog and remote cleanup. Prepare complete removal from the site and internal catalog, verify deployment has no remaining references, delete only the hash-verified remote archive, and preserve a durable audit tombstone without creating public illegal-material UI. Covers PRD user stories 29-32, 55-61, and 73.

## Acceptance criteria

- [x] Site preparation removes the illegal identity from registry, content identity, extraction records, every List, thumbnails, generated pack data/pages, and SBI inputs
- [x] Generated public indexes and Lists contain no reference to the retiring pack before remote cleanup becomes eligible
- [x] Deployment verification checks the live catalog and rejects cleanup while any public reference remains
- [x] Remote cleanup re-verifies repository, filename, size, and archive SHA-256 immediately before deletion
- [x] A completed retirement leaves an internal tombstone with source identity, causes, prior remote location, hashes, lifecycle times, and final status
- [x] No public `非法材质` List or page is created, and newly discovered illegal sources remain non-upload actions
- [x] Preparation, verification failure, already-absent remote state, and resumed completion are idempotent and covered by fake-remote tests

## Blocked by

- `012-migrate-published-pack-identity.md`
