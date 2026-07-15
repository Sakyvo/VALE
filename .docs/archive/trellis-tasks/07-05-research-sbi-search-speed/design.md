# Full-Corpus SBI Technical Design

## Scope and Boundaries

This task has four connected but distinct pipelines:

1. Archive visual-content identity detects renamed copies during ingestion.
2. Special-pack classification maintains `Overlay` and `Conquest` Lists.
3. SBI generation builds browser-search fingerprints for every eligible pack.
4. SBI matching retrieves, scores, and expands result groups in the browser.

Archive identity must never become screenshot evidence. It may inspect every visual asset, including skies, blocks, and particles, while SBI remains limited to the currently extracted item, widget, and HUD surfaces.

The deployment remains fully static on GitHub Pages. No runtime API, vector database, server-side matching, Web Worker, binary fingerprint format, or IndexedDB cache is required for the first implementation.

## Evidence Driving the Design

- The committed version 15 corpus has 192 packs and passes 9/9 screenshots.
- A temporary 738-pack build passed only 3/9, although every expected pack remained within the top 18.
- The failure is therefore ranking quality, not candidate disappearance.
- The 738-pack build contains 675 distinct observable fingerprint records. Thirty-eight exact groups contain 101 packs.
- Full-corpus matching currently takes about 0.11-0.49 seconds; extraction remains the larger end-to-end cost.
- Common food, HUD, and widget textures accumulate misleading evidence when every near-duplicate pack is scored independently.

The implementation must improve final ranking and eliminate repeated exact work without making candidate filtering more aggressive.

## End-to-End Data Flow

### Ingestion and Catalog Scan

```text
local or temporary remote zip
  -> canonical visual manifest
  -> aggregate visualContentHash + selected sword hashes
  -> persisted operational index
  -> duplicate blocker or accepted upload
  -> remote pack repository
  -> thumbnail extraction / public index
  -> special List classification
```

### SBI Build and Search

```text
thumbnails + Overlay/Conquest exclusion set
  -> per-surface SBI features
  -> per-texture exact keys and corpus frequencies
  -> full observable-fingerprint groups
  -> static metadata + typed shards
  -> conservative browser retrieval
  -> coarse global fallback when needed
  -> bounded full scoring with rarity-aware evidence
  -> expand exact group members as equal-score rows
```

## Archive Visual-Content Identity

### Canonical Manifest

Create a shared module, proposed as `scripts/lib/pack-content-fingerprint.js`, that accepts a zip path and produces a deterministic manifest in memory.

Archive-root handling must use the same nested-pack semantics as thumbnail extraction. Canonical paths use `/`, remove only the detected wrapper directory, retain case, and reject duplicate canonical visual paths rather than choosing an arbitrary zip entry.

Included content:

- every decodable visual raster used by the pack, including item, GUI, font, entity, sky, block, particle, armor, and root visual files;
- animation sidecars such as `*.png.mcmeta`;
- visual behavior files under OptiFine/MCPatcher/CIT paths;
- model, blockstate, shader, font, and other configuration files that change rendering.

Excluded content:

- root `pack.png` and root `pack.mcmeta`;
- sounds, language files, documentation, and other non-visual assets;
- zip directory entries, ordering, timestamps, compression method, and container metadata.

An unsupported or undecodable visual entry is a fingerprint blocker. It must never be silently omitted, because omission could create a false duplicate.

### Leaf and Aggregate Hashing

For every raster entry:

1. Decode all stored pixels without resizing or selecting only the first animation frame.
2. Hash a typed record containing canonical path, width, height/frame layout, channel format, and decoded RGBA bytes.
3. Keep transparent-pixel bytes as decoded; equality is exact RGBA equality.

For structured JSON, parse and serialize recursively with sorted object keys while preserving array order and values. For supported properties/config files, normalize encoding, line endings, continuations, comments, and key/value syntax according to the relevant format. Do not normalize value order where it can affect rendering.

Sort leaf records by canonical path and hash the canonical sequence with SHA-256. The aggregate hash represents the exact visual path set and normalized visual behavior. SHA-256 identity is accepted after the full canonical manifest has been built successfully.

### Persisted Operational Index

Store operational metadata separately from SBI, proposed under `data/internal/`:

```json
{
  "schemaVersion": 1,
  "registryDigest": "sha256:...",
  "packs": {
    "Example.zip": {
      "packId": "Example",
      "repo": "packs-001",
      "size": 123,
      "archiveSha256": "...",
      "visualContentHash": "...",
      "visualEntryCount": 42,
      "swords": {
        "stone": "pixel-hash-or-default-hash",
        "iron": "pixel-hash-or-default-hash",
        "diamond": "pixel-hash-or-default-hash"
      }
    }
  },
  "failures": []
}
```

The site and SBI client never fetch this index. It is operational metadata, not a secret boundary: the repository and source archives are public.

The `registryDigest` covers the canonical registry mapping. Upload execution fails closed if the index is missing entries, has unresolved scan failures, or is stale relative to `pack-registry.json`. A normal blocker-skip option must not bypass this integrity check.

### Remote Catalog Scan

A manual scanner downloads one registry archive at a time into an OS temporary file, hashes the download while streaming, fingerprints it, updates an in-memory result, and deletes the temporary archive in `finally`. It must not retain zip files or `packs-NNN` clones in `.vale-pack-upload`.

The scanner supports resumable checkpoints keyed by repo, filename, size, and archive hash. Failures remain explicit and retryable. A completed scan writes the operational index plus unresolved duplicate groups; it never deletes or renames a pack automatically.

### Upload Duplicate Decisions

`upload-folder.js` computes each incoming visual-content hash during dry-run before assigning a remote repository. A match emits `blocked_content_duplicate` with all existing matches and no remote write.

Reviewed decisions are supplied through a deterministic resolution manifest bound to the incoming archive hash and current index digest.

- **Keep existing:** skip the incoming upload, add the retained existing pack to the requested List, and record the discarded source name as an alias.
- **Keep incoming:** upload and verify the incoming archive first. Migrate List memberships and public references in a deploy while the old archive still exists. Only after the retained download and rebuilt site are verified may an explicit cleanup phase remove the old archive, registry entry, extracted/public index entry, and temporary clone.

Cleanup is never part of an initial dry-run and never follows an unresolved manual scan. A failed phase leaves the older remote archive available.

## Conquest and Overlay Classification

### Conquest Rule

Compare the effective stone, iron, and diamond sword textures. A missing override uses the corresponding `Default_Texture` asset. Hashes include dimensions/frame layout and exact decoded RGBA bytes.

A pack is `Conquest` when any pair among stone, iron, and diamond has the same exact pixel hash. Wooden and golden swords do not participate. Perceptual similarity is not used.

The remote content scan records the three effective sword hashes, so existing packs do not require permanent local archives. Future thumbnail extraction should also preserve `stone_sword.png` for inspection, but the classifier's source of truth is the archive-derived operational index.

### Overrides and Reports

Keep reviewed `forceInclude` and `forceExclude` entries in a small versioned config. Generate a report for every classified pack containing the matched sword pair or override reason. An override wins over automatic classification and must always include a non-empty reason.

The detector updates only the `packs` arrays of managed Lists. It preserves other List fields and writes a stable sorted order. Descriptions must explain that these packs are discoverable through the List but excluded from Search by Image:

- `Conquest`: the held sword tier cannot be inferred reliably.
- `Overlay`: the package is an overlay rather than a uniquely identifiable full pack.

### SBI Exclusion Contract

SBI generation loads an explicit exclusion-name set containing at least `Overlay` and `Conquest`. List-name matching is exact. Excluded packs must be absent from generated metadata, every shard, candidate indexes, and final results.

List detection and SBI version bumping should be separate commands. A classification dry-run must not regenerate fingerprints or mutate cache versions.

## SBI Build Format

### Exact Observable Groups

For each eligible pack, build a canonical record containing every generated SBI surface and an explicit missing marker for absent surfaces. Hash the stable serialization to obtain an observable group ID.

Members with the same full record form an exact group. Choose the lexicographically first member as the deterministic representative and sort all members. Score the group once. Differences in any current item, widget, or HUD fingerprint keep packs in separate groups.

Near-duplicate relationships may be emitted as diagnostics for calibration but never create result equivalence.

### Per-Texture Frequency Metadata

Create an exact key for every individual generated surface record. Count how many observable groups share that key and derive a bounded inverse-frequency weight. Frequency is measured over groups, not raw pack names, so renamed exact copies cannot inflate commonness.

Emit a versioned `data/sbi-fp/meta.json` containing:

- eligible pack and group counts;
- group ID, representative, and member names;
- per-surface frequency/rarity metadata;
- generator schema and fingerprint versions;
- excluded List names and counts.

Typed shards use group IDs in `packs` and `_index` entries. All generated maps and arrays use stable ordering so identical inputs produce byte-identical JSON.

## Browser Retrieval and Ranking

### Retrieval

Keep DS/EP/HL signature and dHash indexes conservative. Candidate votes operate on group IDs. Adjacent signature buckets and hash-segment unions remain available; food is not a primary filter.

The normal path is:

1. Gather conservative indexed candidates from every usable anchor.
2. Run cheap coarse anchor scoring if the set exceeds the bounded full-score limit.
3. Full-score the selected groups.

The fallback path must not run the current expensive full scorer over the entire corpus. Instead, it runs a cheap global coarse pass over every group, unions the best global groups with indexed candidates, and full-scores a bounded set. Thus every group participates in fallback retrieval while expensive details remain bounded.

Candidate recall is measured before full scoring. The expected exact group must reach full scoring for all 9 fixtures.

### Rarity-Aware Evidence

Retain the existing semantic base priorities: DS and EP are strongest, HL is secondary, and food is weak. Multiply a surface's usable contribution by a bounded function of its corpus rarity. Shared textures retain a floor contribution but cannot accumulate the same authority as rare matching textures.

Rarity modifies evidence only; it is never a pack-name, upload-date, List, or canonical-representative prior. Apply rare-feature bonuses only to sufficiently strong similarities so a rare mismatch is not rewarded. Calibrate global floors, caps, and gates against the full corpus and nearest-neighbor diagnostics rather than adding pack-specific exceptions.

### Result Expansion

Fallback decisions, top margins, and ranking operate on distinct group rows. After final scoring:

1. Expand each exact group into its sorted member names.
2. Assign every member the identical raw and displayed score.
3. Preserve deterministic group score order and member order.
4. Render ordinary independent cards without an ambiguity label.

Near-duplicate non-identical groups keep their computed order even when the margin is small. A small margin may trigger fallback and telemetry but never forces a UI tie.

Generate detailed diagnostics only for full-scored groups and visible results. Expanded members may share immutable score diagnostics from their group.

## Performance and Instrumentation

Expose test metrics through the existing `window.__sbiTest` surface:

- eligible pack count and exact group count;
- loaded bytes/shards and fingerprint load time;
- indexed candidate, global coarse, and full-score counts;
- extraction, coarse, full-score, expansion, render, and total times;
- fallback reason/rate;
- distinct-group top margin and expected-group recall.

Reference budgets on the current Windows desktop with headless Edge and at least 1,000 indexed packs:

- cold total p95 <= 2.0 seconds;
- warm total p95 <= 1.2 seconds;
- matching p95 <= 150 milliseconds, including global fallback executions.

The existing JSON shards and HTTP cache remain the initial load strategy. Add compact arrays, a Worker, or IndexedDB only if measured budgets cannot be met after grouping, bounded scoring, and detail reduction.

## Verification

### Deterministic and Unit Checks

- Build test archives at runtime in OS temp directories; never commit `.zip` fixtures to the main repository.
- Verify compression/order/timestamp changes preserve visual identity.
- Verify root `pack.png`/`pack.mcmeta`, sound, and language changes are ignored.
- Verify sky, block, particle, animation metadata, CIT, dimension, frame, path-set, and RGBA changes break identity.
- Verify undecodable visual assets and duplicate canonical paths block hashing.
- Verify Conquest pair rules, default fallback, overrides, and reasons.
- Verify repeated SBI generation is byte-identical.
- Verify exact groups score once and expand to equal ordinary rows.

### Existing Screenshot Gate

Keep the existing 9 screenshots as this release's complete real-image regression suite.

- A distinguishable expected pack must be exact-name top-1.
- If its full observable group has multiple eligible members, the expected name must be in the highest-score tie set.
- Candidate recall must be 100% before full scoring.
- `Overlay` and `Conquest` names must never appear.

The harness should support repeated cold/warm benchmark runs and a remote base URL. Report p50/p95 rather than treating one cold request as a percentile. A forced global-fallback benchmark verifies the fallback budget even if none of the 9 normal searches triggers it.

This gate protects only the known 9 images. Corpus-wide accuracy claims remain out of scope until more labeled screenshots exist.

## Release and Rollback

Record the exact pre-release commit containing the 192-pack SBI data. Publish matcher code, metadata, all shards, `SBI_FINGERPRINT_VERSION`, and the `sbi.js` HTML cache buster in one main-branch change after all local gates pass.

After GitHub Pages deployment, verify every shard loads from `vale.cc.cd` and run the 9 screenshots against the deployed base URL. A load failure, screenshot regression, exclusion leak, or budget violation triggers rollback.

Rollback restores the prior matcher/data behavior but assigns a new fingerprint version greater than the failed release and increments the script cache buster again. Never restore the old numeric cache version, because clients may have cached incompatible full-corpus shards under it.

## Primary Risks

- **False duplicate:** fail closed on unsupported visual files and retain exact path/dimension/RGBA/config semantics.
- **Incomplete remote index:** bind it to the registry digest and block upload until gaps are scanned.
- **Broken download during rename migration:** deploy and verify the retained identity before explicit cleanup of the old remote archive.
- **Candidate miss:** measure expected-group recall and use an all-group coarse fallback before bounded full scoring.
- **Fallback latency:** decide fallback on groups, avoid expanding ties first, and never construct full diagnostics for the entire corpus.
- **Overfitting nine images:** allow only global rarity/scoring parameters and document that the fixture set is narrow.
- **Cache-incompatible rollback:** use monotonically increasing data and script versions for every published state.
