Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Extend the normalized upload path to every accepted Plot classification and repair family. Scan each top-level source entry, rescue supported files and folders, reject unsafe containers, record new illegal material without publishing it, apply post-normalization size and repository allocation policy, and expose all outcomes through the reviewed plan and audit summary. Covers PRD user stories 4-13, 27-28, 33-39, 64-66, and 71-72.

## Acceptance criteria

- [x] Top-level files and folders are scanned; known junk is ignored; links and junctions are never followed; nested directories remain containers rather than extra scan roots
- [x] Fixtures cover wrong extensions, nested ZIP/folder layers through depth ten, core filename rescue, missing metadata generation, Lunar illegal-escape repair, root bloat cleanup, junk cleanup, and dead-path cleanup
- [x] Corrupt, encrypted, unsupported real RAR/7z, coreless, and over-depth sources are recorded as illegal material and produce no upload or List membership
- [x] Entry-count, per-entry expansion, total expansion, unsafe path, link entry, and colliding-output protections produce explicit safety blockers rather than illegal classifications
- [x] The 100 MiB gate is applied after normalization; remaining oversize products are blocked without being marked illegal
- [x] Repository allocation treats 5 GiB as a soft threshold, preserves sticky full markers, and allocates new work elsewhere without invalidating existing packs
- [x] Every produced archive reclassifies as Normal before it can enter an executable plan

## Blocked by

- `007-normalize-repairable-pack.md`
