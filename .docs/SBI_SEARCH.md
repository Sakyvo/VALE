# Search By Image

SBI identifies the Minecraft PvP resource pack shown in an uploaded screenshot. Matching stays browser-side so the site remains compatible with static GitHub Pages hosting.

## Search Flow

1. `extractHotbarSlots` extracts hotbar-slot observations from the screenshot.
2. `inferDisplaySlotTypes` infers item types such as diamond sword, ender pearl, healing potion, steak, and golden carrot.
3. `matchPacks` compares each observation with the corresponding texture fingerprints for every candidate group.
4. Slot, HUD, and widget scores are combined and ranked; exact observable groups are displayed together.

Packs in the `Overlay` and `Conquest` Lists remain browsable through their Lists but are excluded from SBI generation and results.

## Fingerprints

`scripts/generate-sbi-data.js` builds fingerprints from `thumbnails/` and writes sharded JSON under `data/sbi-fp/`.

Each texture fingerprint contains:

- `dhash`: perceptual difference hash
- `hist`: color histogram
- `moments`: RGB moments
- `edge`: edge strength
- `sig`: coverage, luminance, color-distribution, and shape features

## Scoring

```text
Type:  DS=8.0  EP=8.2  HL=4.8  SK/GC=0.45
HUD:   HP=6.4  Hun=5.4  Arm=5.2
Mix:   slot=0.44  hud=0.36  widget=0.20
```

Diamond sword and ender pearl carry the most distinguishing weight. Healing potion is secondary; food textures have deliberately low weight.

## Shards

- `diamond_sword.json`, `ender_pearl.json`, and `splash_potion.json`: high-weight item anchors
- `food.json`: steak and golden carrot
- `widget.json`: hotbar widget
- `health.json`, `hunger.json`, and `armor.json`: HUD observations
- `meta.json`: group, rarity, exclusion, and version metadata

The client loads only the shards required by the detected observation types.

## Versioning And Regression

- Keep `SBI_FINGERPRINT_VERSION` synchronized in `scripts/generate-sbi-data.js` and `assets/js/sbi.js`.
- After fingerprint or matcher changes, advance the `sbi.js` cache buster in `sbi/index.html`.
- Run `python test_sbi.py`; the current labeled corpus contains nine screenshots and each must retain a number-one match.
- Do not report broader accuracy than the labeled corpus actually verifies.
