# Quality Guidelines

## Project Gates

The project has no configured linter or TypeScript checker. Do not claim those gates ran. Use the checks that exist and scale them to the changed surface.

| Change | Required checks |
| --- | --- |
| Any JavaScript | `node --check <changed-files>` |
| Node ingestion/content identity | `npm test` |
| Index/List/generator data | `node scripts/generate-index.js`, then inspect generated diffs |
| Pack page generator | `node scripts/build.js` |
| SBI matcher or fingerprint data | `python test_sbi.py` and the task's performance/determinism gates |
| CSS/page interaction | Browser review at desktop and mobile widths |
| Upload/storage | Registry/List/index consistency plus main-repo zip/staging checks |

## Test Conventions

- Node tests use the built-in `node:test` runner under `tests/*.test.js`.
- Create test archives and mutable fixtures under the OS temporary directory, then remove them in cleanup/finally.
- Remote-write behavior is tested with runtime-created archives and mocked/local registry/index files, not live repositories.
- A bug fix requires a regression assertion that would fail if the fix were removed.
- Test failure paths as well as success paths, especially stale indexes, hash changes, duplicate IDs, malformed archives, and cleanup.

```js
// tests/pack-content-index.test.js
test('fails closed for stale, incomplete, and missing content index data', () => {
  const cases = [
    [null, 'content_index_missing_or_unsupported'],
    [{ schemaVersion: 1, complete: true, registryDigest: 'stale', failures: [], packs: {} }, 'content_index_stale'],
  ];
  for (const [index, code] of cases) {
    assert.throws(
      () => validateContentIndex(index, registry),
      error => error instanceof PackContentIndexError && error.code === code
    );
  }
});
```

## Generated Data Discipline

- Run the authoritative generator rather than manually formatting generated JSON/HTML.
- Inspect `git diff --stat` and `git diff --check` after generation.
- A deterministic generator should produce no unrelated diff on a second run.
- Coordinate versioned assets: SBI fingerprint changes require both `SBI_FINGERPRINT_VERSION` and the `sbi.js` HTML cache buster to advance.
- Do not revert unrelated dirty files to obtain a clean diff; compare only the task-owned paths.

## Frontend Review

- Preserve shared CSS variables, 2px borders, typography, spacing, header height, and control patterns.
- Confirm text does not overflow controls/cards and grids remain stable across existing breakpoints.
- Main/List pack links open a new tab with `noopener noreferrer`.
- Homepage/List search submits on button or Enter; clearing the field restores all results immediately.
- Icon-only controls need an accessible name and tooltip/title.
- Avoid nested cards, decorative page-section cards, and one-off visual styles.

## Repository And Remote Safety

- The main repository must have zero tracked `.zip` files and zero `resourcepacks/` paths.
- `.vale-pack-upload` is temporary only and must be absent after success or handled failure.
- Never delete/replace a remote pack from a scan alone. Apply the documented two-phase verification flow.
- Check registry count/digest, content-index coverage/failures, List uniqueness, generated download URLs, and remote commit/file verification after uploads.

## Review Checklist

- Requirements and explicit out-of-scope boundaries still match the diff.
- Changed behavior has focused tests.
- Cross-file constants and cache versions are synchronized.
- Generated changes are explained and limited.
- No credentials, temporary archives, manifests, clones, or debug fixtures entered the commit.
- Deployment/workflow completion is checked when the requirement is user-visible online behavior.

## Common Mistakes

- Do not use a passing narrow unit test to claim a full-catalog or deployed workflow passed.
- Do not report public SBI accuracy beyond the labeled screenshot corpus that was actually tested.
- Do not bypass blockers with `--skip-blockers` when content identity is stale, conflicting, or unresolved.
- Do not leave a server, browser, scanner, or upload process running when reporting completion.
