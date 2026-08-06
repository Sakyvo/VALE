# VALE Domain Language

VALE uses these terms to distinguish repairable Minecraft 1.8 resource packs from material that must not enter or remain in the catalog.

## Language

**Normal pack**:
A Minecraft 1.8 resource pack that satisfies the current Plot normal-form definition. It is the only pack form eligible to enter or remain in the catalog.
_Avoid_: Clean pack, valid pack

**Repairable pack**:
A pack that is not in normal form but can be deterministically converted into a **Normal pack** under the current Plot rules. It is mutually exclusive with **非法材质**.
_Avoid_: Problem pack, bad pack

**Published pack identity**:
The stable catalog identity of an online pack, comprising its pack ID and archive filename. A one-product normalization preserves this identity; splitting a collection retires the parent identity and creates one identity per product.
_Avoid_: Display name, source name

**Normalization migration**:
The controlled conversion of an already published pack to Normal form while preserving its Published pack identity whenever the conversion yields one product.
_Avoid_: Replacement upload, re-import

**Collection product**:
One independent Normal pack produced from a source archive that contains multiple pack roots. Each Collection product has its own Published pack identity.
_Avoid_: Child file, split archive

**非法材质**:
An archive that cannot be recognized as a usable Minecraft 1.8 resource pack and cannot be automatically converted into one by the agreed normalization rules. It is mutually exclusive with a repairable pack.
_Avoid_: 有问题的包, 异常包, 损坏包

**高版本材质**:
An intact, readable resource pack built for a Minecraft version newer than VALE's 1.7/1.8 scope, recognized by its texture layout rather than by any declared version. It is neither a **Repairable pack** nor **非法材质**: nothing is broken and nothing is converted. It is ignored on sight — never uploaded, never listed, never fingerprinted.
_Avoid_: 新版包, 损坏包, 不兼容包

**Overlay pack**:
A pack that changes only selective visuals rather than the core PvP texture set, so it cannot be identified as a full pack from a screenshot. It stays in the catalog but is withheld from the homepage grid and from Search by Image.
_Avoid_: 部分包, 补丁包, 主题包

**投稿者 List**:
A List named after the external person who supplied its packs. Its membership is the provenance of those packs, not a curatorial judgement.
_Avoid_: 来源 List, 批次 List, 分类 List

**Sakyvo List**:
The site's own collection. It is not the complete catalog: packs from a **投稿者 List** never join it.
_Avoid_: 全量表, 总表, 默认 List

## Example Dialogue

Developer: This archive only has an extra wrapper directory. Is it illegal material?

Domain expert: No. It is a Repairable pack because Plot can convert it into a Normal pack; only an unrecognizable and unrepairable archive is 非法材质.

Developer: This pack opens fine and every texture is intact, but its textures live under `textures/item/`. Is it a Repairable pack?

Domain expert: No. It is 高版本材质. Repair means converting a pack into normal form; here there is nothing to repair — the pack is simply outside our version scope, so we ignore it rather than convert it.

Developer: A contributor sent me two folders of packs in two batches. Do I get two Lists?

Domain expert: No. A 投稿者 List is named after the person, not the transfer. Two batches from one contributor are one List, and those packs stay out of the Sakyvo List because they are not the site's own collection.
