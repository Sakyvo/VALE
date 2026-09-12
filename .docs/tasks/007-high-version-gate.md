Status: done
Executor: Claude Code

## Parent

Grill session 2026-08-01 (high-version packs, overlay grouping, frontend consistency)

## What to build

Teach VALE's ingestion to recognize 高版本材质 and refuse to publish it.

The rule is adopted from Plot ADR 0003 and must not be re-derived from declared metadata: a pack's Minecraft generation is read from its texture directory layout, never from `pack_format`, mcmeta parseability, or filename. Plural `textures/items/` or `textures/blocks/` is low-version evidence and wins outright. Otherwise, textures present under singular `textures/item/`, or the presence of a singular `textures/block/`, mark the pack as 高版本材质. With neither signal present, classification continues under the existing tolerant structural rules.

The signal's boundary is the matched inner pack, not the scan entry: it never propagates up to a classification folder, single-pack wrapper, or archive shell, and never affects sibling packs inside the same container.

A 高版本材质 pack is ignored on sight — excluded from upload and from List membership, recorded in the audit ledger with its own classification cause. It is neither 非法材质 (nothing is unreadable) nor a Repairable pack (nothing is converted), so it must not reuse either bucket. Encountering one does not fail the run: the remaining packs upload normally. The exclusion is definitive, so `--skip-blockers` must not bypass it.

Record the decision as `.docs/adr/0002-*.md`: why the texture-directory signal replaces `pack_format` (real 1.8 packs declare unreliably; gating on declarations causes severe false rejection), and why 高版本材质 gets its own classification rather than folding into 非法材质.

## Acceptance criteria

- [x] Detection function returns the low/high/no-signal verdict from directory layout alone and is unit-tested against both singular-only and plural-bearing fixtures
- [x] `meezoid`, `Doly_128x`, `qCh1ll__Private` fixtures classify as 高版本材质; `red_rojo`, `1.7_Low_Fire`, `Overlay_Gapple_Money` classify as low-version
- [x] A container holding one high-version and one low-version inner pack uploads only the low-version one
- [x] A dry-run over a source containing a high-version pack reports it as skipped with its own cause, exits successfully, and uploads the other entries
- [x] `--skip-blockers` does not make a high-version pack uploadable
- [x] The audit ledger records the skip with its classification cause
- [x] `.docs/adr/0002-*.md` exists and states the `pack_format` rejection rationale

## Blocked by

None - can start immediately
