# State Management

## Overview

There is no state-management library. State lives at the narrowest existing scope: function locals, a page behavior instance, a feature module, browser storage, URL/path state, or generated JSON.

## State Categories

| State | Current location | Examples |
| --- | --- | --- |
| Element interaction | Function/class instance | `PackSearch.searchInput`, current sort mode |
| Page feature state | Module-level variables | `listsData`, `allPacks`, `sortByDate` in `list.js` |
| Submitted query | Dedicated variable | `listSearchQuery`, separate from the input value |
| Public server state | Static JSON fetched at runtime | `/data/index.json`, `/l/lists.json` |
| Auth/admin cache | `localStorage` | auth token and `vale_lists` fallback |
| One-navigation handoff | `sessionStorage` | `listPath` from the 404 redirect flow |
| Route state | `window.location`, history, query parameters | List IDs and pack detail lookup |
| Durable catalog state | Repository JSON | registry, Lists, extracted data, SBI shards |

## Local And Derived State

- Keep raw input separate from committed render state when rendering is expensive.
- Derive filtered/sorted arrays from the source collection; do not mutate the source order for a view.
- Rerender from state after a save or auth change rather than patching unrelated DOM fragments independently.

```js
// assets/js/list.js
let listSearchQuery = '';

function submitListSearch() {
  listSearchQuery = searchInput.value;
  window.renderLists(listSearchQuery);
}

function resetListSearchWhenCleared() {
  if (searchInput.value.trim() !== '' || listSearchQuery === '') return;
  listSearchQuery = '';
  window.renderLists(listSearchQuery);
}
```

## Persistent And Remote State

- Treat repository JSON as the durable source of truth; browser storage is a cache or session aid.
- Update `localStorage` immediately only where the feature already provides offline/cache behavior.
- Serialize GitHub writes that can overlap:

```js
// assets/js/list.js
saveQueue = saveQueue
  .then(() => doSaveLists())
  .catch(() => doSaveLists());
```

- After a failed remote write, reload the authoritative remote data before allowing more edits.
- Do not put large fingerprint shards or internal pack-content indexes in browser storage.

## Events And Shared Globals

The site uses a few deliberate page globals such as `window.AUTH`, `window.renderLists`, and the `auth-change` event. Extend an existing global only when multiple separately loaded scripts on the same page require it; otherwise keep state lexical.

## Common Mistakes

- Do not treat DOM text as the authoritative state when a variable/JSON record already owns it.
- Do not rerender a large result set on every search keystroke.
- Do not use `localStorage` as the only copy of catalog/List data.
- Do not add a global store for state used by one page.
- Do not mutate generated JSON directly from browser code except through the existing authenticated GitHub administration workflow.
