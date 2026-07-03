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
