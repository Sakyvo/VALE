# Pack Ingestion

## Scenario: Batch Upload External Pack Folders

### 1. Scope / Trigger

- Trigger: adding many external `.zip` resource packs to the static site and remote `Sakyvo/packs-NNN` storage.
- This is an infra/data contract because it changes command signatures, remote storage mapping, generated site data, and List membership.
- Main repo rule: never leave `.zip` files or `resourcepacks/` in the main site repository.

### 2. Signatures

```bash
node scripts/upload-folder.js --source <folder> [--list <name>] [--manifest <json>] [--execute] [--skip-blockers] [--only-repo <n>]
node scripts/extract-textures.js [--input <dir>] [--merge] [--manifest <json>]
node scripts/generate-index.js
node scripts/build.js
```

Shared pack ID logic must live in `scripts/pack-utils.js` and be reused by upload and extraction code:

```js
const { getPackIdFromZipName, sanitizeName, PACK_ID_OVERRIDES } = require('./pack-utils');
```

### 3. Contracts

- `upload-folder.js --source` reads `.zip` files from an external folder and sorts them by modified time ascending.
- `--manifest` writes a dry-run/execute plan containing `listPackIds`, `extractPackIds`, `uploadEntries`, `blockers`, and per-file `entries`.
- `--list` updates `l/lists.json`; List `packs` values are pack IDs, not zip filenames.
- `data/pack-registry.json` keys are original uploaded zip filenames and values are `{ repo, repoNum, size }`.
- `extract-textures.js` must preserve the outer uploaded zip basename as `originalName`, even if a nested archive is rebuilt internally.
- `generate-index.js` uses `originalName + ".zip"` to look up registry entries and produce download URLs.

### 4. Validation & Error Matrix

- Source folder missing -> throw before writing.
- Exact filename already in registry -> skip upload, include the resolved pack ID in the List, and extract if needed.
- Pack ID already exists in `data/index.json` -> skip upload, include existing pack ID in the List.
- Multiple source files resolve to one pack ID -> upload/extract one canonical file, add one List entry.
- File size > 100MB -> block upload and do not add it to the List unless a smaller duplicate with the same pack ID is accepted.
- Repo would exceed 5GB -> mark current repo full with `!  FULL  !` and continue in the next repo.
- Unreadable non-core zip entry during cleanup -> skip that entry and continue; do not fail the entire pack.
- Sanitized pack ID ending in `.` or space -> strip trailing `.` and spaces to avoid invalid Windows path behavior.

### 5. Good/Base/Bad Cases

- Good: run dry-run with `--manifest`, review blockers, run execute with `--skip-blockers` only after oversized files are documented.
- Base: after upload, run extraction with `--input <external-or-temp-dir> --merge --manifest <manifest>`, then regenerate index/build output.
- Bad: copying zips into the main repo `resourcepacks/` directory and committing them.
- Bad: changing `extract-textures.js` naming rules without updating `pack-utils.js` and the upload script.

### 6. Tests Required

- `node --check scripts/pack-utils.js`
- `node --check scripts/upload-folder.js`
- `node --check scripts/extract-textures.js`
- `node scripts/generate-index.js`
- `node scripts/build.js`
- Verify List membership: no duplicate pack IDs and no missing generated pack records.
- Verify registry coverage: every new generated pack has a registry-backed download URL unless intentionally pre-existing.
- Verify repository safety: no `.zip` files and no `resourcepacks/` directory in the main repo.
- SBI fingerprint tests are required only when SBI data or search code changes.

### 7. Wrong vs Correct

#### Wrong

```js
// Deriving a pack ID differently in each script creates List/registry mismatches.
const packId = path.basename(file, '.zip').replace(/\W+/g, '_');
```

#### Correct

```js
// Use the shared Minecraft color-code and Windows-safe pack ID rules.
const { getPackIdFromZipName } = require('./pack-utils');
const packId = getPackIdFromZipName(file);
```

#### Wrong

```js
// After rebuilding a nested zip, using the inner archive basename breaks registry lookup.
return { packId, originalName: path.basename(rebuiltZipPath, '.zip') };
```

#### Correct

```js
// Preserve the outer uploaded basename so generate-index can find registry[originalName + ".zip"].
const sourceOriginalName = path.basename(zipPath, path.extname(zipPath));
zipPath = fixNestedArchive(zipPath);
return { packId, originalName: sourceOriginalName };
```

## Scenario: Exact Visual Identity And Duplicate Resolution

### 1. Scope / Trigger

- Trigger: scanning remote archives or planning an upload after the visual-content identity index exists.
- The identity fingerprint is an ingestion safeguard only. Never load it in the website or use it as SBI evidence.

### 2. Signatures

```bash
npm run packs:scan-content -- --concurrency <1..8>
node scripts/upload-folder.js --source <folder> --list <name> --manifest <json> [--duplicate-resolutions <json>] [--execute]
node scripts/finalize-pack-replacements.js --prepare-site [--only <file-or-pack-id>]
node scripts/finalize-pack-replacements.js --execute-cleanup [--only <file-or-pack-id>]
```

### 3. Contracts

- `data/internal/pack-content-index.json` is bound to the exact registry digest and fingerprint schema; it must cover every registry entry with no failures before upload execution.
- Visual identity includes exact decoded pixels/dimensions plus rendering configuration. It includes sky, block, and particle differences, but excludes root `pack.png`, root `pack.mcmeta`, sounds, languages, zip order, timestamps, and compression.
- A renamed exact copy emits `blocked_content_duplicate` before repository allocation or remote writes.
- A duplicate decision is bound to the incoming archive SHA-256, visual hash, and current registry digest.
- `keep=existing` skips upload, adds the retained pack ID to the requested List, and records the incoming alias.
- `keep=incoming` uploads and verifies first, then records a pending replacement. `--prepare-site` migrates local/public references while both remote archives exist. Only a later `--execute-cleanup`, after deployment verification, may delete the discarded remote archive.
- Temporary downloads use the OS temp directory. Temporary `packs-NNN` clones use `.vale-pack-upload` and are removed in `finally`; a pre-existing clone directory is a blocker, not disposable state.

### 4. Validation & Error Matrix

- Missing, stale, incomplete, or schema-incompatible content index -> block planning/execution.
- Same filename or pack ID with different visual content -> hard blocker; never treat it as an already-uploaded skip.
- Exact visual duplicate without a current reviewed decision -> `blocked_content_duplicate`.
- Decision archive hash, visual hash, retained file, or registry digest changed -> reject the decision.
- `--skip-blockers` with an invalid content index or unresolved content duplicate -> remain blocked.
- `--execute` passed to the finalizer -> reject; require the two named phases.
- Retained or discarded remote SHA-256 changed before cleanup -> abort without deleting.

### 5. Good/Base/Bad Cases

- Good: rebuild/validate the content index, review the dry-run blocker, then provide a hash-bound decision.
- Base: keep the existing identity, add it to the requested List, and persist the discarded incoming name as an alias.
- Bad: infer identity from filenames, partial SBI fingerprints, zip SHA-256 alone, or a subset of item textures.
- Bad: delete the old remote archive in the same phase that uploads or deploys the replacement.

### 6. Tests Required

- `npm test`
- Assert metadata-only changes preserve identity and sky/block/particle/config changes break identity.
- Assert uploads fail closed for stale/incomplete indexes and conflicting same-ID content.
- Assert both retain decisions preserve List membership and keep at least one verified remote archive available.
- Assert cleanup re-verifies both retained and discarded archive hashes and removes temporary clones on success/failure.

### 7. Wrong vs Correct

#### Wrong

```js
if (registry[file] || existingPackIds.has(packId)) return 'skip';
```

#### Correct

```js
const incoming = await fingerprintPackContent(zipPath);
const existing = contentIndex.packs[file];
if (existing && existing.visualContentHash !== incoming.visualContentHash) {
  return 'blocked_content_conflict';
}
```

## Scenario: Illegal Pack Intake And Retirement

### Execution Signature

```bash
npm run packs:execute-normalization -- --phase stage --execute --approval-digest <sha256>
npm run packs:execute-normalization -- --phase prepare-site --execute --approval-digest <sha256>
npm run packs:execute-normalization -- --phase verify-deployment --execute --approval-digest <sha256>
npm run packs:execute-normalization -- --phase cleanup --execute --approval-digest <sha256>
```

- The digest must exactly match the approved `data/internal/pack-normalization-review.json`; `reviewed: false`, a stale digest, or an out-of-order phase fails before remote or catalog work.
- `stage` streams and hashes every reviewed source before publishing any product. Remote mutations use an owned temporary `.vale-pack-upload` partial clone and clean it on handled success or failure.
- `prepare-site` downloads each visible staged product and runs `extract-textures.js --replace-existing --strict`, including packs that already have extraction data. Catalog/state JSON writes are protected by a resumable short-lived transaction backup.
- `verify-deployment` compares deployed registry, index, Lists, extraction data, pack records, routes, downloads, and SBI metadata with the prepared catalog.
- `cleanup` is accepted only after deployment verification. It hash-verifies retained and old archives again before deleting old remote files, then reconciles every retained registry archive.
- Remote identity checks and archive downloads resolve each `packs-NNN/main` branch to an immutable commit SHA before reading bytes; never hash a moving branch reference across retries or ranges.
- Final retained-archive reconciliation uses bounded concurrency and an atomic checkpoint bound to the registry/content digest and each repository commit. A retry skips proven entries, invalidates only repositories whose head changed, refreshes every head before completion, and removes the checkpoint only after full success.

### Contracts

- Plot's current classification and repair behavior is the authority for VALE's normal pack form. This includes structural rescue, Lunar illegal-escape repair, bloat cleanup, dead-path cleanup, and collection splitting.
- The implementation is self-contained CommonJS in VALE and records a `normalizationSchemaVersion` in plans and audit state. It does not invoke a local Plot executable or require a sibling Plot checkout.
- Plot-derived parity fixtures lock the versioned VALE implementation to the accepted rule snapshot; adopting later Plot behavior requires an explicit schema upgrade.
- The normalized ingestion pipeline is the only archive write boundary. Legacy single-file/migration scripts must delegate to it or reject writes, and browser administration must not upload or delete archive files directly.
- Keep the implementation layered: a pure CommonJS normalizer, local-source upload orchestration, registry-backed existing-pack migration, and a two-phase finalizer. Remote/catalog mutation and normalization logic must not share one monolithic entry point.
- Source ingestion scans each top-level directory entry, not only `.zip` filenames. ZIP magic and internal structure determine repairability; wrong extensions and folder packs may be rescued, known Plot junk is ignored, and symbolic links/junctions are never followed.
- Nested source directories are pack containers, not additional scan roots. Non-repairable top-level entries, including real RAR/7z files, are recorded as illegal material instead of being silently skipped.
- Normalization applies archive-safety checks at every nested level: at most 50,000 entries, 512 MiB per expanded entry, and 2 GiB total expanded bytes, with no absolute/traversal/NUL paths, link entries, or colliding output paths.
- A safety-limit refusal is `blocked_archive_limits`, not illegal material, because the pack was not fully classified. It requires an explicit reviewed defer or limit change and rescan.
- GitHub's 100 MiB per-file limit is a hard upload gate after normalization. A product still above it is `blocked_oversize`, never illegal; an already-online oversize pack remains online and deferred unless a supported storage path is explicitly introduced.
- Plot's bloat/dead-path cleanup runs before the size gate, so ordinary oversized packs should shrink before this blocker is evaluated.
- Normalized ZIP output is reproducible: stable entry ordering, UTF-8 name flags, fixed archive metadata, and unchanged resource bytes except for Plot-defined repairs. The same source and schema version must produce the same product SHA-256.
- Every product is reclassified after writing and must be Normal; one-to-one migrations additionally require the pre/post visual content hash to match.
- Only a Plot-normal product may be uploaded. Every repairable incoming archive is normalized before content identity checks and repository allocation.
- Registered archives receive a one-time normalization migration under the same rules; already-normal archives remain byte-for-byte untouched.
- Existing-catalog migration begins with a read-only batch manifest bound to the registry digest, every selected remote archive SHA-256, and the normalization schema version. Scanning never performs a remote or catalog write.
- The one-time existing-pack migration selects every archive in `data/pack-registry.json`, including entries absent from the public index or Lists. Public visibility affects cleanup/rebuild work, not scan inclusion.
- Normalization migration preserves visibility: registry-only entries remain registry-only, and a non-public collection's products do not gain public extraction, pages, or List membership merely because they were normalized.
- Execution requires the explicitly reviewed manifest. Any registry or selected-archive identity change invalidates the whole manifest and requires a new scan and review; review is batch-level rather than an interactive prompt per pack.
- Unresolved hard blockers make the manifest non-executable unless the reviewed decision file explicitly marks each affected entry `defer`; deferred entries remain unchanged and retain their audit reason.
- Each migration entry is resumable through `planned`, `staged_verified`, `site_prepared`, `deployed_verified`, `old_deleted`, and `complete` states. State transitions are monotonic; a verified staged copy may be reused, and an interrupted run never deletes an unverified or unreferenced remote archive automatically.
- A registered archive that normalizes to one product preserves its existing archive filename, pack ID, route, upload date, and List references while its bytes, size, and hashes are updated.
- A one-product migration must preserve the existing complete visual-content hash. A mismatch is a non-bypassable content-change blocker, not a normalization result.
- The normalized archive is first uploaded under the preserved filename to a different capacity-eligible `packs-NNN` repository and verified there. Registry/site data switches to the new repository before deployment verification and deletion of the old remote archive.
- A collection source may normalize into multiple products. Each product is an independent upload candidate with its own inner-container-derived filename and pack ID, identity/conflict/size checks, registry entry, and List membership.
- A normalized product that is an exact existing content identity reuses the existing pack and records source provenance instead of uploading another archive.
- Normalization never performs automatic duplicate deletion. Exact visual duplicates remain review blockers under the existing hash-bound retain-decision flow; same-ID visual conflicts remain hard blockers.
- Distinct same-named products from one collection receive deterministic ` (n)` suffixes after stable ordering. A different-content collision with an existing published filename or pack ID is a hard blocker until the reviewed manifest supplies an explicit name override.
- A registered collection retires its parent identity and creates one identity per accepted product.
- Every product split from a registered collection inherits all non-derived List memberships from the parent. Derived `Overlay` and `Conquest` membership is never inherited and is recomputed from each product after extraction.
- Catalog migration regenerates SBI data in sharded-only form; the legacy monolithic SBI fingerprint file is retired, and oversized shards split deterministically around the documented target.
- The outer collection source is provenance only and never becomes a registry entry; its audit record links it to every normalized product.
- `Illegal material` follows the domain definition in `CONTEXT.md`; repairable structural or metadata problems are not illegal material.
- A newly discovered illegal pack is excluded from upload and List membership and is retained in a durable audit record with its classification reason.
- A registered illegal pack is retired from the complete catalog, including registry, content identity, extraction records, Lists, thumbnails, generated pack data/pages, and SBI data.
- Retirement is two-phase: prepare and deploy the site removal first, verify that the deployed catalog no longer references the pack, then delete the remote archive from `packs-NNN`.
- Keep an audit record after retirement so the same illegal source remains explainable on later scans.
- The canonical audit ledger is internal `data/internal/pack-normalization-audit.json`; it stores source/remote identity, classification causes, normalization schema, product mappings, lifecycle status, and timestamps without retaining archive bytes or machine-specific absolute paths.
- A generated Markdown summary may expose illegal, deferred, migrated, and retired entries to maintainers, but illegal material is never represented as a public List solely for audit visibility.
- The first rollout is dry-run only, followed by reviewed execution, site deployment verification, and remote cleanup. Test coverage uses temporary archives and mocked repositories; production remote writes are never part of automated tests.
