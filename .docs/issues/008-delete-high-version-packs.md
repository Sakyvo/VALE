Status: done
Executor: Claude Code

## Parent

Grill session 2026-08-01 (high-version packs, overlay grouping, frontend consistency)

## What to build

Remove the three published 高版本材质 packs from the catalog: `meezoid`, `Doly_128x`, and `qCh1ll__Private`.

The existing replacement finalizer already implements the mandated two-phase cleanup but is keyed on an incoming replacement. Extend it with a deletion mode that takes no incoming pack: phase one strips every site-side record of the pack (registry, content index and aliases, extracted state, List membership, thumbnails, pack data, generated route page) and marks the entry pending deployment; phase two, after the site has deployed without the pack, deletes the remote archive and resolves the entry. Never collapse the two phases — the site must stop referencing the archive before the archive disappears.

The catalog audit behind this deletion is already complete and needs no repeat: every 高版本材质 pack necessarily falls back to the default sword thumbnail, all 28 packs matching that filter were inspected, and only these three carry the singular-directory signal. All 20 packs already in the Overlay List were verified low-version.

## Acceptance criteria

- [x] Deletion mode accepts entries with no incoming pack and refuses to run outside the two-phase sequence
- [x] Phase one leaves no reference to the three packs in registry, content index, aliases, extracted state, Lists, thumbnails, pack data, or generated pages
- [x] Phase two deletes the remote archives only after the site deployment no longer references them, and records `remote_deleted` in the pending ledger
- [x] Existing replacement-mode tests still pass and deletion mode has its own coverage
- [x] The three pack pages return 404 and no home, List, or Search-by-Image surface references them after deployment
- [x] Repository size accounting reflects the three removed archives

## Blocked by

- `007-high-version-gate.md`
