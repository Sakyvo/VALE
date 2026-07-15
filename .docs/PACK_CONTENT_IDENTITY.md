# Pack Content Identity

This fingerprint is an ingestion safeguard, not an SBI signal. It compares the complete normalized visual content of an archive.

Included: decoded raster pixels and dimensions, sky, blocks, particles, GUI, fonts, entities, armor, animation metadata, models, blockstates, shaders, OptiFine/MCPatcher/CIT configuration, and effective stone/iron/diamond sword pixels.

Excluded: root `pack.png`, root `pack.mcmeta`, sounds, language files, documentation, zip order, timestamps, and compression metadata.

## Build The Remote Index

```bash
npm run packs:scan-content -- --concurrency 6
```

The resumable index is `data/internal/pack-content-index.json`. The scan downloads each archive to an OS temp directory and deletes it after hashing. Existing exact groups are reported in [PACK_CONTENT_DUPLICATES.md](./PACK_CONTENT_DUPLICATES.md); the command never deletes them.

## Upload Planning

```bash
node scripts/upload-folder.js --source <folder> --list <List> --manifest <plan.json>
```

Planning fails closed if the content index is missing, stale, incomplete, or uses another fingerprint schema. A renamed exact copy produces `blocked_content_duplicate` before any remote write.

Resolve a reviewed blocker with a manifest tied to the current registry digest and incoming archive hash:

```json
{
  "schemaVersion": 1,
  "registryDigest": "...",
  "decisions": [
    {
      "archiveSha256": "...",
      "visualContentHash": "...",
      "keep": "existing",
      "retainedFile": "Existing.zip",
      "reason": "reviewed"
    }
  ]
}
```

Pass it with `--duplicate-resolutions <file>`. `keep` is either `existing` or `incoming`.

- `existing`: skip the incoming upload, add the retained pack to the requested List, and record an alias.
- `incoming`: upload and verify the incoming archive first, migrate public references, then leave a pending replacement. It does not delete the old archive during upload.

## Finalize Keep-Incoming

Prepare the site changes while the old remote archive still exists:

```bash
node scripts/finalize-pack-replacements.js --prepare-site
```

Commit and push those main-repository changes, wait for Pages deployment, then verify and delete the discarded remote identity:

```bash
node scripts/finalize-pack-replacements.js --execute-cleanup
```

The second phase verifies the retained remote SHA-256 and size, confirms deployed indexes and Lists no longer reference discarded IDs, re-verifies every discarded remote SHA-256, and only then deletes it. Temporary pack-repository clones are removed in `finally`.
