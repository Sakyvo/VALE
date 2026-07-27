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

## Example Dialogue

Developer: This archive only has an extra wrapper directory. Is it illegal material?

Domain expert: No. It is a Repairable pack because Plot can convert it into a Normal pack; only an unrecognizable and unrepairable archive is 非法材质.
