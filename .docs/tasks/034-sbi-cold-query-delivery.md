Status: open
Executor: pi

## Parent

`.docs/tasks/029-sbi-input-alignment.md`

## What to build

Make the aligned matcher deliver its complete refined result using static compact coarse data and only the reference detail actually needed. Verify actual cold-cache transfer from page open to final ranking, including data overfetch, without trading away native comparison size or true-group recall to hit a byte limit.

## Acceptance criteria

- [ ] The generator and browser loader share deterministic coarse/refinement addressing and source provenance; rerunning `npm run sbi:data` produces no unexplained changes.
- [ ] Pairwise resolution remains correct for high-detail queries. Do not satisfy transfer by using a fixed 48px cap, enlarging a 16px preview, or silently excluding candidate groups.
- [ ] Select shortlist/loading granularity using measured recall, timing, memory and bytes. Prove the budget counts whole fetched buckets, retries and prefetch rather than estimating selected surfaces alone.
- [ ] Test cold and warm resource paths, duplicate fetches, missing/stale reference data, bounded decoding and release of transient buffers. Missing measurements are evidence gaps, not zero-byte resources.
- [ ] Capture exact transferred byte totals in a genuinely cold headless browser from opening SBI to the first complete refined result on the real-shot suite and representative largest-detail accepted inputs. Include page/runtime assets, metadata and coarse/refinement/model resources; report compression and byte units.
- [ ] Demonstrate <=8MB first-query transfer without regression in the fixed acceptance corpus or real-shot ranks, and report latency plus peak working memory. No separate numeric speed guarantee is invented.
- [ ] If hard gates conflict after reasonable optimization, present measured alternatives and leave this task incomplete pending user resolution; do not mark an over-budget run as passed or automatically relax a gate.
- [ ] Static hosting still suffices. Required regression, generator/version/cache linkage and deterministic output checks pass.

## Blocked by

- `032-sbi-native-pair-refinement.md`
- `033-sbi-alignment-acceptance-corpus.md`
