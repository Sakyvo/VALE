# Upload Sakyvo pack list

## Goal

Upload the resource packs from `K:\PvP\Pack DL\Sakyvo` into the VALE remote pack storage architecture and add every accepted or duplicate-resolved pack to a website List named `Sakyvo`.

User value: the Sakyvo collection becomes browsable/downloadable on the site through a dedicated List, while existing storage rules and duplicate handling are preserved. SBI inclusion is deferred for a separate follow-up.

## Confirmed Facts

- Source folder: `K:\PvP\Pack DL\Sakyvo`.
- Current source scan found 630 `.zip` files, about 13.48 GB total.
- Current `data/pack-registry.json` contains 198 registered packs.
- Current `data/index.json` exposes 195 site packs.
- Applying the current `extract-textures.js` pack ID rules to the source folder yields about 622 unique pack IDs from 630 source zip files.
- Current planning scan found 63 source zip filenames already present in `data/pack-registry.json`, 75 source files whose pack ID already exists in `data/index.json`, 73 unique existing pack IDs, and about 549 unique new pack IDs.
- Current planning scan found about 547 upload-candidate files after pack ID dedupe; final numbers must be produced by a dry-run script immediately before execution.
- Current `l/lists.json` does not contain a `Sakyvo` List.
- Existing List records use `{ name, cover, description, packs }`, where `packs` stores sanitized pack IDs, not zip filenames.
- `scripts/upload-pack.js` uploads zip files to `Sakyvo/packs-NNN`, chooses the first local repo without `!  FULL  !`, creates a new repo if needed, writes `data/pack-registry.json`, and skips only when the exact zip filename already exists in the registry.
- `scripts/generate-index.js` reads `l/lists.json`, maps pack IDs to Lists, reads `data/pack-registry.json` for download URLs, and regenerates `data/index.json`, `data/pages/page-*.json`, and `data/packs/*.json`.
- `scripts/extract-textures.js` deduplicates only within the scanned `resourcepacks` folder by sanitized `packId`.
- `assets/js/admin.js` has browser-side behavior that detects duplicates by sanitized pack ID against `/data/index.json`; duplicates are not uploaded, but duplicate pack IDs are still added to selected Lists.
- `/l/<list>/index.html` pages exist for current Lists; `404.html` can redirect dynamic `/l/...` paths back to `/l/`, but the admin flow creates a page for each List.
- Project rules say the main repository must not contain `.zip` packs or a `resourcepacks/` directory.
- Project rules say run `git pull` before the task and `git push` after finishing, unless explicitly skipped.
- Project rules say each pack storage repository has a 5 GB limit and gets a `!  FULL  !` marker when full.

## Requirements

- Create or update the `Sakyvo` List in `l/lists.json`.
- Add every source pack that resolves to a site pack ID to the `Sakyvo` List exactly once.
- For packs already present by exact zip filename or duplicate pack ID, skip re-uploading the zip but still include the existing pack ID in `Sakyvo`.
- Upload only genuinely new zip files to `Sakyvo/packs-NNN` repositories according to the existing storage rules.
- Update `data/pack-registry.json` so every newly uploaded zip maps to the correct storage repository and byte size.
- Regenerate thumbnails/extracted metadata/index data needed for newly accepted packs.
- Regenerate download URLs through `scripts/generate-index.js`.
- Do not regenerate SBI fingerprint data in this task.
- Do not leave or commit `.zip` files or a `resourcepacks/` directory in the main site repository.
- Preserve unrelated working-tree changes.

## Acceptance Criteria

- [ ] `Sakyvo` exists in `l/lists.json` with all accepted source pack IDs and no duplicate entries.
- [ ] Exact existing packs and duplicate-ID packs are represented in `Sakyvo` without re-uploading their zip files.
- [ ] New packs are uploaded only to `Sakyvo/packs-NNN` remote repositories, respecting the 5 GB/full-marker rules.
- [ ] `data/pack-registry.json` includes all newly uploaded zips with correct `repo`, `repoNum`, and `size`.
- [ ] Generated site data (`data/index.json`, `data/pages/*`, `data/packs/*`) reflects the `Sakyvo` List and new download URLs.
- [ ] Required thumbnails and non-SBI site metadata are regenerated.
- [ ] Validation commands for index/build/SBI pass, or any failure is documented with a concrete blocker.
- [ ] Main repository has no committed `.zip` files and no committed `resourcepacks/` directory.
- [ ] Remote pushes complete for pack repositories and the main site repository, unless the user explicitly asks to skip push for this task.

## Out of Scope

- Redesigning the SBI scoring algorithm.
- Regenerating SBI fingerprint data, bumping SBI cache versions, or running SBI regression tests.
- Changing the public storage architecture beyond the established `packs-NNN` repository model.
- Cleaning unrelated current working-tree changes.

## Open Questions

- None. Planning is ready for review.
