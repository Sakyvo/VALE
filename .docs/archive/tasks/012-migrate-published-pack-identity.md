Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Migrate a registered one-product Repairable pack without downtime. Preserve its Published pack identity and visibility, stage the verified same-named Normal replacement in another eligible repository, switch site state only after verification, and advance a resumable monotonic lifecycle through deployed verification and old-archive cleanup. Covers PRD user stories 42-45, 55-58, 64, and 73.

## Acceptance criteria

- [x] A one-product migration preserves archive filename, pack ID, route, upload date, List memberships, and public or registry-only visibility
- [x] The normalized product must match the source complete visual-content hash and pass Normal reclassification, size, archive hash, and remote verification
- [x] The replacement is staged under the preserved filename in a different capacity-eligible repository while the old archive remains available
- [x] Site preparation switches registry/content identity and derived download data only to a verified staged product
- [x] Lifecycle state advances monotonically through staging, site preparation, deployment verification, old deletion, and completion; retries reuse verified work
- [x] Stale remote hashes abort safely, and an unproven staged artifact is recorded as an orphan instead of being deleted automatically
- [x] An online product that remains over 100 MiB is left unchanged and explicitly deferred

## Blocked by

- `011-audit-registered-pack-normalization.md`
