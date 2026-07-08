const NAV_ICONS = {
  admin: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  login: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>',
  logout: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>'
};

const AUTH = {
  REPO_OWNER: 'Sakyvo',
  REPO_NAME: 'VALE',
  ADMIN_USER: 'Sakyvo',

  isLoggedIn() {
    return localStorage.getItem('auth_token') && localStorage.getItem('auth_user') === this.ADMIN_USER;
  },

  getToken() {
    return localStorage.getItem('auth_token') || '';
  },

  async login(username, token) {
    if (username !== this.ADMIN_USER) return { ok: false, error: 'Invalid username' };

    try {
      const res = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${token}` }
      });
      if (!res.ok) return { ok: false, error: 'Invalid token' };

      const user = await res.json();
      if (user.login !== this.ADMIN_USER) return { ok: false, error: 'Token does not match user' };

      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', username);
      window.dispatchEvent(new Event('auth-change'));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  logout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('auth_user');
    window.dispatchEvent(new Event('auth-change'));
  },

  showLoginModal() {
    if (document.getElementById('login-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'login-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content">
        <h2>LOGIN</h2>
        <div id="login-error" class="login-error"></div>
        <div class="form-group">
          <label>USERNAME</label>
          <input type="text" id="login-username" value="Sakyvo">
        </div>
        <div class="form-group">
          <label>GITHUB TOKEN</label>
          <input type="password" id="login-token" placeholder="ghp_...">
        </div>
        <div class="modal-buttons">
          <button class="btn btn-primary" id="login-submit">LOGIN</button>
          <button class="btn btn-secondary" id="login-cancel">CANCEL</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('login-cancel').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

    document.getElementById('login-submit').onclick = async () => {
      const username = document.getElementById('login-username').value;
      const token = document.getElementById('login-token').value;
      const errorEl = document.getElementById('login-error');

      if (!token) {
        errorEl.textContent = 'Please enter token';
        return;
      }

      errorEl.textContent = 'Verifying...';
      const result = await AUTH.login(username, token);

      if (result.ok) {
        modal.remove();
        if (!window.location.pathname.startsWith('/admin')) {
          window.location.href = '/admin/';
        }
      } else {
        errorEl.textContent = result.error;
      }
    };
  },

  updateNav() {
    const nav = document.querySelector('nav');
    if (!nav) return;

    const authBtn = nav.querySelector('.auth-btn') || document.createElement('a');
    authBtn.className = 'nav-btn auth-btn nav-icon-btn';

    const isAdminPage = window.location.pathname.startsWith('/admin');

    if (this.isLoggedIn()) {
      if (isAdminPage) {
        authBtn.innerHTML = NAV_ICONS.logout;
        authBtn.title = 'Logout';
        authBtn.setAttribute('aria-label', 'Logout');
        authBtn.href = '#';
        authBtn.onclick = (e) => { e.preventDefault(); this.showLogoutConfirm(); };
      } else {
        authBtn.innerHTML = NAV_ICONS.admin;
        authBtn.title = 'Admin';
        authBtn.setAttribute('aria-label', 'Admin');
        authBtn.href = '/admin/';
        authBtn.onclick = null;
      }
    } else {
      authBtn.innerHTML = NAV_ICONS.login;
      authBtn.title = 'Login';
      authBtn.setAttribute('aria-label', 'Login');
      authBtn.href = '#';
      authBtn.onclick = (e) => { e.preventDefault(); this.showLoginModal(); };
    }

    if (!nav.querySelector('.auth-btn')) {
      nav.appendChild(authBtn);
    }
  },

  showLogoutConfirm() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:350px;text-align:center;">
        <p style="margin-bottom:24px;">Confirm logout?</p>
        <div class="modal-buttons">
          <button class="btn btn-primary" id="logout-yes">CONFIRM</button>
          <button class="btn btn-secondary" id="logout-no">CANCEL</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#logout-yes').onclick = () => { modal.remove(); this.logout(); };
    modal.querySelector('#logout-no').onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  }
};

window.AUTH = AUTH;
window.addEventListener('auth-change', () => AUTH.updateNav());
document.addEventListener('DOMContentLoaded', () => AUTH.updateNav());


// Maintenance mode check
(function() {
  var loggedIn = AUTH.isLoggedIn();

  fetch('https://raw.githubusercontent.com/' + AUTH.REPO_OWNER + '/' + AUTH.REPO_NAME + '/main/data/maintenance.json?t=' + Date.now())
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data || !data.enabled) return;
      if (loggedIn) {
        var badge = document.createElement('span');
        badge.className = 'nav-status maintenance-badge';
        badge.textContent = 'IN MAINTENANCE';
        var nav = document.querySelector('nav');
        if (nav) {
          var historyBtn = nav.querySelector('.history-btn');
          var authBtn = nav.querySelector('.auth-btn');
          if (historyBtn) nav.insertBefore(badge, historyBtn);
          else if (authBtn) nav.insertBefore(badge, authBtn);
          else nav.appendChild(badge);
        } else {
          document.body.appendChild(badge);
        }
        return;
      }
      if (window.location.pathname.startsWith('/admin')) return;
      document.documentElement.innerHTML = '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VALE - Maintenance</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#ccc;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}.maintenance{text-align:center;border:2px solid #444;padding:60px 48px;max-width:460px}.maintenance h1{font-size:28px;letter-spacing:6px;margin-bottom:16px;color:#fff}.maintenance p{font-size:14px;color:#888;line-height:1.6}.maintenance .line{width:40px;height:2px;background:#444;margin:20px auto}</style></head><body><div class="maintenance"><h1>VALE</h1><div class="line"></div><p>Service in Maintenance</p></div></body>';
    })
    .catch(function() {});
})();
