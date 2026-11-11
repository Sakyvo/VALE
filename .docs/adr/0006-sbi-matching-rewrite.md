# SBI Matching: Verify Input Alignment Before Choosing a New Matcher

Status: accepted design; not an implementation or delivery claim.

## Current decision

Repair and verify crop geometry and query/reference preprocessing before choosing between classical matching and retrained embeddings. Preserve native item crops and reference frames; refinement compares each pair at the smaller native size, downsampling only the larger side. Keep compact coarse retrieval separate and measure its actual shortlist recall. The authoritative behavior and measurement contract is [SBI Input Alignment](../spec/sbi-input-alignment.md), implemented through [batch 029](../tasks/029-sbi-input-alignment.md).

This revision supersedes the original automatic transition from a failing classical baseline to a hybrid embedding matcher. Retraining requires verified input alignment and evidence from remaining failures, followed by approval of the bounded retraining proposal; a hit-count cutoff alone is insufficient. If classical matching meets all delivery gates, do not add a model and retire obsolete experiment implementation while preserving conclusions and reproduction provenance.

## Gates and rejected alternatives

Final acceptance remains real-shot group top-1 **9/9** plus **>=80%** over the complete versioned synthetic acceptance corpus, with **<=8MB actual cold-cache downloads** from opening SBI until the first complete refined result. Lazy-loaded refinement, metadata, required scripts and any model/runtime count toward that total. A 7/9 result is progress only. If all gates cannot be met together, present measured alternatives for a user decision rather than silently lowering resolution, recall or the budget.

- Reject compulsory enlargement to 512x512: it does not recover missing source information and increases working-set and transfer costs if published literally.
- Reject a universal 16px or 48px refinement cap: it discards available detail, including a 96px query compared with a 128px reference. This does not prohibit a compact coarse descriptor.
- Retain static hosting and browser-side matching rather than adding a VPS/API.
- Reject automatic adoption of the old CLIP or experimental CNN pipeline. Neither has verified delivery-quality evidence; this is not a claim that all learned descriptors are unsuitable.

## Historical context and evidence corrections

The initial rewrite proposal compared stronger classical features with a small contrastive CNN, with a possible embedding-led hybrid and pixel verification. That was a hypothesis, not an established remedy.

The **39.1%** synthetic top-1 figure comes from the older v20-era reports in [016](../tasks/016-synthetic-evaluation-corpus.md) and [018](../tasks/018-sbi-two-tier-retrieval.md), not a newly measured full v23 baseline. Those records also differ in denominator labeling (2090 evaluated versus 2092 generated), which must be reconciled before numerical comparison.

Later session experiments reported 2/9 then 3/9 on the real screenshots, and 1621/2092 (77.5%) for the standalone palette scorer. That palette result is not proof of the complete browser path's accuracy or of a causal gain from any single patch. Sampling, replay fidelity and crop geometry need validation before the experiments can support an architecture verdict.

Poor ranks do not prove wrong source textures. The 32/16 pixel-size mismatch, inconsistent crop scale and assumed empty-slot plate are testable failure hypotheses, not evidence that hand-crafted features are exhausted or that changing reference sources is the only solution. Likewise, sampled compression estimates, including 5.6MB plus 2.5MB before other assets, do not establish compliance with the 8MB first-query gate.
