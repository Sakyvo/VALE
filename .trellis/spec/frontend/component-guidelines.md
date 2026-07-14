# Component Guidelines

## Current Component Model

The project has no framework component or props system. A "component" is one of:

- static semantic HTML in a page shell;
- a DOM-rendering function using a template literal;
- a small behavior class bound after `DOMContentLoaded`;
- a shared CSS class in `assets/css/style.css`.

Keep new UI in that model unless the project deliberately adopts a framework in a separate task.

## DOM Construction

- Query stable page IDs/classes once near initialization.
- Bind behavior after `DOMContentLoaded`.
- Use optional chaining for controls that are legitimately absent from some shared page shells.
- Render repeated records with `map(...).join('')`, then attach behavior that cannot be expressed in markup.
- Keep submitted state separate from raw input when rendering a large result set.

Explore cards follow this pattern:

```js
// assets/js/main.js
return `
  <a class="pack-card" href="/p/${pack.name}/"
     target="_blank" rel="noopener noreferrer">
    <img class="cover" src="${pack.cover}" alt="${pack.displayName}">
    <div class="info">
      <img class="pack-icon" src="${pack.packPng}" alt="">
      <div class="name">${pack.coloredName || pack.displayName}</div>
    </div>
  </a>`;
```

## Page Initialization

Prefer a small initializer that makes data dependencies explicit:

```js
// assets/js/main.js
document.addEventListener('DOMContentLoaded', async () => {
  const loader = new PackLoader();
  await loader.init();
  new PackSearch(loader);
});
```

Do not rely on bundler import order. HTML script order is the dependency graph, and shared globals such as `AUTH` or `PackLoader` must be loaded first.

## Styling

- Reuse variables from `:root` in `assets/css/style.css`: `--bg`, `--text`, `--border`, `--accent`, `--font-ui`, and `--font-mc`.
- Match the existing flat, high-contrast language: mostly 2px borders, restrained radii, shared header height, and pixel font only for pack/List names.
- Add responsive rules beside the feature's existing CSS. Current breakpoints are primarily 1200px, 900px, 700px, and 600px.
- Give grids, previews, cards, and icon controls stable dimensions so loading or hover state does not shift layout.
- Avoid inline styles in new reusable UI even though older admin/List markup still contains some.

## Accessibility And Navigation

- Icon-only navigation controls carry both `title` and `aria-label`, as in `index.html` and `sbi/index.html`.
- Images that communicate pack identity use meaningful `alt`; decorative pack icons may use `alt=""`.
- Use native `button`, `input`, `label`, `details`, and `summary` elements before adding custom roles.
- Main/List result links open pack detail in a new tab with both `target="_blank"` and `rel="noopener noreferrer"`.
- Use the native `hidden` attribute for conditional sections when the existing feature does so.

## Common Mistakes

- Do not create a framework-style component abstraction for one template.
- Do not bind listeners before the relevant DOM exists.
- Do not let typing in a homepage/List search rebuild the full result grid; submit on button/Enter, but reset immediately when the field becomes empty.
- Do not introduce a page-specific visual language that conflicts with `style.css`.
- Do not interpolate untrusted external HTML without sanitization. Existing colored pack names are generated project data, not arbitrary runtime input.
