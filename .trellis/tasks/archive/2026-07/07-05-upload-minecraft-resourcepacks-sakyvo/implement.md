# Implementation Plan

1. Read pack ingestion specs and relevant scripts.
2. Pull the main site repository before changing data.
3. Run a dry-run upload from `C:\Users\ASUS\AppData\Roaming\.minecraft\resourcepacks` to confirm counts and blockers.
4. Run the real upload with `--list Sakyvo`.
5. Create a `docs/` markdown report for oversize/blocked packs if the script does not already do so.
6. Regenerate `data/index.json`.
7. Verify:
   - no `data/sbi-fp/` changes;
   - no `.zip` files or `resourcepacks/` in the main repository;
   - no retained `.vale-pack-upload` pack clones/caches;
   - `Sakyvo` List contains accepted pack IDs;
   - registry entries exist for new uploads.
8. Report changed files, upload counts, blocked packs, and any test limitations.

## Execution Result

- Original upload: 370 files accepted and uploaded; 5 oversize source files documented.
- Follow-up identity audit: 8 previously missed safe files uploaded to `packs-005`; 35 same-ID content conflicts and one renamed duplicate were blocked rather than bypassed.
- Main data changes are limited to the registry, complete content index, Sakyvo List, duplicate report, and content-blocker report.
- Public index regeneration produced no additional pack cards because the requested scope remains upload plus List membership only; no texture extraction was run for the 8 follow-up files.

## Commands

```bash
git pull
node scripts/upload-folder.js --source "C:/Users/ASUS/AppData/Roaming/.minecraft/resourcepacks" --list Sakyvo --dry-run
node scripts/upload-folder.js --source "C:/Users/ASUS/AppData/Roaming/.minecraft/resourcepacks" --list Sakyvo
node scripts/generate-index.js
git status --short
```
