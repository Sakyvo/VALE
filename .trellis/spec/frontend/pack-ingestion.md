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
