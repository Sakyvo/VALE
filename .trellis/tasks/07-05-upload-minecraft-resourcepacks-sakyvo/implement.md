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

## Commands

```bash
git pull
node scripts/upload-folder.js --source "C:/Users/ASUS/AppData/Roaming/.minecraft/resourcepacks" --list Sakyvo --dry-run
node scripts/upload-folder.js --source "C:/Users/ASUS/AppData/Roaming/.minecraft/resourcepacks" --list Sakyvo
node scripts/generate-index.js
git status --short
```
