Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Consume the exact approved full-registry manifest and carry the one-time Normalization migration through verified staging, site preparation, deployment, and remote cleanup. Regenerate every affected catalog artifact, complete audit state, prove there are no broken or stale references, and archive this finished issue batch with its PRD only after all retained downloads and deletions are verified. Covers PRD user stories 29-31, 42-49, 55-58, 64, and 74.

## Acceptance criteria

- [x] Execution rejects any registry digest, source hash, normalization schema, product hash, or reviewed-decision mismatch before mutating state
- [x] Every accepted normalized product is staged and remotely verified before registry, content identity, extraction, List, page, or SBI state switches to it
- [x] Authoritative catalog, route, managed List, and sharded SBI generators complete with deterministic reviewed diffs and no monolithic SBI artifact
- [x] Deployment verification proves every retained public download and route works, every retired identity is absent, and all List references resolve
- [x] Only after deployment verification are old/rejected remote archives hash-verified and deleted; failures retain resumable state and never guess at cleanup
- [x] Final registry/content-index coverage, audit lifecycle states, List uniqueness, generated download URLs, shard sizes, and remote files all reconcile
- [x] No tracked ZIP, main-repository `resourcepacks/`, temporary download, or retained upload clone remains after success or handled failure
- [x] After human verification, the completed PRD and the full `007-017` batch are archived together according to the project wrap-up workflow

## Completion evidence

- Production execution: `complete`; final reconciliation registry/content/remote `1121/1121/1121`, 741 generated pack routes, 8 SBI shards.
- Migration state: 127 `complete`, 30 `deferred`; no illegal retirement entries in this reviewed batch.
- Validation: Node 134/134, SBI Edge 9/9, tracked ZIP/resourcepacks 0, no upload workspace or reconciliation checkpoint.
- Commits: `63a394a6` catalog migration, `4bb2f2f6` resumable final reconciliation and completed state.

## Blocked by

- `016-run-registry-normalization-dry-run.md`
