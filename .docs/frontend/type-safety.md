# Type Safety

## Overview

The repository uses plain JavaScript, not TypeScript. There is no transpilation, declaration-file layer, schema library, or configured type checker. Safety comes from stable JSON shapes, explicit runtime validation at trust boundaries, narrow functions, and tests.

## Runtime Contract Pattern

- Validate CLI arguments before work begins.
- Validate parsed JSON is the expected object/array shape before mutation.
- Validate versioned operational data by schema version, registry digest, completeness, and failures.
- Convert numeric CLI/DOM strings explicitly and check `Number.isInteger` or `Number.isFinite` where required.
- Use optional chaining only for genuinely optional DOM/global state; do not use it to hide a required contract failure.

```js
// scripts/scan-pack-content.js
if (!registry || Array.isArray(registry)) {
  throw new Error(`Invalid or missing registry: ${args.registry}`);
}
if (!Number.isInteger(args.concurrency) || args.concurrency <= 0 || args.concurrency > 8) {
  throw new Error('--concurrency must be an integer from 1 to 8');
}
```

Versioned data fails closed:

```js
// scripts/upload-folder.js / scripts/lib/pack-content-index.js pattern
const contentIndex = validateContentIndex(
  readJson(contentIndexPath, null),
  registry,
  FINGERPRINT_SCHEMA_VERSION
);
```

## Browser Data

- Check `response.ok` for API operations where failure changes behavior.
- Wrap cache fallbacks in `try/catch` and provide a defined empty/default shape.
- Treat generated site JSON as an internal contract, but still default optional presentation fields (`pack.lists || []`, `coloredName || displayName`).
- DOM dataset values are strings; convert before numeric indexing.

## Node Modules

- Scripts use CommonJS (`require`, `module.exports`). Do not mix ESM into one file without changing its runtime contract and package configuration.
- Export pure helpers that need direct tests; keep command execution under `if (require.main === module)`.
- Use version constants for persisted schemas and SBI shards.

## Verification

- Run `node --check` on changed JavaScript files.
- Run `npm test` for ingestion/content-identity changes.
- Add tests that reject malformed, missing, stale, conflicting, and boundary values; success-only tests are not enough.
- There is no `tsc` command. Do not report a type-check as passed.

## Common Mistakes

- Do not assume JSON parsed successfully merely because the file exists.
- Do not compare numeric CLI inputs before converting them.
- Do not accept stale content indexes or fingerprint versions.
- Do not duplicate a payload shape across scripts without a shared validator/helper when the shape controls remote writes.
- Do not introduce TypeScript annotations into browser files that are served directly.
