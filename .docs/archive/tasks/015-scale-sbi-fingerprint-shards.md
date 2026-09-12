Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Make SBI fingerprint output sharded-only and able to grow by thousands of packs. Remove the duplicate monolithic artifact, split oversized observation shards by a deterministic key around the accepted size target, publish metadata that lets the browser load the required subshards, and preserve current matching behavior. Covers PRD user stories 67-70.

## Acceptance criteria

- [x] Generation no longer writes or retains a monolithic SBI fingerprint artifact, and no runtime or test path depends on it
- [x] Base observation shards split deterministically when they would exceed the approximately 32 MiB target, with stable assignments across repeated generation
- [x] Metadata maps observation types and stable buckets to generated files so the browser loads only the shards needed for a query
- [x] No arbitrary total dataset ceiling is introduced, and every generated file remains below GitHub's hard per-file limit
- [x] Version constants and cache references advance together when the shard contract changes
- [x] Repeated generation is byte-stable, stale shard files are removed, and the existing labeled SBI regression corpus retains its expected top result

## Blocked by

None - can start immediately
