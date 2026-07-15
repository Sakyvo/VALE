# Upload Sakyvo Pack List Implementation Plan

## Checklist

1. Pre-flight
   - Run `git status --short` and record unrelated changes.
   - Run `git pull` in the main repo before implementation.
   - Confirm GitHub CLI/auth availability for creating or pushing `Sakyvo/packs-NNN` repos.
   - Confirm source folder still exists and count `.zip` files.

2. Build a dry-run manifest
   - Reuse the exact pack ID rules from `scripts/extract-textures.js`.
   - Compare source files against `data/pack-registry.json` by zip filename.
   - Compare source files against `data/index.json` by sanitized pack ID.
   - Detect intra-source duplicate pack IDs.
   - Emit counts and a machine-readable manifest before upload.

3. Adapt tooling for batch safety
   - Add or update a Node script for folder upload/list assignment that keeps source zips outside the main repo.
   - Add dry-run and execute modes.
   - Add batch commit/push per target pack repository.
   - Add repo capacity checks and `!  FULL  !` marker handling.
   - Add `Sakyvo` List creation/update behavior using pack IDs.

4. Upload new canonical packs
   - Clone/pull needed `packs-NNN` repositories into a temporary/workspace directory.
   - Upload only manifest entries classified as new canonical packs.
   - Push pack repository commits.
   - Update `data/pack-registry.json`.

5. Regenerate site metadata/assets
   - Extract thumbnails/metadata for the expanded pack set using the external source or a cleaned temporary staging approach.
   - Run `node scripts/generate-index.js`.
   - Run `node scripts/build.js`.
   - Ensure `l/Sakyvo/index.html` exists and uses the existing List page shell.

6. Validate
   - Run `node scripts/generate-index.js`.
   - Run `node scripts/build.js`.
   - Verify no `.zip` files and no `resourcepacks/` directory are left in the main repo.
   - Verify `Sakyvo` List count and sample download URLs.

7. Finish
   - Review `git diff` for main repo generated changes.
   - Push main repo changes after task finish per project rule.
   - Record that SBI regeneration is deferred.

## Validation Commands

```powershell
git status --short
node scripts/generate-index.js
node scripts/build.js
Get-ChildItem -Recurse -Filter *.zip
Test-Path resourcepacks
```

## Risky Files and Rollback Points

- `data/pack-registry.json`: source of truth for download repo mapping.
- `l/lists.json`: source of truth for List membership.
- `thumbnails/`, `data/extracted.json`, `data/index.json`, `data/pages/*`, `data/packs/*`: generated site metadata/assets.
- Pack repo pushes are remote side effects; dry-run manifest must be reviewed before execute mode.

## Review Gate Before Start

- User approves the PRD/design/implementation plan.
- User accepts that SBI regeneration and regression tests are deferred to a follow-up task.
