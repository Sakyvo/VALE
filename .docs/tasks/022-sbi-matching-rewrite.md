Status: anchor
Executor: pi

## Problem

SBI must put the corresponding resource-pack group first while remaining responsive and statically hosted. The initial nine-shot run reported 2/9 at roughly 2694 groups, but the often-quoted 39.1% synthetic result belongs to older v20-era tasks 016/018, not a measured full v23 baseline. Later experiments do not establish that classical descriptors are exhausted or that the source textures are wrong.

## Decisions

- Final delivery remains real-shot group top-1 9/9, full synthetic acceptance group top-1 >=80%, and <=8MB cold-cache first-query download. Group semantics remain governed by ADR-0005.
- The accepted alignment-first revision of [ADR-0006](../adr/0006-sbi-matching-rewrite.md) supersedes the original automatic fallback to a hybrid embedding matcher.
- [Batch 029](029-sbi-input-alignment.md) owns measurement parity, geometry, sampling, native-size refinement, acceptance-corpus and delivery-budget prerequisites. The authoritative contract is [SBI Input Alignment](../spec/sbi-input-alignment.md).
- Type inference is ultimately display-only, not a hard matching gate. Preserve the five item types and existing HUD/widget capabilities.
- Static hosting and browser-side matching remain required. If a model is subsequently justified and approved, reference generation still goes through `npm run sbi:data` and CI does not train.
- Remove obsolete CLIP dependencies and experiment implementation through their assigned cleanup work, preserving conclusions and reproduction provenance rather than treating old models as validated fallbacks.

## Out of scope

- Making heavy-tier stress tests an automatic shipping gate.
- VPS matching, arbitrary acceptance relaxation or changing observable equivalence to pass tests.
- Remote pack replacement/deletion based on matcher ranks.
- Extraction repair was excluded in the original batch; that prerequisite is now explicitly owned by batch 029, not silently added to the old matcher-only cards.

## Testing strategy

Reuse the actual engine offline and prove parity with headless browser behavior. Report crop correctness, pre-refinement recall@K, final group top-1, member presence and transfer separately. Freeze complete manifests and preserve failures in the denominator; do not substitute component scores or small-sample sweeps for acceptance.

Run `npm test`, syntax checks, `python test_sbi.py` and applicable generation/cache/version linkage. Existing unrelated failures must be recorded, not described as a green suite. Tasks 023-027 were previously labeled done without complete supporting evidence; their reopened cards now route verification to 030 or 035. Task 028 remains the shipping gate.
