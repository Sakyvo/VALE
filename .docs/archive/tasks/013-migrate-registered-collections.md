Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Migrate a registered collection through the same reviewed lifecycle. Stage and verify every accepted Collection product, preserve the parent's visibility and non-derived List intent, recompute managed visual classifications, publish the products, and retire the obsolete parent identity only after the replacement catalog is deployable. Covers PRD user stories 20-25, 46-49, 55-58, and 73.

## Acceptance criteria

- [x] Every accepted Collection product has an independent verified archive, Published pack identity, registry/content identity record, and extracted public state when inherited visibility requires it
- [x] Products inherit all non-derived parent List memberships exactly once; `Overlay` and `Conquest` are recomputed from product data rather than inherited
- [x] Registry-only collections yield registry-only products, and public collections yield public products without widening visibility
- [x] Exact-content reuse, explicit existing-name overrides, stable same-source suffixes, and unresolved conflict blockers behave the same as new collection ingestion
- [x] The parent is removed from registry, content identity, extraction state, Lists, thumbnails, pack data, routes, and SBI inputs only after all retained products are verified
- [x] Deployment verification proves products are reachable and the parent is absent before the old parent archive can be deleted
- [x] Interrupted and repeated execution is idempotent and preserves at least one valid remote archive throughout

## Blocked by

- `012-migrate-published-pack-identity.md`
