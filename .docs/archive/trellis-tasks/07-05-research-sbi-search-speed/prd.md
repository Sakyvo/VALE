# Full-corpus SBI speed and accuracy

## Goal

Keep Search by Image fully static while expanding fingerprints from the current allowlisted subset to every eligible resource pack, without losing useful identification accuracy or interactive speed.

## User Value

- Users can search against the entire accepted pack catalog instead of a curated subset.
- Adding visually similar edits does not arbitrarily displace the correct result.
- Search remains responsive as the catalog grows beyond the current 738-pack pre-Conquest upper bound.

## Requirements

- The final fingerprint build must include every pack with usable thumbnails except packs in the explicit SBI-exclusion Lists (`Overlay` and `Conquest`); the 192-pack allowlist is temporary only.
- Matching remains browser-side and GitHub Pages compatible.
- Candidate filtering must not remove the correct pack or its accepted equivalence group before full scoring.
- Ranking must separate genuinely distinguishable packs and handle provably indistinguishable packs explicitly instead of relying on JSON/insertion order.
- Speed and accuracy must be measured together on cold and warm searches.
- Existing 192-pack `test_img` results must not regress while full-corpus behavior is introduced.
- This optimization pass keeps the existing SBI observation surface: item slots, hotbar widget, health, hunger, and armor. It does not add sky, block, particle, or general world-scene matching.
- Packs classified as `Overlay` or `Conquest` must remain discoverable through their Lists but must not be generated as SBI candidates or shown in SBI results.
- The `Conquest` List must be maintained automatically from sword-texture overlap, with an explicit description that its packs are excluded from SBI because the held sword tier cannot be inferred reliably.
- The `Overlay` List must carry the same explicit SBI-exclusion notice.
- A separate internal pack-content fingerprint must detect renamed copies before SBI generation. It is not an SBI feature and must never affect screenshot scoring.
- Upload planning must compute the internal fingerprint before remote upload. A duplicate match becomes a blocker that asks which pack to retain.
- The same detector must support a manual one-time/full-catalog scan of existing remote pack repositories.
- Root `pack.png` and `pack.mcmeta` are excluded from renamed-copy identity.
- Planning must define the accuracy semantics, dataset, thresholds, rollout, and rollback before implementation.

## Confirmed Facts

- Current fingerprint version is `15`; committed shards contain 192 packs.
- `thumbnails/` contains 744 directories; excluding the current Overlay List leaves 738 eligible packs.
- The matcher already uses DS/EP/HL signature and dHash indexes, coarse top-K scoring, bounded full scoring, and weak-result full-corpus fallback.
- Current regression matching is exact-name only; `test_sbi.py` has no equivalence-group concept.
- The current regression set has 9 screenshots representing 7 expected pack names.
- On the committed 192-pack shards, `python test_sbi.py --quiet` passes 9/9.
- A temporary full 738-pack generation on 2026-07-12 reproduced 3/9 exact-name top-1 accuracy.
- All six failed expected packs remained ranked in the top 18, so the observed failures are final-ranking failures rather than candidate-recall failures.
- Full-corpus failure positions were: `Blue_128x` #18, `Eum3_Blue_Revamp` #9/#3, `Mav_War` #6, `OTB_FPS` #12, and `Tory_Eum3_v1_Revamp` #2.
- Full-corpus warm match time on the current reference machine was about 0.11-0.49 seconds; total processing was about 0.74-1.58 seconds, with extraction still the largest component.
- Exact generated-fingerprint grouping found only 675 distinct signatures among 738 packs. There are 38 duplicate groups containing 101 packs.
- `OTB_FPS` and `OTB_FPS_Conquest` have identical values for every feature currently available to SBI. No deterministic ranking formula can infer which archive produced a screenshot from those inputs alone.
- Shared food, HUD, and widget textures are common; full-corpus ranking cannot treat them as independent evidence when many packs share the same underlying texture.
- Thumbnail extraction currently preserves `diamond_sword.png` and `iron_sword.png`, but not wooden, stone, or golden sword textures.
- Exact source hashing currently finds 21 packs where extracted diamond and iron swords are identical. This includes named Conquest variants and KOTH sword overlays, but the current data cannot verify the stone-sword relationship.
- Current upload conflict handling compares zip filenames and normalized `packId` values only; it has no archive-content hash.
- `upload-folder.js` already emits a dry-run manifest with blockers, so content duplicates can stop execution without adding an interactive prompt inside batch processing.
- Existing archives live only in remote `packs-NNN` repositories. Efficient future checks therefore require a persisted content-hash index produced by a one-time streaming remote scan.

## Confirmed Product Decisions

- `Conquest` packs target modes where lower-tier swords intentionally reuse the diamond-sword appearance; their audience can discover them through a dedicated List.
- `Conquest` packs are excluded from SBI fingerprints and results because SBI cannot reliably infer the actual sword tier from the screenshot.
- `Overlay` packs follow the same discovery-via-List and exclusion-from-SBI policy.
- The exclusion reason must be visible in each special List rather than silently hiding the packs.
- Automatic `Conquest` membership compares normalized pixels, not perceptual similarity: if any two of stone, iron, and diamond sword textures are exactly identical, the pack is classified as `Conquest`.
- Wooden and golden swords do not participate in Conquest classification.
- Explicit `forceInclude` and `forceExclude` overrides are allowed for reviewed exceptions, and the detector must report why each pack was classified.
- Renamed-copy detection uses a private/internal full-texture fingerprint, not the partial SBI fingerprint.
- When the internal fingerprint matches, upload is paused and the user chooses which identity to retain.
- The detector runs automatically during upload planning and can also be invoked manually across the existing catalog.
- Internal texture identity requires the same normalized visual path set, dimensions/frame layout, and exactly equal decoded RGBA pixels.
- PNG encoding/compression metadata, zip entry order, zip timestamps, root `pack.png`, and root `pack.mcmeta` do not participate in identity.
- Texture animation metadata and visual behavior configuration such as OptiFine/MCPatcher/CIT properties participate after deterministic normalization.
- Non-visual assets such as sounds and language files do not participate.
- Sky textures, block textures, and particle textures are visual pack identity. Any difference in them means the packs are different and prevents renamed-copy deduplication.
- Duplicate retention is transactional. Choosing the existing pack skips the incoming upload, adds the existing pack to the requested List, and records the incoming identity as an internal alias.
- Choosing the incoming pack uploads and verifies it first, migrates all List memberships and public references, then marks the old pack for cleanup.
- The unretained remote archive, registry entry, and public index entry are deleted only after the retained download and rebuilt site have been verified.
- Manual catalog scans produce unresolved duplicate groups only; they never delete automatically.
- Packs that share current hotbar/HUD SBI fingerprints but differ in sky, blocks, particles, or other visual assets remain separate identities; partial SBI equality is not sufficient for ingestion dedupe or exact-accuracy credit.
- Distinct packs with exactly identical observable GUI/item/HUD fingerprints are scored once and expanded as separate, equal-score result rows in deterministic order.
- The UI does not add an ambiguity label or explanatory badge to these tied rows.
- Performance reference is the current Windows desktop running Edge.
- At 1,000 or more indexed packs, cold-search p95 must be at most 2.0 seconds, warm-search p95 at most 1.2 seconds, and matching-stage p95 at most 150 milliseconds.
- Low-confidence full-corpus fallback is included in those percentile measurements.
- Near-duplicate packs whose observable fingerprints are not exactly identical remain ordinary independent results, ordered by their actual scores.
- A small top-score margin does not force a tie and does not add a confidence or ambiguity annotation to the UI.
- This iteration uses the existing 9 real screenshots as its complete activation regression set; collecting a larger labeled corpus is not a release prerequisite.
- The 9-screenshot gate protects known cases only and must not be presented as evidence of corpus-wide accuracy.
- Full-corpus SBI ships atomically on `main` only after the 9-image accuracy gate and agreed performance budgets pass.
- The pre-release 192-pack commit is recorded as the rollback source; this iteration does not maintain two live fingerprint sets or add user canaries.
- A rollback restores the prior matcher/data behavior but publishes it under a new, monotonically increasing fingerprint version and script cache buster so clients cannot reuse incompatible cached shards.
- Post-deployment smoke checks repeat shard loading and the 9-image regression against the deployed site; any load failure, known-image regression, or budget breach triggers rollback.

## Working Direction

- Separate retrieval from identification: preserve conservative candidate recall, then rank by discriminative evidence rather than shared-feature accumulation.
- Generate exact observable-fingerprint groups during the fingerprint build so identical work is scored once; use nearest-neighbor relationships only for diagnostics and tuning, never to force a tie.
- Generalize the existing List-based SBI exclusion from only `Overlay` to an explicit set containing at least `Overlay` and `Conquest`.
- Build a deterministic archive texture manifest and aggregate digest, persisted separately from SBI data and keyed back to registry entries.
- Add a `blocked_content_duplicate` upload-plan action containing the incoming pack, existing matches, digest, and resolution state.
- Bootstrap the content index by downloading existing remote archives sequentially, hashing without long-term local retention, and recording scan failures for retry.
- Calibrate each feature by corpus rarity/information value; a texture shared by many packs should contribute less than a rare DS/EP/HUD fingerprint.
- Use full-corpus nearest neighbors as diagnostic hard negatives during tuning, while keeping the existing 9 real screenshots as the required release regression set.
- Treat differences outside the current GUI/item/HUD observation surface as unavailable evidence for this pass; do not distort GUI scores to guess those differences.
- Keep a full-corpus retrieval fallback for low-confidence or low-margin results: every group participates in a cheap global pass, then only a bounded set receives full scoring.

## Acceptance Criteria

- [x] Full generation includes all eligible packs and emits deterministic equivalence/group metadata.
- [x] Conquest detection deterministically updates the `Conquest` List, and both `Conquest` and `Overlay` are excluded from generated SBI data.
- [x] Both special Lists visibly state why they are excluded from SBI.
- [x] Upload dry-run detects renamed texture-identical packs before any remote write and requires an explicit retain decision.
- [x] A manual full-catalog command can build/rebuild the internal content index without retaining remote zip files locally.
- [x] Root `pack.png` and `pack.mcmeta` differences do not prevent renamed-copy detection.
- [x] The internal content index is not loaded by the website or SBI client.
- [x] Retaining either side of a duplicate preserves all intended List memberships and leaves at least one verified remote download throughout the migration.
- [x] Resolved aliases prevent a discarded renamed copy from being proposed again on later uploads.
- [x] Candidate recall is 100% for every labeled fixture: the expected pack or accepted equivalence group reaches final scoring.
- [x] Distinguishable fixtures achieve exact-name top-1; indistinguishable fixtures achieve equivalence-group top-1 according to the approved product semantics.
- [x] For exact observable-fingerprint ties, every member is displayed at the same score without an ambiguity annotation, and tests accept the expected member within the top-score tie set.
- [x] Near-duplicate but non-identical packs retain their computed score order even when the top margin is small; only exact observable-fingerprint equality creates a tie.
- [x] All existing 9 screenshots pass under the approved exact-name/exact-tie semantics against the full eligible corpus.
- [x] Cold load, warm match, total process, candidate count, fallback rate, top-1 margin, exact accuracy, and group accuracy are reported.
- [x] Browser-side static deployment remains supported.
- [x] Performance thresholds are fixed before implementation and pass on the agreed reference device class.
- [x] On the reference Windows + Edge desktop at 1,000+ packs: cold p95 <= 2.0s, warm p95 <= 1.2s, and match p95 <= 150ms including fallback searches.
- [x] The full-corpus deployment is one atomic change with the pre-release commit recorded and all SBI cache versions bumped together.
- [x] The deployed site passes shard-load smoke checks and all 9 regression images; rollback restores the previous data under a higher cache version if any release gate fails.

## Out of Scope Until Reconsidered

- A server-side vector/search service.
- Claiming unique archive identification when all observable SBI features are identical.
- Training a learned model before deterministic grouping, rarity weighting, and hard-negative evaluation have been measured.
- Sky, block, particle, or general world-scene recognition in SBI. These remain visual identity for ingestion dedupe but are deferred as search evidence.
- Requiring a 100-screenshot/50-pack labeled regression corpus before this release; expanding the fixture set remains follow-up work.

## Open Questions

None. Product decisions are ready to be translated into technical design and implementation steps.
