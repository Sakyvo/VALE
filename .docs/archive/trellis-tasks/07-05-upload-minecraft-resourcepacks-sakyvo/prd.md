# Upload local Minecraft resourcepacks to Sakyvo list

## Goal

Upload all acceptable zip resource packs from `C:\Users\ASUS\AppData\Roaming\.minecraft\resourcepacks` to the remote `Sakyvo/packs-NNN` storage repositories and add their pack IDs to the `Sakyvo` List.

## Requirements

- Only perform pack upload and List/index updates.
- Do not regenerate SBI fingerprints, do not bump `SBI_FINGERPRINT_VERSION`, and do not change `assets/js/sbi.js` or `data/sbi-fp/`.
- Upload new zip files to remote pack repositories according to the pack storage rules in `AGENTS.md`.
- Skip already-known identical pack IDs for upload, but still ensure accepted pack IDs are present in the `Sakyvo` List.
- Skip duplicate source files within the input folder.
- Record oversize or otherwise blocked packs in a new markdown file under `docs/`.
- Regenerate the public index after registry/List changes so download URLs point at the pack repositories.
- Do not leave resource-pack zip files, `resourcepacks/`, or long-lived `packs-NNN` clones in the main site repository or `.vale-pack-upload`.

## Acceptance Criteria

- [x] Accepted packs from the source folder are represented in the `Sakyvo` List.
- [x] New uploaded packs are recorded in `data/pack-registry.json`.
- [x] `data/index.json` is regenerated and uses registry-backed download links.
- [x] Oversize/blocked packs are documented under `docs/`.
- [x] No SBI fingerprint files are changed.
- [x] Upload staging clones/caches are cleaned after successful push.
- [x] Verification confirms no `.zip` files or `resourcepacks/` directories were added to the main repository.

## Notes

- Prior dry-run estimate: 1103 zip files, 370 upload-new files, 677 existing pack IDs skipped for upload, 51 duplicate source files skipped, 5 oversize blockers, about 8.45 GiB new upload bytes.

## Completion Evidence

- The original 1103-file snapshot was re-audited after content-identity enforcement: 970 same-name archives were byte-identical to registry entries, and 58 renamed byte-identical copies resolve to retained packs already in `Sakyvo`.
- Full visual review of the remaining 75 files found 16 exact same-ID matches, 11 duplicate source files, 35 same-ID/different-content hard blockers, 4 canonical oversize blockers, one renamed exact-content decision, and 8 safe new uploads.
- The 8 safe files (169,209,488 bytes) were pushed to `Sakyvo/packs-005` in commit `2c3a8a6`; the upload command verified each remote archive before updating the main-repository data.
- Registry and content index both contain 1121 entries, with zero scan failures and registry digest `ec12ec112c33197ea9c14a8d2e2f48eeb35a797111a2d9ccef87394090d90109`.
- The `Sakyvo` List contains 1055 unique pack IDs, including all 8 follow-up uploads. Existing accepted/duplicate-retained source identities have zero missing List memberships.
- `node scripts/generate-index.js` regenerated 741 public packs; all 741 generated download records resolve to their matching registry repository with zero fallback or mismatch.
- Per the approved upload-only scope, the 8 follow-up archives were not texture-extracted and no SBI fingerprint was generated.
- Blocked content is recorded in `docs/SAKYVO_MINECRAFT_RESOURCEPACKS_CONTENT_BLOCKERS.md`; oversize files remain recorded in `docs/SAKYVO_MINECRAFT_RESOURCEPACKS_OVERSIZE_PACKS.md`.
- No tracked zip, no tracked `resourcepacks/`, and no `.vale-pack-upload` directory remain in the main workspace.
