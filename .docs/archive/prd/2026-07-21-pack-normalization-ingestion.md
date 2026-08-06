## Problem Statement

VALE accepts Minecraft 1.8 resource packs through several inconsistent paths. The main batch uploader checks names and visual identity but uploads the original archive bytes, while legacy scripts and browser administration can bypass even those checks. Archives that Minecraft or Lunar Client cannot read can therefore enter storage, repairable archives remain malformed for downloaders, and the same source can be classified differently by VALE and Plot.

The existing catalog has the same problem at rest. Every registered remote archive needs one normalization audit, but replacing or deleting an online archive is dangerous because registry data, Lists, extracted metadata, thumbnails, generated pages, SBI data, and remote storage must remain consistent throughout deployment. A scan alone is not sufficient authority to delete an archive. The migration must preserve Published pack identity and visibility where possible, split collections deliberately, distinguish unclassifiable safety blockers from illegal material, and recover safely from interruption.

The catalog is also expected to grow by roughly 4,000 packs. The legacy monolithic SBI fingerprint output will approach GitHub's hard per-file limit at that scale, while repository size and remote pack allocation thresholds must remain operational constraints rather than reasons to misclassify packs.

## Solution

VALE will make a versioned, self-contained CommonJS implementation of the accepted Plot rules the sole archive ingestion boundary. Every top-level source entry will be classified before upload. A Repairable pack will be converted into a reproducible Normal pack, validated again, fingerprinted, deduplicated, and only then allocated to remote storage. A newly discovered illegal material entry will not be uploaded or added to a List; it will be recorded in the internal normalization audit.

All archives named by the registry will receive a read-only one-time audit. Already-normal archives will remain byte-for-byte unchanged. A one-product Normalization migration will preserve Published pack identity and visibility, stage a verified same-named replacement in a different pack repository, switch the deployed catalog, and only then delete the old archive. Collections will produce independent Collection products. Registered illegal material will leave the full catalog first and the remote repository only after deployment verification.

Planning and execution will be separated by a hash-bound reviewed manifest and a monotonic per-entry state machine. The system will support explicit deferral but no implicit blocker skipping. All state changes will be auditable and resumable. Legacy write paths will delegate to or be retired in favor of the normalized pipeline.

SBI generation will retain only deterministic shards, with stable splitting around a 32 MiB target and no overall fingerprint-size ceiling. The duplicate monolithic fingerprint artifact will be retired.

## User Stories

1. As a VALE maintainer, I want Plot's accepted normal form to be VALE's canonical Normal pack definition, so that the two tools do not disagree about pack health.
2. As a VALE maintainer, I want normalization semantics to carry an explicit schema version, so that later Plot changes are adopted deliberately rather than silently.
3. As a VALE maintainer, I want normalization to be implemented inside VALE, so that ingestion is reproducible without a sibling Plot checkout or machine-specific executable.
4. As an uploader, I want every top-level source entry scanned, so that folder packs and incorrectly named archives are not silently ignored.
5. As an uploader, I want ZIP content detected by magic and structure rather than filename alone, so that `.ZIP`, fake `.rar`, and extensionless ZIP packs can be repaired.
6. As an uploader, I want nested source folders treated as individual pack containers rather than recursive scan roots, so that one source entry has one explainable provenance tree.
7. As an uploader, I want known operating-system junk ignored, so that it does not become false illegal material.
8. As a security-conscious maintainer, I want links and junctions rejected without traversal, so that source scanning cannot escape its declared boundary.
9. As a player, I want wrapper folders and nested ZIPs removed before download, so that Minecraft 1.8 can read the downloaded pack directly.
10. As a player, I want wrong core-file casing and known filename typos repaired, so that author content remains usable.
11. As a player, I want a missing `pack.mcmeta` synthesized when Plot can safely rescue the pack, so that a repairable archive is not discarded.
12. As a Lunar Client player, I want illegal JSON escapes minimally repaired without removing color information or description text, so that the pack remains visible in Lunar Client.
13. As a downloader, I want root bloat, known junk, and dead `assets/*/records/` paths removed, so that the distributed archive contains only useful pack content.
14. As a catalog maintainer, I want already-normal archives left byte-for-byte untouched, so that normalization does not create meaningless archive churn.
15. As a catalog maintainer, I want repaired output to be reproducible, so that a reviewed product hash can be regenerated during execution.
16. As a catalog maintainer, I want every generated product reclassified as Normal before upload, so that a repair bug cannot publish another malformed archive.
17. As a catalog maintainer, I want content identity calculated after normalization, so that repository allocation and duplicate decisions apply to the bytes users will receive.
18. As a catalog maintainer, I want one-product migration to preserve complete visual identity, so that structural repair cannot silently change pack appearance.
19. As an uploader, I want a collection archive split into independent Collection products, so that each usable inner pack can be cataloged normally.
20. As a catalog maintainer, I want each Collection product to receive its own filename, pack ID, identity checks, storage record, and List membership, so that the catalog remains one-pack-per-identity.
21. As a catalog maintainer, I want a collection's outer filename retained only as provenance, so that wrapper names do not become fake pack identities.
22. As a catalog maintainer, I want distinct same-named products in one collection assigned stable numeric suffixes, so that repeated planning yields identical identities.
23. As a catalog maintainer, I want a different-content collision with an existing Published pack identity blocked until an explicit name is supplied, so that automatic suffixing does not hide identity conflicts.
24. As a catalog maintainer, I want an exact existing content identity reused and recorded as provenance, so that duplicate bytes are not uploaded again.
25. As a catalog maintainer, I want normalization kept separate from duplicate cleanup, so that existing identities are never deleted merely because a scan found equal content.
26. As a catalog maintainer, I want exact duplicate retention to continue using hash-bound human decisions, so that deletion remains reviewable and reversible until final cleanup.
27. As an uploader, I want newly discovered illegal material excluded from upload and List membership, so that unusable downloads never enter the catalog.
28. As a catalog maintainer, I want every illegal material decision recorded with a stable reason, so that future scans can explain why a source was rejected.
29. As a catalog maintainer, I want registered illegal material removed from all public and internal catalog references, so that the site does not retain pages or fingerprints for deleted content.
30. As a site visitor, I want catalog references removed before the remote archive disappears, so that I do not encounter a visible download that has already become a 404.
31. As a catalog maintainer, I want deleted illegal material retained as an audit tombstone, so that later reintroduction is detectable and historical actions remain explainable.
32. As a catalog maintainer, I do not want illegal material exposed as a public List merely for maintenance visibility, so that the public catalog remains a collection of usable packs.
33. As a catalog maintainer, I want archive safety refusals separated from illegal material, so that an incompletely inspected pack is not misclassified.
34. As a security-conscious maintainer, I want entry-count, single-entry, and total-expanded-size limits enforced at every nested level, so that ZIP bombs cannot exhaust the ingestion host.
35. As a security-conscious maintainer, I want absolute paths, traversal paths, NUL paths, link entries, and colliding output paths rejected, so that normalization cannot write outside staging or overwrite another product.
36. As an uploader, I want a safety-limited pack represented as `blocked_archive_limits`, so that it can be explicitly deferred or rescanned with a reviewed limit change.
37. As an uploader, I want Plot bloat cleanup to run before the final archive-size gate, so that removable dead content does not create a false oversize blocker.
38. As an uploader, I want a normalized product still over GitHub's 100 MiB file limit represented as `blocked_oversize`, so that size is not confused with pack validity.
39. As a catalog maintainer, I want an already-online oversize pack left online and deferred when it cannot be restaged, so that migration does not create an outage.
40. As a catalog maintainer, I want every registry archive included in the one-time audit, so that hidden and public remote state cannot diverge.
41. As a catalog maintainer, I want registry-only entries to remain non-public after normalization, so that migration does not accidentally publish hidden archives.
42. As a catalog maintainer, I want a one-product Normalization migration to preserve filename, pack ID, route, upload date, Lists, and visibility, so that existing links remain stable.
43. As a catalog maintainer, I want a same-named normalized replacement staged in a different capacity-eligible repository, so that old and new bytes coexist during verification.
44. As a site visitor, I want the registry switched only after the staged replacement is verified, so that every deployed download target is valid.
45. As a catalog maintainer, I want the old remote archive deleted only after the deployed catalog points at the new copy, so that every migration phase retains at least one usable download.
46. As a catalog maintainer, I want a registered collection's parent identity retired when its products are published, so that one obsolete wrapper does not remain beside its children.
47. As a catalog maintainer, I want collection products to inherit the parent's non-derived Lists, so that curated and source membership is preserved.
48. As an SBI maintainer, I want `Overlay` and `Conquest` membership recomputed for each Collection product, so that a parent's visual classification is not copied blindly to every child.
49. As a catalog maintainer, I want a non-public collection's products to remain non-public, so that collection splitting preserves visibility.
50. As an operator, I want migration planning to be read-only, so that examining the catalog cannot mutate storage or metadata.
51. As an operator, I want the migration manifest bound to the registry digest, every selected archive SHA-256, and the normalization schema, so that reviewed evidence cannot be replayed against changed state.
52. As an operator, I want one batch-level review rather than a prompt for every pack, so that a full registry audit remains practical.
53. As an operator, I want unresolved hard blockers to stop execution by default, so that unsafe work cannot be hidden by a generic skip option.
54. As an operator, I want specific blockers explicitly marked `defer` in a reviewed decision file, so that safe work can proceed without silently forgetting exceptions.
55. As an operator, I want migration entries to progress monotonically through planning, staging, site preparation, deployment verification, old deletion, and completion, so that interrupted work resumes from known state.
56. As an operator, I want verified staged copies reused after interruption, so that large archives are not uploaded repeatedly.
57. As an operator, I want orphaned staged copies recorded rather than automatically deleted, so that cleanup cannot remove the wrong remote file.
58. As an operator, I want an archive or registry identity change to invalidate the relevant reviewed plan, so that stale decisions fail closed.
59. As a maintainer, I want the normalization audit to contain source identity, reasons, products, lifecycle state, and timestamps, so that operations are traceable.
60. As a maintainer, I want audit records to omit archive bytes and machine-specific absolute paths, so that the main repository stays small and portable.
61. As a maintainer, I want a generated Markdown summary of illegal, deferred, migrated, and retired entries, so that a batch can be reviewed without manually parsing JSON.
62. As a maintainer, I want one archive-write boundary, so that legacy scripts and browser code cannot bypass normalization.
63. As an administrator, I want browser administration to retain catalog/List management without direct archive upload or deletion, so that remote storage changes remain transactional.
64. As an operator, I want temporary downloads and repository clones removed on success and handled failure, so that staging does not become durable storage.
65. As a repository maintainer, I want 5 GiB treated as a soft pack-repository allocation threshold, so that an already-larger repository is not mistaken for invalid content.
66. As a repository maintainer, I want the full marker to remain sticky after current-tree deletions, so that unreclaimed Git history is considered before reusing an old repository.
67. As an SBI maintainer, I want only sharded fingerprint artifacts retained, so that the same data is not stored twice.
68. As an SBI maintainer, I want deterministic shard splitting around a 32 MiB target, so that growth by thousands of packs stays below GitHub's per-file limit.
69. As a site visitor, I want SBI to load only the observation shards required by my search, so that a larger catalog does not force a monolithic download.
70. As an SBI maintainer, I want no arbitrary total fingerprint-size ceiling, so that catalog growth is handled by sharding rather than rejection.
71. As a developer, I want Plot parity fixtures and schema-version tests, so that a later edit cannot accidentally change accepted normalization behavior.
72. As a developer, I want remote workflows tested with real temporary archives and fake repositories, so that tests cover user behavior without modifying production.
73. As a developer, I want failed and resumed migration states tested, so that the happy path is not the only verified path.
74. As a maintainer, I want the first production rollout to stop after a full dry-run for review, so that no remote deletion occurs before the evidence is accepted.

## Implementation Decisions

- Plot's current classification and repair behavior is the authority for Normal form. The accepted snapshot includes nested container rescue up to ten layers, extension rescue, core filename rescue, missing metadata generation, Lunar illegal-escape repair, root bloat removal, known junk removal, dead-path removal, and collection splitting.
- VALE owns a self-contained CommonJS normalizer. It does not execute Plot or depend on a sibling checkout. The normalization schema starts versioned and is recorded in plans, outputs, audits, and parity tests.
- The pure normalizer is separated from local-source upload orchestration, registry-backed Normalization migration, and two-phase finalization. Remote and catalog writes do not belong in the classification/repair core.
- Source ingestion enumerates top-level entries of a declared source directory. It inspects files and folders, ignores only the accepted junk/exclusion set, treats nested directories as containers, and never follows links or junctions.
- Normal output contains the accepted Plot root form and no Plot-defined bloat. Repair modifies only the structural and metadata bytes required by the accepted rules; all other resource bytes are preserved.
- Output ZIPs are deterministic: path ordering, filename encoding, archive metadata, and collision numbering are stable. Planning records the normalized product SHA-256, and execution must reproduce it.
- Archive protection is applied recursively: no more than 50,000 entries, 512 MiB per expanded entry, or 2 GiB total expanded bytes; no unsafe paths, link entries, or colliding materialized paths.
- A resource-limit refusal is a reviewable safety blocker, not illegal material. Plot-defined corrupt, encrypted, coreless, unsupported-container, and over-depth results are illegal material.
- Normalization precedes the 100 MiB remote file gate, content fingerprinting, duplicate handling, and repository allocation.
- Already-normal archives are never rewritten. A one-product migration requires the normalized visual-content hash to equal the registered source's complete visual-content hash.
- A collection creates one independent candidate per valid inner root. Inner-container names seed filenames and pack IDs. Same-source name collisions use deterministic ` (n)` suffixes; collisions with a different existing Published pack identity require an explicit reviewed override.
- Exact existing content is reused with provenance. Normalization does not authorize automatic duplicate deletion; the existing hash-bound keep-existing/keep-incoming process remains authoritative.
- Newly discovered illegal material produces no archive upload, public record, or List membership. Registered illegal material is removed from registry, content identity, extraction state, Lists, thumbnails, generated pack records/pages, and SBI data before its remote archive is deleted.
- The canonical normalization audit is internal, schema-versioned JSON. It stores stable source/remote identity, classification causes, normalized products, decisions, lifecycle state, and timestamps. A derived Markdown report provides human review.
- The existing migration selects all registry keys, not only public packs. It preserves whether each source is public, List-only, or registry-only.
- A one-product migration preserves Published pack identity and upload date. It stages the same filename in another eligible pack repository, verifies size/hash/Normal status/visual identity, changes catalog routing, verifies deployment, and then removes the old repository copy.
- A registered collection retires its parent identity. Every product inherits all non-derived List memberships; managed `Overlay` and `Conquest` membership is recomputed. Visibility is inherited rather than expanded.
- Planning emits a read-only manifest bound to the registry digest, selected source archive hashes, normalization schema, planned products, catalog effects, and remote effects. A separate reviewed decision document carries explicit name overrides, duplicate retention, and `defer` decisions.
- Unresolved blockers make the batch non-executable. The generic blocker-skip behavior cannot bypass content, normalization, safety, or decision checks.
- Per-entry migration state is monotonic: planned, staged and verified, site prepared, deployment verified, old archive deleted, complete. Retrying verifies and reuses completed work. Remote artifacts that cannot be proven safe to delete become recorded orphans.
- The normalized pipeline is the sole archive writer. Single-file convenience commands delegate to it; legacy migration writers reject new use; browser administration no longer creates or deletes archive blobs.
- Pack repository allocation uses 5 GiB as a soft threshold. Repositories already above it are marked full for future allocation rather than treated as invalid. Full markers are sticky until a separate manual capacity audit.
- GitHub's ordinary Git 100 MiB per-file limit remains a hard post-normalization gate. Git LFS and another archive backend are not introduced.
- SBI generation writes only deterministic shards. The monolithic fingerprint artifact is removed. A shard near 32 MiB splits by a stable key, and runtime metadata tells the browser which shards to request.
- Catalog regeneration uses normalized products and authoritative generators. Public changes trigger extraction/index/page rebuilds, managed List detection, SBI regeneration where inputs change, required fingerprint version/cache coordination, and stale-artifact removal.
- The rollout separates implementation, full dry-run, reviewed staging, site preparation/deployment, and remote cleanup. Building the feature does not itself authorize production remote writes.

## Testing Decisions

- The primary test seam is the exported ingestion/migration orchestration boundary. Tests construct real temporary pack entries and ZIPs, provide local registry/index/List/audit fixtures plus a fake remote adapter, invoke plan/execute/finalize behavior, and assert externally visible plans, products, catalog state, and lifecycle transitions.
- Focused normalizer tests use the same public classify/normalize interface with Plot-derived fixtures. They cover Normal, nested, folder, bloated, illegal, Lunar-illegal, multi-label repair, metadata rescue, collection splitting, encoding, name collisions, deterministic output, and post-write Normal reclassification.
- Safety tests cover traversal, absolute/NUL paths, link entries, case-insensitive output collisions, encrypted/corrupt archives, depth eleven, entry-count limits, per-entry limits, total expansion limits, and decompression failure.
- Identity tests use the existing complete visual fingerprint boundary. One-product repair must preserve visual identity; meaningful texture/config changes must still differ; exact duplicates and same-ID conflicts must retain current behavior.
- Migration tests exercise all lifecycle states, stale manifest rejection, explicit defer, interrupted staging, verified resume, deployment verification failure, remote hash change, orphan recording, illegal retirement, and collection parent retirement.
- Catalog tests assert Published pack identity, upload date, visibility, List inheritance, managed List recomputation inputs, generated index integrity, no stale pack pages/data/thumbnails, and no public illegal material.
- SBI generator tests assert no monolithic artifact, deterministic metadata and shard assignment, automatic stable splitting around the target, per-file size guards, and browser-compatible shard metadata.
- Browser administration tests assert that no archive upload/delete request can be issued while non-archive catalog management remains available.
- Tests never write production repositories or call destructive production APIs. Remote behavior is represented by fake/local repositories and runtime-created archives, following the existing upload and finalizer test conventions.
- Verification runs the Node test suite, syntax checks every changed JavaScript file, runs authoritative index/page generators, runs SBI regression when fingerprint artifacts change, checks generated diffs for determinism, validates no stale public references, and confirms no tracked ZIP, `resourcepacks/`, or retained temporary upload directory.
- The full registry dry-run is an operational acceptance test, not an automated unit test. Its manifest and Markdown report must be reviewed before any production execution phase.

## Out of Scope

- Native extraction or repair of real RAR and 7z archives.
- Git LFS or a new external archive-storage provider.
- Automatic deletion or consolidation of exact visual duplicates.
- Public `非法材质` Lists or pages.
- Automatic cleanup of source archives outside VALE's temporary workspace.
- Automatic removal of pack-repository full markers or Git history compaction.
- Moving thumbnails, SBI shards, or existing Git history to another hosting architecture; only sharded-only SBI output is included.
- Changing SBI matching semantics, ranking weights, or claimed accuracy beyond regeneration/versioning required by catalog changes.
- Automatically executing production migration or remote deletion immediately after implementation without the reviewed manifest gate.
- macOS/Linux parity with Plot's Windows desktop behavior beyond the Node ingestion behavior already supported by VALE's development and CI environments.

## Further Notes

- At planning time the registry contains 1,121 remote archives, while the public catalog is a smaller derived subset. The migration must therefore reason from registry state and separately preserve public visibility.
- The current complete content index is under 1 MiB and is not the projected scaling bottleneck. The current monolithic SBI artifact is about 16 MiB for 659 eligible packs and would likely cross 100 MiB after roughly 4,000 additions; existing observation shards remain comfortably below that limit at the same projection.
- The main repository's current packed Git object footprint is already near the 5 GiB recommendation range. Sharded-only SBI avoids duplicate generated data, but broader thumbnail/history offloading remains a separate architectural problem.
- The accepted architecture is recorded separately because duplicating Plot semantics inside VALE is deliberate: reproducibility and repository-local testing were chosen over invoking Plot's Rust executable.
- When this batch is complete and verified, archive its PRD and all child issues together so active project context does not retain finished migration planning.
