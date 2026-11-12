Status: blocked
Executor: pi

## Parent
`.docs/tasks/022-sbi-matching-rewrite.md`

## What to build
把 bake-off 胜出路线集成进浏览器生产路径:匹配核心模块以胜出路线替换 v23 打分;类型标签退 UI 展示;删除 CLIP 遗留(transformers.min.js、sbi-worker、旧 embeddings 数据与 ENABLE_CLIP 开关);同步 SBI_FINGERPRINT_VERSION 与 HTML cache buster;重跑 test_sbi.py 与评测台终审。

## Acceptance criteria
- [ ] `python test_sbi.py` 组级 9/9
- [ ] Complete versioned synthetic acceptance corpus group top-1 >=80%, measured through the verified production-equivalent path; keep the legacy light corpus as a separate control.
- [ ] Remove obsolete CLIP code/data/flags with caller checks; `npm test` has no new in-scope regressions, and any unrelated baseline failures are explicitly documented rather than called green.
- [ ] Actual cold-cache downloads from page open to the first complete refined result <=8MB, including page/runtime assets, metadata, coarse/refinement data and any model, as specified in `../spec/sbi-input-alignment.md`.
- [ ] `.docs/SBI_SEARCH.md` 流程章节与实现一致

## Blocked by
- `035-sbi-aligned-route-decision.md`

## Dependency and scope correction

Remains incomplete and waiting on the internal batch-029 prerequisites, not on an established external data-source blocker. Batch 029 owns the alignment repair and trustworthy measurements; 035 supplies a route decision and verified inputs. The obsolete unconditional dependency on 027 is removed: if retraining is approved, add the selected route's implementation evidence as a prerequisite; otherwise do not build an unnecessary model to satisfy an old dependency.

Historical local results were 3/9 on real screenshots and 77.5% for a standalone palette mode, not simultaneous proof of the complete shipping path. Neither meets the final gates, and poor ranks alone do not prove wrong reference textures or an impossible algorithmic problem. Do not lower 9/9 to 7/9 or change truth/group identity to close this card.

Final shipment also requires synchronized generated/reference versions and HTML cache references, verified static loading, preserved UI/HUD/widget behavior and the applicable product acceptance checks. A completed decision report in 035 does not itself mark this shipping task done.

## Verified inputs from 035 (inventory, not authorization)

The [035 decision report](../reports/sbi-035-aligned-route-decision.md) records that all three delivery gates currently fail, so this card must not advance on the strength of that report alone. The following are the concrete cleanup and linkage inputs it hands over.

Obsolete CLIP surface still present in the worktree:

| Path / site | Note |
| --- | --- |
| `assets/js/transformers.min.js` | 888,173 bytes; webpack ESM bundle of `@huggingface/transformers` + onnxruntime-web |
| `assets/js/sbi-worker.js` | 4,112 bytes; imports the bundle, `MODEL_ID = 'Xenova/clip-vit-base-patch32'` |
| `scripts/generate-sbi-embeddings.mjs` | 5,168 bytes; same `MODEL_ID` |
| `assets/js/sbi.js:46` | `const ENABLE_CLIP = false;` with guards at `:62`, `:792`, `:1338`, `:1557` |
| `package-lock.json` | `onnxruntime-web` 1.22.0-dev entry |
| `tests/design-contract.test.js:282`, `tests/toast.test.js:74` | skip-list entries naming `transformers.min.js`; must be updated in the same change or those suites silently keep a stale exemption |

Also inventory before deleting: any committed embedding data produced by `scripts/generate-sbi-embeddings.mjs`, and confirm no live caller remains after removal (grep for `ENABLE_CLIP`, `initClipWorker`, `clipWorker`, `sbi-worker`).

Version and cache linkage that must move together: `SBI_FINGERPRINT_VERSION` in both `assets/js/sbi-engine.js` and `scripts/generate-sbi-data.js`, the `?v=` cache busters in `sbi/index.html`, and the `aligned/index.json` `version`/`alignmentVersion` fields that `loadAlignedIndex` rejects on mismatch. Current values are fingerprint `24` and cache buster `118`.

Known evidence that will block these criteria even after cleanup: nine-shot 1/9, development top-1 35.02%, acceptance top-1 2516/7335, cold-cache 10,705,902 bytes on one complete measurement. Cleanup and linkage work must not be presented as progress on the accuracy or budget gates.
