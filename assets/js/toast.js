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

  function confirmDialog(message, opts = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';

      const content = document.createElement('div');
      content.className = 'modal-content modal-confirm';

      const msg = document.createElement('p');
      msg.className = 'modal-message';
      msg.textContent = message;

      const buttons = document.createElement('div');
      buttons.className = 'modal-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary';
      cancelBtn.textContent = opts.cancelText || 'CANCEL';

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      confirmBtn.textContent = opts.confirmText || 'CONFIRM';

      const close = (result) => { overlay.remove(); resolve(result); };
      cancelBtn.onclick = () => close(false);
      confirmBtn.onclick = () => close(true);
      overlay.onclick = (e) => { if (e && e.target === overlay) close(false); };

      buttons.appendChild(cancelBtn);
      buttons.appendChild(confirmBtn);
      content.appendChild(msg);
      content.appendChild(buttons);
      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
  }

  window.confirmDialog = confirmDialog;
})();
