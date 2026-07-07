# Design

## Scope

Use the existing pack ingestion tooling to ingest `C:\Users\ASUS\AppData\Roaming\.minecraft\resourcepacks` into the named `Sakyvo` List without changing SBI.

## Data Flow

1. `scripts/upload-folder.js` scans the source folder and resolves pack IDs.
2. Existing pack IDs are skipped for upload but included in the requested List.
3. New pack files are uploaded to the first non-full remote `Sakyvo/packs-NNN` repository, creating later repositories if needed.
4. `data/pack-registry.json` records the remote repository and size for uploaded files.
5. The List data is updated so accepted pack IDs appear under `Sakyvo`.
6. `scripts/generate-index.js` regenerates `data/index.json` from registry/List inputs.
7. Oversize blockers are written to `docs/` for later handling.

## Boundaries

- SBI is intentionally out of scope. Do not run `scripts/generate-sbi-data.js`.
- Texture extraction is only allowed if the upload/index tooling requires thumbnails for normal site listing. It must not create or update SBI shards.
- Local staging under `K:\Projects\website\.vale-pack-upload` is temporary and must be removed after upload/push.
- The main site repository must not contain uploaded `.zip` files or `resourcepacks/`.

## Compatibility

The current registry-driven download URL behavior remains unchanged. Existing pack IDs and existing List membership should not be removed.
