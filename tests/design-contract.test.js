const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const css = () => fs.readFileSync(path.join(ROOT, 'assets', 'css', 'style.css'), 'utf-8');

function rootBlock(source) {
  const m = source.match(/:root \{([\s\S]*?)\n\}/);
  assert.ok(m, ':root block exists');
  return m[1];
}

test('design tokens are declared in :root', () => {
  const root = rootBlock(css());
  assert.match(root, /--surface: #dde7f1;/);
  assert.match(root, /--surface-deep: #b9cadd;/);
  assert.match(root, /--radius-action: 6px;/);
  assert.match(root, /--shadow-rest: 2px 2px 0 rgba\(0, ?0, ?0, ?\.15\);/);
  assert.match(root, /--shadow-lift: 4px 4px 0 rgba\(0, ?0, ?0, ?\.18\);/);
  assert.match(root, /--t-fast: 100ms;/);
  assert.match(root, /--t-base: 180ms;/);
});

test('surface hardcodes appear only as their token definitions', () => {
  const source = css();
  for (const hex of ['#dde7f1', '#b9cadd']) {
    const uses = source.split(hex).length - 1;
    assert.equal(uses, 1, `${hex} must appear exactly once (the token definition), found ${uses}`);
  }
});

function block(source, selector) {
  const start = source.indexOf(selector);
  assert.ok(start >= 0, `selector ${selector} exists`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

test('interactive controls carry the action radius', () => {
  const source = css();
  for (const selector of ['\n.btn {', '\n.search-btn {', '#search-input,', '\n.sort-btn {', '\n.tab-btn {', '\n.form-group input {']) {
    const body = block(source, selector);
    assert.match(body, /var\(--radius-action\)/, `${selector.trim()} uses --radius-action`);
    assert.doesNotMatch(body, /border-radius: 0;/, `${selector.trim()} must not override the radius back to 0`);
  }
});

test('no blurred box-shadow remains anywhere', () => {
  const source = css();
  for (const m of source.matchAll(/box-shadow:([^;]+);/g)) {
    for (const layer of m[1].split(/,(?![^(]*\))/)) {
      if (/var\(--shadow-(rest|lift)\)/.test(layer) || /\bnone\b/.test(layer)) continue;
      const cleaned = layer.replace(/\([^)]*\)/g, '').replace(/inset/g, '');
      const lengths = cleaned.match(/-?(?:\d+(?:\.\d+)?px|0)(?=\s|$)/g) || [];
      const blur = lengths[2];
      assert.ok(!blur || blur === '0px' || blur === '0', `blurred shadow found: box-shadow:${m[1].trim()}`);
    }
  }
});

test('pack card elevation uses the hard shadow pair', () => {
  const source = css();
  assert.match(block(source, '\n.pack-card {'), /box-shadow: var\(--shadow-rest\)/);
  assert.match(block(source, '.pack-card:hover {'), /box-shadow: var\(--shadow-lift\)/);
});

test('containers stay square: no radius on cards, header, thumbnails', () => {
  const source = css();
  for (const selector of ['\nheader {', '\n.pack-card {', '\n.main-card {', '\n.sub-card {', '\n.preview-card {', '.list-grid .list-item {', '.pack-card .cover {', '\n.sbi-upload {', '\n.sbi-tools-card {', '\n.sbi-crops,']) {
    assert.doesNotMatch(block(source, selector), /border-radius/, `${selector.trim()} must stay square`);
  }
});

test('SBI controls adopt the action radius', () => {
  const source = css();
  for (const selector of ['\n.sbi-preset-btn {', '\n.sbi-action-btn {', '\n.sbi-search-input {', '\n.sbi-mode-toggle {', '\n.sbi-ai-badge {']) {
    const body = block(source, selector);
    assert.match(body, /var\(--radius-action\)/, `${selector.trim()} uses --radius-action`);
    assert.doesNotMatch(body, /border-radius: 0;/, `${selector.trim()} must not override the radius back to 0`);
  }
});

test('SBI tools buttons separate with a gap instead of negative-margin border fusion', () => {
  const source = css();
  assert.doesNotMatch(source, /\.sbi-tools-actions[^{]*\{[^}]*-2px/, 'no -2px fusion in sbi-tools-actions rules');
  assert.match(block(source, '\n.sbi-tools-actions {'), /gap: 8px/);
});

test('global focus-visible outline is defined with the accent', () => {
  const source = css();
  const m = source.match(/:focus-visible[^{]*\{([^}]*)\}/);
  assert.ok(m, 'a :focus-visible rule exists');
  assert.match(m[1], /outline: 2px solid var\(--accent\)/);
  assert.match(m[1], /outline-offset: 2px/);
});

test('every page references the same style.css cache buster', () => {
  const versions = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.html')) {
        const m = fs.readFileSync(full, 'utf-8').match(/style\.css\?v=(\d+)/);
        if (m) versions.set(path.relative(ROOT, full), m[1]);
      }
    }
  };
  for (const top of ['index.html', 'pack.html']) {
    const m = fs.readFileSync(path.join(ROOT, top), 'utf-8').match(/style\.css\?v=(\d+)/);
    assert.ok(m, `${top} carries a style.css cache buster`);
    versions.set(top, m[1]);
  }
  for (const dir of ['admin', 'l', 'p', 'sbi']) walk(path.join(ROOT, dir));
  const unique = new Set(versions.values());
  assert.equal(unique.size, 1, `all pages must share one style.css version, found: ${[...unique].join(', ')}`);
});

test('modals carry the elevated card language with entrance motion', () => {
  const source = css();
  const content = block(source, '\n.modal-content {');
  assert.match(content, /border: 2px solid var\(--border\)/);
  assert.match(content, /box-shadow: var\(--shadow-lift\)/);
  assert.match(content, /animation: modal-in/);
  assert.match(source, /@keyframes modal-in/);
  const overlay = block(source, '\n.modal-overlay {');
  assert.match(overlay, /animation: fade-in/);
  const buttons = block(source, '\n.modal-buttons {');
  assert.match(buttons, /justify-content: flex-end/);
  assert.match(block(source, '.modal-buttons .btn {'), /margin: 0;/, 'modal buttons drop the default .btn margins');
});

test('UI font is HarmonyOS Sans with the system stack as fallback', () => {
  const source = css();
  assert.match(rootBlock(source), /--font-ui: 'HarmonyOS Sans', -apple-system/);
  const face = source.match(/@font-face \{[^}]*HarmonyOS Sans[^}]*\}/);
  assert.ok(face, '@font-face for HarmonyOS Sans exists');
  assert.match(face[0], /harmonyos-sans\.woff2/);
  assert.match(face[0], /font-weight: 100 900;/, 'variable weight range declared');
  assert.match(face[0], /font-display: swap;/);
});

test('admin/List reusable templates carry no inline style attributes', () => {
  for (const file of ['admin/index.html', 'l/index.html', 'assets/js/admin.js', 'assets/js/list.js', 'assets/js/list-detail.js', 'assets/js/pack-detail.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    for (const [i, line] of source.split('\n').entries()) {
      if (line.includes('keep-inline:')) continue;
      assert.doesNotMatch(line, /style="/, `${file}:${i + 1} has an inline style`);
    }
  }
});
