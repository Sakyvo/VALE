Status: done
Executor: Codex

## Parent

`.docs/prd/2026-07-21-pack-normalization-ingestion.md`

## What to build

Deliver collection ingestion end to end. Split every valid inner pack root into an independent Collection product, retain the outer source only as provenance, assign deterministic identities, run each product through content conflict and List planning, and preserve the existing reviewed duplicate-resolution boundary. Covers PRD user stories 19-26.

## Acceptance criteria

- [x] A nested collection fixture yields every valid inner root as a separate Normal product and does not upload the outer wrapper
- [x] Product filenames and pack IDs derive from inner names, with deterministic ` (n)` suffixes for distinct same-named products in one source
- [x] Each product independently receives size, visual identity, duplicate, registry allocation, and target List evaluation
- [x] Exact existing visual content is reused with provenance instead of uploaded again
- [x] Different-content collisions with an existing filename or pack ID are hard blockers until a reviewed explicit name override is supplied
- [x] Normalization does not automatically remove existing exact duplicates and cannot bypass the hash-bound retain-decision flow
- [x] Replanning the same source and decisions produces byte-identical products and equivalent manifest ordering

## Blocked by

- `008-plot-compatible-source-ingestion.md`
