Status: open
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Generate a versioned screenshot acceptance corpus with known geometric truth and realistic overlays/transformations, then evaluate it through the verified production/offline path. Preserve the old light corpus as a historical control instead of overwriting it to make old numbers appear comparable. This slice can develop fixtures in parallel with the geometry/refinement slices once measurement parity is established.

## Acceptance criteria

- [ ] Fix manifest/version, source hashes, seeds, truth groups, transforms and development/acceptance allocation before tuning. Separate related query variants across evaluation roles; the nine real screenshots are never training examples.
- [ ] Extend the existing renderer with resized/fractional effective-scale screenshots, stack counts, durability bars and controlled JPEG/brightness changes. Include sparse/full/repeated-item hotbars and known first/last-slot bounds.
- [ ] Ground truth derives from source identity and known geometry, not the matcher's prediction; a renderer/extractor sharing the same erroneous geometry cannot certify each other without independent rectangle assertions.
- [ ] One offline command runs the entire acceptance manifest, with representative headless-browser parity checks. Output geometry correctness, pre-refinement recall@K, final group top-1, member presence, failures and timings.
- [ ] Every manifest case remains in the acceptance denominator. Missing predictions fail; invalid truth or missing source data is explicitly diagnosed and resolved, never silently filtered to improve scores.
- [ ] Record legacy-control and upgraded-corpus results separately. Component/palette-only results and parameter sweeps are labeled development evidence, not final acceptance.
- [ ] Generated data and caches have deterministic provenance and stale-cache tests; acceptance reports identify the complete production path being measured. Heavy-tier stress tests remain diagnostic.

## Blocked by

- `030-sbi-observation-parity.md`
