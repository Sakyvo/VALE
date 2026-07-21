(function () {
  const DEFAULT_DURATION = 3200;

  function ensureStack() {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function toast(message, opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (opts.type === 'error' ? ' toast-error' : '');
    el.textContent = message;
    ensureStack().appendChild(el);
    setTimeout(() => el.remove(), opts.duration || DEFAULT_DURATION);
    return el;
  }

  window.toast = toast;
})();
