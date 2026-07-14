# Hook Guidelines

## Overview

VALE does not use React or another hook-based framework. There are no `use*` hooks, hook dependency arrays, or component render cycles. Do not invent hook conventions for this codebase.

Stateful browser behavior is organized as lifecycle-bound functions or small classes.

## Lifecycle Pattern

Start page behavior after the document is ready, then make asynchronous dependencies explicit:

```js
// assets/js/main.js
document.addEventListener('DOMContentLoaded', async () => {
  const loader = new PackLoader();
  await loader.init();
  new PackSearch(loader);
});
```

For reusable page behavior, expose a narrowly named function or class rather than a pseudo-hook. `PackLoader`, `PackSearch`, `loadLists`, `loadListDetail`, and `resyncListsUI` are current examples.

## Data Fetching

- Use `async` functions and `fetch` directly.
- Check `response.ok` before consuming remote/API data.
- Static public data comes from site-relative JSON such as `/data/index.json` or `/l/lists.json`.
- Authenticated administration may read/write through the GitHub API.
- Where an existing feature defines a local cache fallback, preserve its order. `loadLists()` tries GitHub for authenticated users, then the public JSON, then `localStorage`.

```js
// assets/js/list.js
const res = await fetch('/l/lists.json?t=' + Date.now());
listsData = await res.json();
localStorage.setItem('vale_lists', JSON.stringify(listsData));
```

## Cleanup And Long-Lived Work

- Store interval/observer ownership in the class or feature that creates it when cleanup is needed.
- Do not add global polling when an existing event (`auth-change`, input, click, keydown) can drive the update.
- Serialize overlapping writes when order matters. List saves use a module-level `saveQueue` promise.

## Common Mistakes

- Do not add a `useSomething` function that implies React semantics.
- Do not fetch the same static JSON independently in every render branch; load once and pass/store the result.
- Do not swallow errors unless the current branch intentionally falls back to cache or optional UI.
- Do not add a frontend dependency solely to replace a small `DOMContentLoaded`/event-listener flow.
