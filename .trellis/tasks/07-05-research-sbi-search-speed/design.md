# Design Research

## Current Pipeline

1. Load base fingerprint shards from `data/sbi-fp/*.json`.
2. Decode the uploaded image and extract hotbar, widget, and HUD features.
3. Infer display slot types.
4. Optionally load the `food` shard.
5. Build signature prefilter candidates from shard `_index` bucket maps.
6. Score packs in `matchPacks`, combining slot, HUD, and widget scores.
7. Sort results and retain detailed diagnostics.

## Bottlenecks At Full Scale

- Network and parse: base shard payload could grow from about 1.57 MB to roughly 9 MB uncompressed if all Sakyvo packs are fingerprinted.
- Candidate count: current 192 packs may become 1100+ candidates.
- All-pack widget pre-scan: `matchPacks` computes widget similarity for all packs before applying candidate filtering.
- Detailed scoring: the main loop computes per-slot alternative comparisons and HUD comparisons for every evaluated pack.
- Duplicate edits: many PvP packs share identical or near-identical DS/EP/HL/HUD textures, so scoring repeated equivalent fingerprints wastes time.
- Warm-search extraction time currently dominates at 0.35s to 0.85s, but extraction does not scale with pack count.
- Current match time is 0.04s to 0.10s at 192 packs; a naive 5.8x candidate increase could push matching into the few-hundred-ms range before JSON parse/render overhead.

## Recommended MVP Direction

Use a candidate-first architecture:

1. Generate stronger per-type indexes during `generate-sbi-data.js`.
2. In the browser, use high-weight slot signatures (`diamond_sword`, `ender_pearl`, `splash_potion`) to produce a bounded candidate set.
3. Run cheap coarse scoring on that set only.
4. Run full existing `matchPacks` scoring only for top-K plus a small safety fallback pool.
5. Expand results from fingerprint groups back to pack names for display.

This keeps the current scoring logic as the accuracy authority while reducing how often it runs.

## Hard Constraint

SBI must remain fully static and GitHub Pages compatible for this optimization pass. All generated indexes must be committed static assets, and matching must continue to run in the browser without a remote API.

## MVP Details

- Keep the public search static: JSON shards plus browser-side matching.
- Add instrumentation before changing behavior: candidate count, prefilter count, coarse-score count, full-score count, and per-stage time.
- Make prefilter conservative: include adjacent signature buckets and union multiple high-weight item signals before intersecting.
- Do not use food as a primary filter because SK/GC has low weight and many shared textures.
- Use DS/EP as anchors when present; HL is useful but more ambiguous because potion textures can be composited or generic.
- Preserve full-score fallback when candidate count is suspiciously low or the top margin is weak.
- Avoid changing score formulas in the MVP; speed changes should first reduce the number of packs reaching existing full scoring.

## Strategy Trade-Offs

- Candidate-first scoring: best speed/complexity balance; risk is false-negative filtering if buckets are too strict.
- Texture dedupe groups: high value for repeated edits; risk is result grouping/display complexity.
- Bucket-level shard loading: strong first-load improvement; higher build and fetch orchestration complexity.
- Web Worker: improves UI responsiveness but does not reduce total CPU by itself.
- IndexedDB parse cache: improves repeat searches, not first-time visitors.
- Server-side search: out of scope for this pass. It remains a future option only if static matching cannot meet the target after candidate-first optimization.

## Later Options

- Dedupe equivalent fingerprints by generating texture-group IDs per type, then score groups once and fan out to packs.
- Emit compact arrays or binary payloads for hot shards if JSON object traversal remains a bottleneck after candidate reduction.
- Move extraction and matching into a Worker if UI jank appears on slower devices.
- Add IndexedDB cache for parsed shards after the static MVP is stable.
- Consider server-side search only if full static matching cannot keep the first query comfortably under the target budget.

## Validation

Measure each change with `python test_sbi.py` and compare:

- top-1 pass count;
- top-1 margin;
- `fingerprints` load time;
- `match` time;
- total `process` time;
- candidate count after prefilter;
- full-score count after coarse stage.
