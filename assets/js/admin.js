const REPO_OWNER = 'Sakyvo';
const REPO_NAME = 'VALE';
const ARCHIVE_MUTATIONS_DISABLED = true;

class Admin {
  constructor() {
    this.loginRequired = document.getElementById('login-required');
    this.adminSection = document.getElementById('admin-section');
    this.messageEl = document.getElementById('message');
    this.packs = [];
    this.selected = new Set();
    this.multiSelectMode = false;
    this.sortByDate = false;
    this.listSortByDate = false;
    this.checkedLists = new Set();

    document.getElementById('show-login-btn')?.addEventListener('click', () => AUTH.showLoginModal());
    document.getElementById('pack-search')?.addEventListener('input', (e) => this.renderPacks(e.target.value));
    document.getElementById('admin-sort-btn')?.addEventListener('click', () => this.toggleSort());
    document.getElementById('create-list-btn')?.addEventListener('click', () => this.createList());
    document.getElementById('list-search')?.addEventListener('input', (e) => this.renderLists(e.target.value));
    document.getElementById('list-sort-btn')?.addEventListener('click', () => this.toggleListSort());
    document.getElementById('manual-build-btn')?.addEventListener('click', () => this.manualBuild());
    document.getElementById('maintenance-btn')?.addEventListener('click', () => this.toggleMaintenance());

    window.addEventListener('auth-change', () => this.checkAuth());
    this.checkAuth();
  }

  loadLists() {
    this.renderLists('');
  }

  renderLists(query = '') {
    const lists = JSON.parse(localStorage.getItem('vale_lists') || '[]');
    const container = document.getElementById('list-checkboxes');

    let filtered = lists.filter(l => l.name.toLowerCase().includes(query.toLowerCase()));

    if (this.listSortByDate) {
      filtered = [...filtered].reverse();
    } else {
      filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-note">No lists found</div>';
      return;
    }
    container.innerHTML = filtered.map(l => `
      <label class="admin-list-item">
        <span class="admin-list-name">${l.name}</span>
        <input type="checkbox" class="list-checkbox admin-list-checkbox" value="${l.name}" ${this.checkedLists.has(l.name) ? 'checked' : ''}>
      </label>
    `).join('');

    container.querySelectorAll('.list-checkbox').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) this.checkedLists.add(cb.value);
        else this.checkedLists.delete(cb.value);
      };
    });
  }

  toggleListSort() {
    this.listSortByDate = !this.listSortByDate;
    document.getElementById('list-sort-btn').textContent = this.listSortByDate ? 'DATE' : 'A-Z';
    this.renderLists(document.getElementById('list-search').value);
  }

  createList() {
    const name = prompt('Enter new list name:');
    if (!name?.trim()) return;
    const lists = JSON.parse(localStorage.getItem('vale_lists') || '[]');
    if (lists.find(l => l.name === name.trim())) {
      toast('List already exists', { type: 'error' });
      return;
    }
    lists.push({ name: name.trim(), cover: '', description: '', packs: [] });
    localStorage.setItem('vale_lists', JSON.stringify(lists));
    // 自动勾选新创建的列表
    this.checkedLists.add(name.trim());
    this.renderLists(document.getElementById('list-search').value);
  }

  toggleSort() {
    this.sortByDate = !this.sortByDate;
    document.getElementById('admin-sort-btn').textContent = this.sortByDate ? 'DATE' : 'A-Z';
    this.renderPacks(document.getElementById('pack-search').value);
  }

  checkAuth() {
    if (AUTH.isLoggedIn()) {
      this.loginRequired.style.display = 'none';
      this.adminSection.style.display = 'block';
      this.loadLists();
      this.loadPacks();
      this.loadMaintenanceState();
    } else {
      this.loginRequired.style.display = 'block';
      this.adminSection.style.display = 'none';
    }
  }

  showMessage(text, type) {
    this.messageEl.className = `message ${type}`;
    this.messageEl.textContent = text;
    this.messageEl.style.display = 'block';
  }

  async loadPacks() {
    try {
      const index = await fetch('/data/index.json?t=' + Date.now()).then(r => r.json());
      this.packs = index.items;
      this.renderPacks();
    } catch (e) {
      document.getElementById('pack-list').innerHTML = 'Failed to load packs';
    }
  }

  renderPacks(query = '') {
    const listEl = document.getElementById('pack-list');
    let filtered = this.packs.filter(p =>
      p.displayName.toLowerCase().includes(query.toLowerCase()) ||
      p.name.toLowerCase().includes(query.toLowerCase())
    );

    if (this.sortByDate) {
      filtered = [...filtered].reverse();
    } else {
      filtered = [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    listEl.innerHTML = filtered.map(p => `
      <div class="admin-pack-item" data-name="${p.name}">
        <div class="admin-pack-row1">
          <img class="admin-pack-icon" data-src="${p.packPng}" data-name="${p.name}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
          <a href="/p/${p.name}/" class="admin-pack-name">${p.displayName}</a>
        </div>
        <div class="admin-pack-row2">
          <img class="admin-texture" data-src="/thumbnails/${p.name}/diamond_sword.png" onerror="this.style.display='none'" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
          <img class="admin-texture" data-src="/thumbnails/${p.name}/ender_pearl.png" onerror="this.style.display='none'" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
        </div>
      </div>
    `).join('') || '<p>No packs found</p>';

    // Lazy load images with IntersectionObserver
    if (!this._packObserver) {
      this._packObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const item = entry.target;
          item.querySelectorAll('img[data-src]').forEach(img => {
            img.src = img.dataset.src;
            delete img.dataset.src;
          });
          this._packObserver.unobserve(item);
        });
      }, { root: document.getElementById('pack-list'), rootMargin: '100px' });
    }
    listEl.querySelectorAll('.admin-pack-item').forEach(item => this._packObserver.observe(item));

    // Animated texture handling for admin textures
    listEl.querySelectorAll('.admin-texture').forEach(img => {
      img.onload = function() {
        if (this.src.endsWith('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')) return;
        if (this.naturalHeight > this.naturalWidth) {
          const frames = this.naturalHeight / this.naturalWidth;
          if (Number.isInteger(frames) && frames > 1) {
            const wrapper = document.createElement('div');
            wrapper.className = 'admin-texture animated-admin-texture';
            wrapper.style.backgroundImage = `url(${this.src})`;
            wrapper.style.backgroundSize = `100% ${frames * 100}%`;
            let currentFrame = 0;
            setInterval(() => {
              currentFrame = (currentFrame + 1) % frames;
              wrapper.style.backgroundPosition = `0 ${(currentFrame / (frames - 1)) * 100}%`;
            }, 100);
            this.replaceWith(wrapper);
            return;
          }
        }
        this.style.visibility = 'visible';
      };
    });

  }

  toggleSelect(name) {
    if (this.selected.has(name)) {
      this.selected.delete(name);
    } else {
      this.selected.add(name);
    }
    this.multiSelectMode = this.selected.size > 0;
    this.renderPacks(document.getElementById('pack-search').value);
  }

  updateBatchBtn() {
    const btn = document.getElementById('batch-delete-btn');
    if (this.multiSelectMode) {
      btn.className = 'btn btn-danger';
      btn.textContent = `DELETE (${this.selected.size})`;
    } else {
      btn.className = 'btn btn-secondary';
      btn.textContent = 'BATCH DELETE';
    }
  }

  async batchDelete() {
    if (ARCHIVE_MUTATIONS_DISABLED) {
      this.showMessage('Archive changes require normalized ingestion', 'error');
      return;
    }
    if (this.selected.size === 0) return;
    if (!await confirmDialog(`Delete ${this.selected.size} packs?`, { confirmText: 'DELETE', danger: true })) return;

    const token = AUTH.getToken();
    if (!token) { this.showMessage('Please login first', 'error'); return; }

    this.showMessage('Deleting...', 'success');
    const names = [...this.selected];

    try {
      const refRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/main`, {
        headers: { Authorization: `token ${token}` }
      });
      if (!refRes.ok) throw new Error('Failed to get branch ref');
      const latestCommitSha = (await refRes.json()).object.sha;

      const commitRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/commits/${latestCommitSha}`, {
        headers: { Authorization: `token ${token}` }
      });
      if (!commitRes.ok) throw new Error('Failed to get commit');
      const baseTreeSha = (await commitRes.json()).tree.sha;

      const treeItems = [];
      for (const name of names) {
        const pack = this.packs.find(p => p.name === name);
        if (!pack) continue;
        treeItems.push({ path: `resourcepacks/${pack.id}.zip`, mode: '100644', type: 'blob', sha: null });
      }

      if (treeItems.length === 0) {
        this.showMessage('No packs to delete', 'error');
        return;
      }

      const treeRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
      });
      if (!treeRes.ok) throw new Error('Failed to create tree');
      const treeData = await treeRes.json();

      const newCommitRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/commits`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Delete ${treeItems.length} pack(s)`, tree: treeData.sha, parents: [latestCommitSha] })
      });
      if (!newCommitRes.ok) throw new Error('Failed to create commit');
      const newCommit = await newCommitRes.json();

      const updateRefRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/main`, {
        method: 'PATCH',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.sha })
      });
      if (!updateRefRes.ok) throw new Error('Failed to update branch');

      this.selected.clear();
      this.multiSelectMode = false;
      this.showMessage(`Deleted ${treeItems.length} pack(s). Build triggered.`, 'success');
      this.loadPacks();
      await this.trackBuildProgress(token);
    } catch (e) {
      this.selected.clear();
      this.multiSelectMode = false;
      this.showMessage(`Delete error: ${e.message}`, 'error');
      this.loadPacks();
    }
  }

  async upload() {
    if (ARCHIVE_MUTATIONS_DISABLED) {
      this.showMessage('Archive changes require normalized ingestion', 'error');
      return;
    }
    const token = AUTH.getToken();
    const fileInput = document.getElementById('file-input');
    const files = Array.from(fileInput.files);
    const selectedLists = [...this.checkedLists];

    if (files.length === 0) {
      this.showMessage('Please select files', 'error');
      return;
    }

    if (!token) {
      this.showMessage('Please login first', 'error');
      return;
    }

    this.showMessage('Validating files...', 'success');

    // Load existing pack names for duplicate detection
    const existingNames = new Map();
    try {
      const idx = await fetch('/data/index.json?t=' + Date.now()).then(r => r.json());
      idx.items.forEach(p => existingNames.set(p.name.toLowerCase(), p.name));
    } catch(e) {}

    const valid = [];
    const invalidFiles = [];
    const duplicateFiles = [];
    const duplicatePackNames = [];
    const warnFiles = [];

    for (const file of files) {
      if (!file.name.endsWith('.zip')) {
        invalidFiles.push(file.name);
        continue;
      }
      if (file.size < 35 * 1024 * 1024) {
        try {
          const zip = await JSZip.loadAsync(file);
          const hasAssets = Object.keys(zip.files).some(f => f.startsWith('assets/'));
          const hasMcmeta = !!zip.file('pack.mcmeta');
          if (!hasAssets || !hasMcmeta) {
            warnFiles.push(file.name);
          }
        } catch (e) {
          warnFiles.push(file.name);
        }
      } else {
        warnFiles.push(file.name);
      }
      const sanitized = this.sanitizeName(file.name.replace('.zip', '')).toLowerCase();
      if (existingNames.has(sanitized)) {
        duplicateFiles.push(file.name);
        duplicatePackNames.push(existingNames.get(sanitized));
        continue;
      }
      valid.push(file);
    }

    // If nothing to upload, still add duplicates to lists if selected
    if (valid.length === 0) {
      if (selectedLists.length > 0 && duplicatePackNames.length > 0) {
        await this.addPacksToLists(duplicatePackNames, selectedLists, token);
      }
      this.showUploadResult([], invalidFiles, duplicateFiles, warnFiles, null);
      return;
    }

    this.showMessage('Uploading...', 'success');

    try {
      const refRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/ref/heads/main`, {
        headers: { Authorization: `token ${token}` }
      });
      if (!refRes.ok) throw new Error('Failed to get branch ref');
      const latestCommitSha = (await refRes.json()).object.sha;

      const commitRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/commits/${latestCommitSha}`, {
        headers: { Authorization: `token ${token}` }
      });
      if (!commitRes.ok) throw new Error('Failed to get commit');
      const baseTreeSha = (await commitRes.json()).tree.sha;

      const uploadedNames = [];
      const successFiles = [];
      const uploadFailedFiles = [];
      const treeItems = [];

      for (let i = 0; i < valid.length; i++) {
        const file = valid[i];
        this.showMessage(`Uploading ${i + 1}/${valid.length}: ${file.name}...`, 'success');
        try {
          const content = await this.fileToBase64(file);
          const blobRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`, {
            method: 'POST',
            headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, encoding: 'base64' })
          });
          if (!blobRes.ok) { uploadFailedFiles.push(file.name); continue; }
          const blob = await blobRes.json();
          treeItems.push({ path: `resourcepacks/${file.name}`, mode: '100644', type: 'blob', sha: blob.sha });
          uploadedNames.push(this.sanitizeName(file.name.replace('.zip', '')));
          successFiles.push(file.name);
        } catch (e) { uploadFailedFiles.push(file.name); continue; }
      }

      if (treeItems.length === 0) {
        this.showUploadResult([], invalidFiles, duplicateFiles, warnFiles, uploadFailedFiles, null);
        return;
      }

      // Include lists.json update in the same commit
      const allPackNames = [...uploadedNames, ...duplicatePackNames];
      if (selectedLists.length > 0 && allPackNames.length > 0) {
        const lists = JSON.parse(localStorage.getItem('vale_lists') || '[]');
        selectedLists.forEach(listName => {
          const list = lists.find(l => l.name === listName);
          if (list) {
            allPackNames.forEach(name => {
              if (!list.packs.includes(name)) list.packs.push(name);
            });
          }
        });
        localStorage.setItem('vale_lists', JSON.stringify(lists));
        try {
          const listsBlobRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/blobs`, {
            method: 'POST',
            headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: JSON.stringify(lists, null, 2), encoding: 'utf-8' })
          });
          if (listsBlobRes.ok) {
            const listsBlob = await listsBlobRes.json();
            treeItems.push({ path: 'l/lists.json', mode: '100644', type: 'blob', sha: listsBlob.sha });
          }
        } catch (e) {}
      }

      this.showMessage('Creating commit...', 'success');
      const treeRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
      });
      if (!treeRes.ok) throw new Error('Failed to create tree');
      const treeData = await treeRes.json();

      const newCommitRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/commits`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Add ${uploadedNames.length} pack(s)`, tree: treeData.sha, parents: [latestCommitSha] })
      });
      if (!newCommitRes.ok) throw new Error('Failed to create commit');
      const newCommit = await newCommitRes.json();

      const updateRefRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/refs/heads/main`, {
        method: 'PATCH',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: newCommit.sha })
      });
      if (!updateRefRes.ok) throw new Error('Failed to update branch');

      fileInput.value = '';
      this.showUploadResult(successFiles, invalidFiles, duplicateFiles, warnFiles, uploadFailedFiles, token);
    } catch (e) {
      this.showMessage(`Upload error: ${e.message}`, 'error');
    }
  }

  async addPacksToLists(packNames, listNames, token) {
    const lists = JSON.parse(localStorage.getItem('vale_lists') || '[]');
    let changed = false;
    listNames.forEach(listName => {
      const list = lists.find(l => l.name === listName);
      if (list) {
        packNames.forEach(name => {
          if (!list.packs.includes(name)) { list.packs.push(name); changed = true; }
        });
      }
    });
    if (!changed) return;
    localStorage.setItem('vale_lists', JSON.stringify(lists));
    if (!token) return;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(lists, null, 2))));
    let sha;
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/l/lists.json`, {
        headers: { Authorization: `token ${token}` }
      });
      if (res.ok) sha = (await res.json()).sha;
    } catch (e) {}
    await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/l/lists.json`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Add existing packs to lists', content, sha })
    });
  }

  sanitizeName(name) {
    return name.replace(/^.*?[!#]+\s*(?=[0-9a-zA-Z\u4e00-\u9fff_])/, '').replace(/_([0-9a-fk-or])/gi, '§$1').replace(/§[0-9a-fk-or]/gi, '').replace(/[!@#$%^&*()+=\[\]{}|\\:;"'<>,?\/~`§]/g, '').replace(/^[^0-9a-zA-Z\u4e00-\u9fff]+/, '').trim().replace(/\s+/g, '_');
  }

  showUploadResult(successFiles, invalidFiles, duplicateFiles, warnFiles, oversizedFiles, token) {
    const sorted = (arr) => [...arr].sort((a, b) => a.localeCompare(b));
    // Split warnFiles into uploaded (in successFiles) and not uploaded
    const warnUploaded = warnFiles.filter(f => successFiles.includes(f));
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content modal-wide">
        <h2>Upload Result</h2>
        <div id="upload-result-list" class="modal-scroll-lg">
          ${successFiles.length > 0 ? `
            <p class="upload-group-title upload-ok">Uploaded (${successFiles.length})</p>
            <div class="upload-group">
              ${sorted(successFiles).map(f => `<p class="upload-file">${f}</p>`).join('')}
            </div>
          ` : ''}
          ${warnUploaded.length > 0 ? `
            <p class="upload-group-title upload-warn">Warning - Unverified (${warnUploaded.length})</p>
            <div class="upload-group upload-group--warn">
              ${sorted(warnUploaded).map(f => `<p class="upload-file">${f}</p>`).join('')}
              <p class="field-note">Could not validate client-side; will be verified during build</p>
            </div>
          ` : ''}
          ${oversizedFiles.length > 0 ? `
            <p class="upload-group-title upload-fail">Failed - Too Large for API (${oversizedFiles.length})</p>
            <div class="upload-group">
              ${sorted(oversizedFiles).map(f => `<p class="upload-file">${f}</p>`).join('')}
              <p class="field-note">Files >40MB must be uploaded via local git push</p>
            </div>
          ` : ''}
          ${invalidFiles.length > 0 ? `
            <p class="upload-group-title upload-fail">Failed - Invalid (${invalidFiles.length})</p>
            <div class="upload-group">
              ${sorted(invalidFiles).map(f => `<p class="upload-file">${f}</p>`).join('')}
            </div>
          ` : ''}
          ${duplicateFiles.length > 0 ? `
            <p class="upload-group-title upload-dup">Failed - Duplicate (${duplicateFiles.length})</p>
            <div class="upload-group">
              ${sorted(duplicateFiles).map(f => `<p class="upload-file">${f}</p>`).join('')}
            </div>
          ` : ''}
        </div>
        <div id="build-section"></div>
        <div class="modal-buttons" id="result-buttons">
          ${successFiles.length === 0 ? '<button class="btn btn-secondary" id="close-result">OK</button>' : ''}
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    if (successFiles.length === 0) {
      modal.querySelector('#close-result').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      return;
    }

    // Auto-start build tracking
    if (token) {
      this.trackBuildInModal(token, modal);
    }
  }

  async trackBuildInModal(token, modal) {
    const buildSection = modal.querySelector('#build-section');
    const buttonsDiv = modal.querySelector('#result-buttons');

    buildSection.innerHTML = `
      <div class="admin-actions">
        <p id="modal-build-status" class="upload-group">Waiting for build...</p>
        <div class="progress-track"><div id="modal-build-bar" class="progress-bar"></div></div>
        <p id="modal-build-time" class="field-note"></p>
      </div>
    `;

    const statusEl = buildSection.querySelector('#modal-build-status');
    const barEl = buildSection.querySelector('#modal-build-bar');
    const timeEl = buildSection.querySelector('#modal-build-time');
    const startTime = Date.now();
    const timer = setInterval(() => { timeEl.textContent = `${Math.floor((Date.now() - startTime) / 1000)}s`; }, 1000);

    try {
      barEl.style.width = '20%';
      await new Promise(r => setTimeout(r, 3000));

      let runId = null;
      for (let i = 0; i < 10; i++) {
        const runsRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/build.yml/runs?per_page=1`, {
          headers: { Authorization: `token ${token}` }
        });
        const runs = await runsRes.json();
        if (runs.workflow_runs?.[0]?.status !== 'completed') {
          runId = runs.workflow_runs?.[0]?.id;
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!runId) {
        clearInterval(timer);
        statusEl.textContent = 'Build may have completed quickly';
        barEl.style.width = '100%';
        buttonsDiv.innerHTML = '<button class="btn btn-primary" id="refresh-page-btn">REFRESH PAGE</button>';
        buttonsDiv.querySelector('#refresh-page-btn').onclick = () => location.reload();
        return;
      }

      statusEl.textContent = 'Building...';
      barEl.style.width = '40%';

      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const runRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}`, {
          headers: { Authorization: `token ${token}` }
        });
        const run = await runRes.json();
        barEl.style.width = `${Math.min(40 + i * 2, 90)}%`;

        if (run.status === 'completed') {
          clearInterval(timer);
          if (run.conclusion === 'success') {
            statusEl.textContent = 'Build complete!';
            barEl.style.width = '100%';
          } else {
            statusEl.textContent = `Build failed: ${run.conclusion}`;
            barEl.style.background = '#c00';
            barEl.style.width = '100%';
          }
          buttonsDiv.innerHTML = '<button class="btn btn-primary" id="refresh-page-btn">REFRESH PAGE</button>';
          buttonsDiv.querySelector('#refresh-page-btn').onclick = () => location.reload();
          return;
        }
      }

      clearInterval(timer);
      statusEl.textContent = 'Build timed out. Check GitHub Actions.';
      buttonsDiv.innerHTML = '<button class="btn btn-primary" id="refresh-page-btn">REFRESH PAGE</button>';
      buttonsDiv.querySelector('#refresh-page-btn').onclick = () => location.reload();
    } catch (e) {
      clearInterval(timer);
      statusEl.textContent = `Error: ${e.message}`;
      buttonsDiv.innerHTML = '<button class="btn btn-primary" id="refresh-page-btn">REFRESH PAGE</button>';
      buttonsDiv.querySelector('#refresh-page-btn').onclick = () => location.reload();
    }
  }

  async deletePack(name) {
    if (ARCHIVE_MUTATIONS_DISABLED) {
      this.showMessage('Archive changes require normalized ingestion', 'error');
      return;
    }
    const pack = this.packs.find(p => p.name === name);
    if (!pack) return;
    if (!await confirmDialog(`Delete "${pack.displayName}"?`, { confirmText: 'DELETE', danger: true })) return;

    const token = AUTH.getToken();
    if (!token) { this.showMessage('Please login first', 'error'); return; }

    try {
      const path = `resourcepacks/${pack.id}.zip`;
      const fileRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
        headers: { Authorization: `token ${token}` }
      });
      if (!fileRes.ok) { this.showMessage('File not found', 'error'); return; }

      const fileData = await fileRes.json();
      const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`, {
        method: 'DELETE',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Delete ${pack.id}`, sha: fileData.sha })
      });

      if (res.ok) {
        this.showMessage('Deleted! Build triggered.', 'success');
        this.loadPacks();
        await this.trackBuildProgress(token);
      } else {
        const err = await res.json();
        this.showMessage(`Delete failed: ${err.message}`, 'error');
      }
    } catch (e) {
      this.showMessage(`Error: ${e.message}`, 'error');
    }
  }

  async trackBuildProgress(token) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content modal-center">
        <h2 class="panel-heading">BUILD</h2>
        <p id="build-status" class="upload-group">Waiting for build...</p>
        <div class="progress-track progress-track-lg"><div id="build-bar" class="progress-bar"></div></div>
        <p id="build-time" class="field-note"></p>
      </div>
    `;
    document.body.appendChild(modal);

    const statusEl = modal.querySelector('#build-status');
    const barEl = modal.querySelector('#build-bar');
    const timeEl = modal.querySelector('#build-time');
    const startTime = Date.now();
    const updateTime = () => { timeEl.textContent = `${Math.floor((Date.now() - startTime) / 1000)}s`; };
    const timer = setInterval(updateTime, 1000);

    try {
      barEl.style.width = '20%';
      await new Promise(r => setTimeout(r, 3000));

      let runId = null;
      for (let i = 0; i < 10; i++) {
        const runsRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/build.yml/runs?per_page=1`, {
          headers: { Authorization: `token ${token}` }
        });
        const runs = await runsRes.json();
        if (runs.workflow_runs?.[0]?.status !== 'completed') {
          runId = runs.workflow_runs?.[0]?.id;
          break;
        }
        await new Promise(r => setTimeout(r, 2000));
      }

      if (!runId) {
        clearInterval(timer);
        statusEl.textContent = 'Build may have completed quickly';
        barEl.style.width = '100%';
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'btn btn-primary';
        refreshBtn.textContent = 'REFRESH PAGE';
        refreshBtn.style.marginTop = '16px';
        refreshBtn.onclick = () => location.reload();
        modal.querySelector('.modal-content').appendChild(refreshBtn);
        return;
      }

      statusEl.textContent = 'Building...';
      barEl.style.width = '40%';

      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const runRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/runs/${runId}`, {
          headers: { Authorization: `token ${token}` }
        });
        const run = await runRes.json();
        const progress = Math.min(40 + i * 2, 90);
        barEl.style.width = `${progress}%`;

        if (run.status === 'completed') {
          clearInterval(timer);
          if (run.conclusion === 'success') {
            statusEl.textContent = 'Build complete!';
            barEl.style.width = '100%';
            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'btn btn-primary';
            refreshBtn.textContent = 'REFRESH PAGE';
            refreshBtn.style.marginTop = '16px';
            refreshBtn.onclick = () => location.reload();
            modal.querySelector('.modal-content').appendChild(refreshBtn);
          } else {
            statusEl.textContent = `Build failed: ${run.conclusion}`;
            barEl.style.background = '#c00';
            barEl.style.width = '100%';
            setTimeout(() => modal.remove(), 3000);
          }
          return;
        }
      }

      clearInterval(timer);
      statusEl.textContent = 'Build timed out. Check GitHub Actions.';
      setTimeout(() => modal.remove(), 3000);
    } catch (e) {
      clearInterval(timer);
      statusEl.textContent = `Error: ${e.message}`;
      setTimeout(() => modal.remove(), 3000);
    }
  }

  async manualBuild() {
    const token = AUTH.getToken();
    if (!token) { this.showMessage('Please login first', 'error'); return; }
    if (!await confirmDialog('Run build to refresh packs?')) return;

    try {
      const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/build.yml/dispatches`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main' })
      });
      if (!res.ok && res.status !== 204) {
        this.showMessage('Failed to start build', 'error');
        return;
      }
    } catch (e) {
      this.showMessage(`Error: ${e.message}`, 'error');
      return;
    }

    await this.trackBuildProgress(token);
  }

  async loadMaintenanceState() {
    const btn = document.getElementById('maintenance-btn');
    if (!btn) return;
    try {
      const data = await fetch('/data/maintenance.json?t=' + Date.now()).then(r => r.json());
      this.maintenanceEnabled = !!data.enabled;
    } catch { this.maintenanceEnabled = false; }
    btn.textContent = 'MAINTENANCE: ' + (this.maintenanceEnabled ? 'ON' : 'OFF');
    btn.className = this.maintenanceEnabled ? 'btn btn-danger' : 'btn btn-secondary';
  }

  async toggleMaintenance() {
    const token = AUTH.getToken();
    if (!token) { this.showMessage('Please login first', 'error'); return; }
    const next = !this.maintenanceEnabled;
    const action = next ? 'Enable' : 'Disable';
    if (!await confirmDialog(`${action} maintenance mode?`)) return;

    try {
      const fileRes = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data/maintenance.json`, {
        headers: { Authorization: `token ${token}` }
      });
      let sha;
      if (fileRes.ok) sha = (await fileRes.json()).sha;
      const content = btoa(JSON.stringify({ enabled: next }));
      const res = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/data/maintenance.json`, {
        method: 'PUT',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `${action} maintenance mode`, content, sha })
      });
      if (!res.ok) throw new Error('Failed to update maintenance state');
      this.maintenanceEnabled = next;
      const btn = document.getElementById('maintenance-btn');
      btn.textContent = 'MAINTENANCE: ' + (next ? 'ON' : 'OFF');
      btn.className = next ? 'btn btn-danger' : 'btn btn-secondary';
      this.showMessage(`Maintenance mode ${next ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
      this.showMessage(`Error: ${e.message}`, 'error');
    }
  }


  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => new Admin());
}

if (typeof module !== 'undefined') module.exports = { Admin, ARCHIVE_MUTATIONS_DISABLED };
