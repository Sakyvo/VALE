# Upload Sakyvo Pack List Design

## Architecture and Boundaries

- Source zips stay in `K:\PvP\Pack DL\Sakyvo`; the main site repository must not permanently contain `.zip` files or `resourcepacks/`.
- Pack storage remains in `Sakyvo/packs-NNN` repositories under `resourcepacks/`.
- Main site changes are limited to metadata and generated assets:
  - `l/lists.json`
  - `l/Sakyvo/index.html`
  - `data/pack-registry.json`
  - `data/extracted.json`
  - `data/index.json`, `data/pages/*`, `data/packs/*`
  - `thumbnails/*`
- Existing unrelated working-tree changes remain untouched.

## Data Flow

1. Scan `K:\PvP\Pack DL\Sakyvo` for `.zip` files.
2. Resolve each zip to the same pack ID used by `scripts/extract-textures.js`:
   - strip Minecraft color codes
   - preserve numeric `(n)` suffixes in pack IDs
   - apply `PACK_ID_OVERRIDES`
3. Classify each source file:
   - exact registry hit: already uploaded by filename
   - existing pack ID hit: already represented on the site
   - intra-source duplicate pack ID: keep one canonical source file for extraction/upload, but add the pack ID once to `Sakyvo`
   - new pack ID: upload and generate metadata
4. Upload only new canonical zip files to pack storage repositories.
5. Update `data/pack-registry.json` for newly uploaded filenames.
6. Extract thumbnails/metadata for the final unique site pack set without leaving zips committed in the main repo.
7. Add all resolved pack IDs, including skipped duplicates, to `l/lists.json` under `Sakyvo`.
8. Regenerate site index files.
9. Defer SBI fingerprint regeneration and regression testing to a separate follow-up task.

## Batch Upload Shape

The existing `scripts/upload-pack.js` is not sufficient as-is for this task because:

- it assumes local `../packs-NNN` directories exist or can be created, but current local scan found no `packs-*` directories under `K:\Projects\website`;
- it commits and pushes one file at a time, which is fragile for 500+ files and 13 GB;
- it skips only exact registry filenames, while this task must also respect duplicate pack IDs.

Implementation should add or adapt a batch-oriented helper that can:

- dry-run and emit a manifest before writing;
- clone or initialize needed `packs-NNN` repos in a temporary/workspace directory;
- pull each storage repo before adding files;
- pack files into repositories until the 5 GB limit is reached;
- create `!  FULL  !` markers when a repo becomes full;
- batch commits/pushes by repository, with progress resumable from the manifest;
- write `data/pack-registry.json` only after uploaded files are assigned.

## Compatibility and Migration Notes

- `l/lists.json` stores pack IDs, not original zip filenames.
- `generate-index.js` maps List membership into each pack detail JSON by pack ID.
- Existing pack pages and list pages are static HTML shells; adding `l/Sakyvo/index.html` should reuse the existing List page shell.
- Download URLs must continue to come from `data/pack-registry.json`, not from zips in the main repo.
- SBI data is intentionally unchanged in this task.

## Trade-Offs

- Deferring SBI regeneration keeps this task focused on upload/List availability. The uploaded collection will not participate in SBI until the follow-up regeneration is done.
- Batch upload reduces GitHub push overhead and recovery risk compared with one commit per pack.
- Keeping zips outside the main repo avoids violating storage rules, but requires either an external input option for extraction or a temporary staging area that is cleaned before any commit.

## Rollback and Recovery

- Before upload, produce a dry-run manifest with source file, pack ID, action, target repo, and expected size.
- If upload fails mid-way, use `data/pack-registry.json` plus pack repo git history to resume instead of re-uploading already pushed files.
- If generated site data fails validation, do not push the main site changes until fixed.
- SBI rollback is out of scope because SBI artifacts are not changed in this task.
