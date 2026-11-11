Status: open
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Connect authoritative reference generation to query preprocessing and real ranking using native-size pairwise refinement. Compact coarse features remain available, but the final comparison uses the smaller native side with consistent downsampling and the approved overlay exclusion mask. Reuse existing pixel comparison and extraction abstractions where they satisfy the contract.

## Acceptance criteria

- [ ] Generator/reference metadata preserves source dimensions and frame provenance; `npm run sbi:data` deterministically produces the required versioned representation without manually editing generated data.
- [ ] End-to-end pair tests verify 48/128 -> 48, 96/128 -> 96 and 96/32 -> 32, plus equal/small dimensions and existing animation-frame handling. No hidden 16/48 cap or upscaling from a preview is allowed.
- [ ] Shared sampling tests specify kernel, phase/rounding, color and alpha behavior, and verify Node/browser numerical consistency. Area averaging is evaluated as the initial candidate, not treated as proof of the game's renderer.
- [ ] Both coarse evidence and refinement apply the mask from the spec in logical coordinates. Bottom rows and lower-right overlap are excluded once; excluded pixels affect neither scores nor normalization as false background evidence.
- [ ] Real image pairs with count/durability overlays and high-frequency texture detail test mask mapping and remaining evidence. Keep identical/repeated items and do not assume the median is empty in full hotbars.
- [ ] Every live slot can compare with all supported item types; type inference remains display-only rather than excluding a reference from retrieval/ranking.
- [ ] Browser and offline ranking consume this path, not a benchmark-only substitute. Record candidate loss separately from reranking error and compare against the same-input baseline.
- [ ] Focused tests, project regression, deterministic regeneration, schema/version rejection and HTML cache linkage pass; transfer compliance is separately verified by 034.

## Blocked by

- `031-sbi-crop-geometry.md`
