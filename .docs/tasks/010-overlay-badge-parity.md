Status: done
Executor: Claude Code

## Parent

Grill session 2026-08-01 (high-version packs, overlay grouping, frontend consistency)

## What to build

Give the Overlay badge the site's own visual language and show it wherever a pack card appears.

Today the badge exists only in homepage search results, so the same pack renders with a badge on one page and without on another. Its colours are also foreign to the site: translucent black with orange text and a small radius, none of it from the token layer, and the radius violates the containers-stay-square boundary. Meanwhile the site already speaks a consistent Overlay language elsewhere — the Overlay entry on the List index and the `[Overlay]` link on pack detail are both red.

Restyle the badge to that established language: solid dark surface, the same Overlay red, square corners, sized up enough to read at a glance. Overlay covers look alike, so partial occlusion of the artwork is acceptable and expected. Then render it from every surface that draws a pack card, so homepage and List pages agree.

Capture the underlying rule in `AGENTS.md`: the homepage and List pages must stay consistent — for one pack, card structure, badges, name typography, and interaction behavior must match across both, and changing one requires changing the other.

## Acceptance criteria

- [x] Badge uses the existing Overlay red on a solid dark surface with square corners and no translucency, drawn from tokens where they exist
- [x] Badge is legibly larger than before; partial cover occlusion is accepted
- [x] An overlay pack shows the identical badge in homepage search results and on List pages
- [x] No other pack-card difference remains between homepage and List surfaces
- [x] `AGENTS.md` carries the homepage/List consistency rule
- [x] Site-wide style cache buster bumped and generated pack pages regenerated

## Blocked by

None - can start immediately
