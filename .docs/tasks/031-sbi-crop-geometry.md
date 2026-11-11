Status: open
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Carry one verified hotbar geometry from screenshot detection through item/HUD extraction into browser and offline matching. Preserve native item-region pixels and rectangles alongside existing compact features. Correct independent slot-scale drift without assuming that every resized screenshot must have an integer effective scale.

## Acceptance criteria

- [ ] Known-geometry regression fixtures include first/last slots, vertical offsets, integer and fractional effective scales, resized full screenshots and supported HUD crops. Item/widget/HUD geometry shares the same validated scale.
- [ ] A standard 546px-wide hotbar does not use an independent 3.45 slot step; tests catch cumulative slot drift rather than only checking the center slot.
- [ ] Reviewed overlays on the nine real screenshots establish crop bounds independently of ranking. Resized inputs are not blindly snapped to integral scale; ambiguous/invalid geometry is reported explicitly.
- [ ] The observation and replay paths retain native source rectangles and dimensions, including 48px and 96px item regions, without passing through a 16px preview first.
- [ ] Browser matching consumes the corrected observations; diagnostics, crop controls, HUD/widget behavior and source-image handling remain usable.
- [ ] Compare geometry correctness, recall and final rank before/after on the same versioned inputs; do not claim a higher top-1 alone proves crop correctness.
- [ ] Focused TDD, direct/replay/browser parity, project regression checks and required cache/version linkage pass; record any unrelated baseline failures separately.

## Blocked by

- `030-sbi-observation-parity.md`
