# Sakyvo Minecraft Resourcepacks Content Blockers

Source: `C:\Users\ASUS\AppData\Roaming\.minecraft\resourcepacks`

List target: `Sakyvo`

Audited: 2026-07-14

## Audit Summary

- Original task scope: 1103 zip files.
- Exact matches to the registered remote filename and archive: 970.
- Byte-identical renamed source copies whose retained remote pack is already in `Sakyvo`: 58.
- Files requiring full visual fingerprinting: 75.
- Exact same-pack-ID visual matches retained without upload: 16.
- Duplicate source files skipped: 11.
- Newly uploaded files: 8 files / 169,209,488 bytes to `packs-005` commit `2c3a8a6`.
- Oversize blockers: 4 canonical files; see [SAKYVO_MINECRAFT_RESOURCEPACKS_OVERSIZE_PACKS.md](./SAKYVO_MINECRAFT_RESOURCEPACKS_OVERSIZE_PACKS.md).
- Same-pack-ID content conflicts: 35. These are hard blockers and were not uploaded.
- Renamed exact-content duplicates awaiting a retain decision: 0. The one reviewed duplicate was resolved by retaining the existing Azert pack.

Four `ZZZ TEST *.zip` identity fixtures created after the original 1103-file task snapshot were excluded from upload.

## Uploaded In The Follow-Up Audit

| File | Pack ID | Repository |
| --- | --- | --- |
| `§3! BLUE 32x.zip` | `BLUE_32x` | `packs-005` |
| `#LOL.zip` | `LOL` | `packs-005` |
| `§4§lDeproved §4§l1k EDIT.zip` | `Deproved_1k_EDIT` | `packs-005` |
| `§4Deproved 1k.zip` | `Deproved_1k` | `packs-005` |
| `! §cEUM3 §4Mash.zip` | `EUM3_Mash` | `packs-005` |
| `Hyperpop 1k beta.zip` | `Hyperpop_1k_beta` | `packs-005` |
| `#Private Fyes Default.zip` | `Private_Fyes_Default` | `packs-005` |
| `§b§lM0DIFIER §8§lPrivate.zip` | `M0DIFIER_Private` | `packs-005` |

## Same Pack ID, Different Visual Content

These source files resolve to a public pack ID that already belongs to different complete visual content. They must be reviewed and renamed to a distinct pack ID before upload; `--skip-blockers` cannot bypass them.

| Source file | Conflicting pack ID |
| --- | --- |
| `#T-Zone.zip` | `T-Zone` |
| `!Revedents Azure FaithFul.zip` | `Revedents_Azure_FaithFul` |
| `#§9Amaranth 32x Blue.zip` | `Amaranth_32x_Blue` |
| `! §aInfera.zip` | `Infera` |
| `Yokabi Edit.zip` | `yokabi_edit` |
| `Conquest.zip` | `Conquest` |
| `#eum3edit OG EDIT.zip` | `eum3edit_OG_EDIT` |
| `Plast Pack.zip` | `Plast_Pack` |
| `§3Xetha.zip` | `Xetha` |
| `DEFAULT LOW FIRE HD SKY.zip` | `DEFAULT_LOW_FIRE_HD_SKY` |
| `! §bLunar §8[§f128x§8].zip` | `Lunar_128x` |
| `#FaithYellow.zip` | `FaithYellow` |
| `a dariogoat private pack.zip` | `a_dariogoat_private_pack` |
| `! Tory EUM3 Revamp.zip` | `Tory_EUM3_Revamp` |
| `#FHZR.zip` | `FHZR` |
| `! Eum3 FPS.zip` | `Eum3_FPS` |
| `!#Fire.zip` | `fire` |
| `! XethaFaith 2.0.zip` | `XethaFaith_2.0` |
| `! §9Bedwars §8[§f32x§8].zip` | `Bedwars_32x` |
| `! Blue 128x.zip` | `Blue_128x` |
| `§1Black§4red.zip` | `Blackred` |
| `!   §bXethaFaith.zip` | `XethaFaith` |
| `Pax10 Revamp.zip` | `Pax10_Revamp` |
| `!!!!Eum3 Blue Revamp.zip` | `Eum3_Blue_Revamp` |
| `!     §bPotfast 5kay.zip` | `Potfast_5kay` |
| `!       Tory block overlay.zip` | `Tory_block_overlay` |
| `!     Ice 128x.zip` | `Ice_128x` |
| `! Blue 128x VIRUZZ COLOR.zip` | `Blue_128x_VIRUZZ_COLOR` |
| `#§eCoolPvP Revamp.zip` | `CoolPvP_Revamp` |
| `! Purple 128x.zip` | `Purple_128x` |
| `private default edit.zip` | `Private_Default_EDIT` |
| `! Gray 128x.zip` | `Gray_128x` |
| `! Eum3 FPS [red hearts].zip` | `Eum3_FPS_red_hearts` |
| `§6Vene §4§l[32x].zip` | `Vene_32x` |
| `!  §4§lFight§f§lClub v2+.zip` | `FightClub_v2` |

## Resolved Renamed Exact-Content Duplicate

| Incoming file | Incoming pack ID | Existing retained candidate | Status |
| --- | --- | --- | --- |
| `!       §1TEST.zip` | `TEST` | `!     §1Azert (DarkBlue) [Revamp].zip` / `Azert_DarkBlue_Revamp` in `packs-003` | Existing Azert retained; alias recorded; local `TEST` deleted |

The existing `Azert_DarkBlue_Revamp` pack remains in the `Sakyvo` List. The discarded `TEST` archive SHA-256 and visual identity are recorded in `data/internal/pack-content-aliases.json` so the renamed copy is not proposed again.
