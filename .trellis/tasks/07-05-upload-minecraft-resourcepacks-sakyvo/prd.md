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

- [ ] Accepted packs from the source folder are represented in the `Sakyvo` List.
- [ ] New uploaded packs are recorded in `data/pack-registry.json`.
- [ ] `data/index.json` is regenerated and uses registry-backed download links.
- [ ] Oversize/blocked packs are documented under `docs/`.
- [ ] No SBI fingerprint files are changed.
- [ ] Upload staging clones/caches are cleaned after successful push.
- [ ] Verification confirms no `.zip` files or `resourcepacks/` directories were added to the main repository.

## Notes

- Prior dry-run estimate: 1103 zip files, 370 upload-new files, 677 existing pack IDs skipped for upload, 51 duplicate source files skipped, 5 oversize blockers, about 8.45 GiB new upload bytes.
