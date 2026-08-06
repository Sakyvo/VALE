# Pack Storage

## Repository Layout

- `Sakyvo/VALE` is the GitHub Pages site repository for code, thumbnails, and public data indexes. It must not store resource-pack archives.
- `Sakyvo/packs-001` through `Sakyvo/packs-NNN` store `.zip` archives under `resourcepacks/`.
- Each pack repository uses 5 GiB as a soft allocation threshold. Archives are assigned in ascending modification-date order.
- When a repository is full, create `!  FULL  !` at its root. Upload to the first repository without that marker; create the next numbered GitHub repository when none remain.
- A repository already above 5 GiB is not invalid and its packs are not illegal; mark it full and allocate future writes elsewhere.
- `!  FULL  !` is sticky. Deleting current-tree archives during migration does not remove the marker because historical Git objects still consume repository storage; reuse requires a separate manual capacity audit.

## Local Safety

- The site repository must contain no `.zip` resource packs and no `resourcepacks/` directory.
- `K:/Projects/website/.vale-pack-upload` is a temporary clone/cache location only. Remove temporary `packs-NNN` clones after a successful push and from failure cleanup.
- Do not use local directories to extend remote storage capacity. Durable archives belong only in the corresponding remote GitHub repository.

## Registry And Download URLs

`data/pack-registry.json` maps each original archive filename to its repository and byte size:

```json
{
  "Pack.zip": {
    "repo": "packs-001",
    "repoNum": 1,
    "size": 12345678
  }
}
```

`scripts/generate-index.js` reads `size` as `fileSize` and generates:

- GitHub: `https://raw.githubusercontent.com/Sakyvo/{repo}/main/resourcepacks/{name}.zip`
- Mirror: `https://ghfast.top/https://raw.githubusercontent.com/Sakyvo/{repo}/main/resourcepacks/{name}.zip`

If a registry record is absent, generation falls back to the legacy main-repository path.

## Change Flow

- Upload tooling updates `data/pack-registry.json`; regenerate the public index after adding packs or changing List membership.
- Lists contain sanitized pack IDs, while registry keys retain original archive filenames.
- Reuse `scripts/pack-utils.js` for pack IDs. Windows filenames are case-insensitive, and URL construction must encode special characters such as `§`, `!`, and `#` with `encodeURIComponent`.

## Key Files

| File | Purpose |
| --- | --- |
| `data/pack-registry.json` | Archive-to-repository mapping |
| `scripts/upload-folder.js` | Batch planning and upload entry point |
| `scripts/extract-textures.js` | Texture and thumbnail extraction |
| `scripts/generate-index.js` | Public index and download URL generation |
| `scripts/generate-sbi-data.js` | SBI fingerprint generation |
| `assets/js/sbi.js` | Browser-side SBI matching |
