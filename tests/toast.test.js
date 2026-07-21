const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const TOAST_PATH = path.join(ROOT, 'assets', 'js', 'toast.js');

function makeEl(tag) {
  return {
    tag,
    id: '',
    className: '',
    textContent: '',
    children: [],
    parent: null,
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
  };
}

function findById(node, id) {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = findById(child, id);
    if (hit) return hit;
  }
  return null;
}

function loadToast() {
  const body = makeEl('body');
  global.window = {};
  global.document = {
    body,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => findById(body, id),
  };
  delete require.cache[require.resolve(TOAST_PATH)];
  require(TOAST_PATH);
  return { toast: global.window.toast, body };
}

test('toast renders a message into a fixed stack', () => {
  const { toast, body } = loadToast();
  toast('Deleted');
  const stack = findById(body, 'toast-stack');
  assert.ok(stack, 'stack container created on demand');
  assert.equal(stack.children.length, 1);
  assert.equal(stack.children[0].textContent, 'Deleted');
  assert.match(stack.children[0].className, /\btoast\b/);
});

test('toasts stack and auto-dismiss after their duration', async () => {
  const { toast, body } = loadToast();
  toast('first', { duration: 40 });
  toast('second', { duration: 40 });
  const stack = findById(body, 'toast-stack');
  assert.equal(stack.children.length, 2, 'toasts stack');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(stack.children.length, 0, 'toasts auto-dismiss');
});

test('error toasts carry the error class', () => {
  const { toast, body } = loadToast();
  toast('Delete failed', { type: 'error' });
  const stack = findById(body, 'toast-stack');
  assert.match(stack.children[0].className, /toast-error/);
});

test('no native alert() call sites remain in site scripts', () => {
  const dir = path.join(ROOT, 'assets', 'js');
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js') || file === 'transformers.min.js' || file === 'sbi_test.js') continue;
    const source = fs.readFileSync(path.join(dir, file), 'utf-8');
    for (const [index, line] of source.split('\n').entries()) {
      const stripped = line.replace(/\/\/.*$/, '');
      assert.doesNotMatch(stripped, /(?<![\w.])alert\(/, `${file}:${index + 1} still calls alert()`);
      assert.doesNotMatch(stripped, /(?<![\w.])confirm\(/, `${file}:${index + 1} still calls native confirm()`);
    }
  }
});

function findByClass(node, cls) {
  if ((node.className || '').split(' ').includes(cls)) return node;
  for (const child of node.children) {
    const hit = findByClass(child, cls);
    if (hit) return hit;
  }
  return null;
}

test('confirmDialog resolves true on confirm, false on cancel, danger styles the confirm button', async () => {
  const { body } = loadToast();
  const first = global.window.confirmDialog('Delete "X"?', { confirmText: 'DELETE', danger: true });
  const overlay = findByClass(body, 'modal-overlay');
  assert.ok(overlay, 'overlay mounted');
  assert.equal(findByClass(overlay, 'modal-message').textContent, 'Delete "X"?');
  const confirmBtn = findByClass(overlay, 'btn-danger');
  assert.ok(confirmBtn, 'danger option styles the confirm button');
  assert.equal(confirmBtn.textContent, 'DELETE');
  confirmBtn.onclick();
  assert.equal(await first, true);
  assert.ok(!findByClass(body, 'modal-overlay'), 'overlay removed after confirm');

  const second = global.window.confirmDialog('Run build?');
  const cancelBtn = findByClass(findByClass(body, 'modal-overlay'), 'btn-secondary');
  cancelBtn.onclick();
  assert.equal(await second, false);
});

test('toast styling uses the token language, bottom-right fixed', () => {
  const cssSource = fs.readFileSync(path.join(ROOT, 'assets', 'css', 'style.css'), 'utf-8');
  const stack = cssSource.match(/#toast-stack \{([^}]*)\}/);
  assert.ok(stack, '#toast-stack rule exists');
  assert.match(stack[1], /position: fixed/);
  assert.match(stack[1], /bottom:/);
  assert.match(stack[1], /right:/);
  const toastRule = cssSource.match(/\n\.toast \{([^}]*)\}/);
  assert.ok(toastRule, '.toast rule exists');
  assert.match(toastRule[1], /var\(--shadow-lift\)/);
  assert.match(toastRule[1], /border: 2px solid/);
});

test('pages whose scripts toast are loading toast.js first', () => {
  for (const page of ['pack.html', 'admin/index.html', 'l/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf-8');
    const toastAt = html.indexOf('assets/js/toast.js?v=');
    assert.ok(toastAt >= 0, `${page} loads toast.js with a cache buster`);
    for (const consumer of ['pack-detail.js', 'admin.js', 'list.js']) {
      const at = html.indexOf(consumer);
      if (at >= 0) assert.ok(toastAt < at, `${page}: toast.js loads before ${consumer}`);
    }
  }
});
