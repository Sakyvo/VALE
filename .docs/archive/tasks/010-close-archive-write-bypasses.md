Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Make normalized ingestion the only archive-write boundary. Route supported single-file convenience behavior through it, prevent legacy migration tooling from being used for new uploads, and remove direct archive creation/deletion from browser administration while preserving non-archive catalog and List workflows. Covers PRD user stories 62-64.

## Acceptance criteria

- [x] Every supported command that writes a pack archive delegates to the normalized planning and execution path
- [x] Legacy migration behavior rejects use as a new-upload shortcut with a clear nonzero failure
- [x] Browser administration cannot create or delete archive blobs or write a main-repository `resourcepacks/` path
- [x] Existing browser-side List and non-archive catalog administration remains functional
- [x] Automated checks cover the delegated command path, rejected legacy path, and absence of browser archive-write requests
- [x] The main repository remains free of tracked ZIP archives and `resourcepacks/` content

## Blocked by

- `007-normalize-repairable-pack.md`
