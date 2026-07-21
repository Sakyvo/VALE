let listsData = [];
let allPacks = [];
let sortByDate = false;
let saveQueue = Promise.resolve();

const LIST_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>List - VALE</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="stylesheet" href="/assets/css/style.css">
</head>
<body>
  <header>
    <a href="/" class="logo">VALE</a>
    <nav></nav>
  </header>
  <section class="explore-section">
    <div class="section-header">
      <div class="section-tabs">
        <a href="/" class="tab-btn">EXPLORE</a>
        <a href="/l/" class="tab-btn active">LISTS</a>
      </div>
    </div>
    <div class="list-grid" id="list-grid"></div>
  </section>
  <footer><p>VALE Project</p></footer>
  <script src="/assets/js/auth.js?v=2"></script>
  <script src="/assets/js/list.js?v=4"></script>
</body>
</html>`;

async function loadLists() {
  const token = AUTH.getToken();
  // 登录时从 GitHub API 获取最新数据（绕过 CDN 缓存）
  if (token) {
    try {
      const res = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/l/lists.json`, {
        headers: { Authorization: `token ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        listsData = JSON.parse(decodeURIComponent(escape(atob(data.content))));
        localStorage.setItem('vale_lists', JSON.stringify(listsData));
        return listsData;
      }
    } catch (e) {}
  }
  // 未登录时从 CDN 获取
  try {
    const res = await fetch('/l/lists.json?t=' + Date.now());
    listsData = await res.json();
    localStorage.setItem('vale_lists', JSON.stringify(listsData));
  } catch (e) {
    const cached = localStorage.getItem('vale_lists');
    listsData = cached ? JSON.parse(cached) : [];
  }
  return listsData;
}

function getCurrentListId() {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'l' && pathParts[1]) return pathParts[1];
  return null;
}

async function resyncListsUI() {
  await loadLists();
  const currentListId = getCurrentListId();
  if (currentListId) loadListDetail(currentListId);
  else window.renderLists?.('');
}

async function fetchListsSha(token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/l/lists.json`, {
      headers: { Authorization: `token ${token}` }
    });
    if (res.ok) return (await res.json()).sha;
  } catch (e) {}
  return undefined;
}

// 批量提交多个文件（单次 commit，避免多次 workflow）
async function batchCommit(files, message) {
  const token = AUTH.getToken();
  if (!token) return false;

  try {
    // 获取最新的 main 分支 ref
    const refRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/git/ref/heads/main`, {
      headers: { Authorization: `token ${token}` }
    });
    if (!refRes.ok) return false;
    const refData = await refRes.json();
    const latestCommitSha = refData.object.sha;

    // 获取最新 commit 的 tree
    const commitRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/git/commits/${latestCommitSha}`, {
      headers: { Authorization: `token ${token}` }
    });
    if (!commitRes.ok) return false;
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    // 创建 blobs 并构建 tree
    const treeItems = await Promise.all(files.map(async f => {
      const blobRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/git/blobs`, {
        method: 'POST',
        headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: f.content, encoding: 'utf-8' })
      });
      if (!blobRes.ok) return null;
      const blob = await blobRes.json();
      return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
    }));

    if (treeItems.some(t => !t)) return false;

    // 创建新 tree
    const treeRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/git/trees`, {
      method: 'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
    });
    if (!treeRes.ok) return false;
    const newTree = await treeRes.json();

    // 创建新 commit
    const newCommitRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/git/commits`, {
      method: 'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, tree: newTree.sha, parents: [latestCommitSha] })
    });
    if (!newCommitRes.ok) return false;
    const newCommit = await newCommitRes.json();

    // 更新 ref
    const updateRefRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/git/refs/heads/main`, {
      method: 'PATCH',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sha: newCommit.sha })
    });
    return updateRefRes.ok;
  } catch (e) {
    console.error('Batch commit failed:', e);
    return false;
  }
}

async function doSaveLists() {
  const token = AUTH.getToken();
  if (!token) return false;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(listsData, null, 2))));
  let lastResponse;
  for (let attempt = 0; attempt < 2; attempt++) {
    const sha = await fetchListsSha(token);
    lastResponse = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/l/lists.json`, {
      method: 'PUT',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Update lists', content, sha })
    });
    if (lastResponse.ok) return true;
  }
  toast(`Save failed (${lastResponse?.status || 'network'}). Reloading latest data.`, { type: 'error' });
  await resyncListsUI();
  return false;
}

async function saveLists() {
  localStorage.setItem('vale_lists', JSON.stringify(listsData));
  const token = AUTH.getToken();
  if (!token) return false;
  saveQueue = saveQueue.then(() => doSaveLists()).catch(() => doSaveLists());
  return saveQueue;
}

// 创建 list 时同时保存 lists.json 和创建页面（单次 commit）
async function createListWithPage(listId) {
  const token = AUTH.getToken();
  if (!token) return false;

  const listsContent = JSON.stringify(listsData, null, 2);
  const pageContent = LIST_PAGE_HTML;

  const success = await batchCommit([
    { path: 'l/lists.json', content: listsContent },
    { path: `l/${listId}/index.html`, content: pageContent }
  ], `Create list: ${listId}`);

  if (!success) {
    // 降级为串行操作
    await saveLists();
    await createListPage(listId);
  }
  return true;
}

async function createListPage(listId) {
  const token = AUTH.getToken();
  if (!token) return false;

  const content = btoa(unescape(encodeURIComponent(LIST_PAGE_HTML)));
  const path = `l/${listId}/index.html`;

  const res = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Create list page: ${listId}`, content })
  });
  return res.ok;
}

async function deleteListPage(listId) {
  const token = AUTH.getToken();
  if (!token) throw new Error('Not logged in');

  const path = `l/${listId}/index.html`;

  let sha;
  const getRes = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/${path}`, {
    headers: { Authorization: `token ${token}` }
  });
  if (getRes.status === 404) return true;
  if (!getRes.ok) throw new Error('Failed to get file');
  sha = (await getRes.json()).sha;

  const res = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Delete list page: ${listId}`, sha })
  });
  if (!res.ok) throw new Error('Failed to delete from repo');
  return true;
}

function sanitizeName(name) {
  return name.replace(/^#/, '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
}

document.addEventListener('DOMContentLoaded', async () => {
  const pathParts = window.location.pathname.split('/').filter(Boolean);

  // Handle redirect from 404 for non-existent list pages
  const redirectPath = sessionStorage.getItem('listPath');
  if (redirectPath) {
    sessionStorage.removeItem('listPath');
    const parts = redirectPath.split('/').filter(Boolean);
    if (parts[0] === 'l' && parts[1]) {
      await loadLists();
      try {
        const index = await fetch('/data/index.json').then(r => r.json());
        allPacks = index.items;
      } catch (e) {}
      window.history.replaceState({}, '', redirectPath);
      loadListDetail(parts[1]);
      return;
    }
  }

  if (pathParts[0] === 'l' && pathParts[1]) {
    await loadLists();
    try {
      const index = await fetch('/data/index.json').then(r => r.json());
      allPacks = index.items;
    } catch (e) {}
    loadListDetail(pathParts[1]);
    return;
  }

  await loadLists();

  const grid = document.getElementById('list-grid');
  const searchInput = document.getElementById('list-search');
  const searchBtn = document.querySelector('.search-btn');
  const sortBtn = document.getElementById('sort-btn');
  let listSearchQuery = '';

  window.renderLists = function(query = '') {
    const q = query.toLowerCase();
    const overlay = listsData.find(l => l.name === 'Overlay');
    let filtered = listsData.filter(l =>
      l.name !== 'Overlay' && l.name.toLowerCase().includes(q)
    );

    if (sortByDate) {
      filtered = [...filtered].reverse();
    } else {
      filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (overlay && overlay.name.toLowerCase().includes(q)) {
      filtered = [overlay, ...filtered];
    }

    if (filtered.length === 0) {
      grid.innerHTML = query ? '<p>No lists found.</p>' : '<p>No lists yet.</p>';
      return;
    }

    grid.innerHTML = filtered.map(list => {
      const safeName = sanitizeName(list.name);
      const isOverlay = list.name === 'Overlay';
      return `
        <a class="list-item${isOverlay ? ' overlay-list' : ''}" href="/l/${safeName}/">
          <div class="info">
            <div class="name">${list.name}</div>
            <div class="meta">${list.packs.length} packs</div>
          </div>
        </a>
      `;
    }).join('');
  }

  sortBtn?.addEventListener('click', () => {
    sortByDate = !sortByDate;
    sortBtn.textContent = sortByDate ? 'DATE' : 'A-Z';
    window.renderLists(listSearchQuery);
  });

  function submitListSearch() {
    listSearchQuery = searchInput.value;
    window.renderLists(listSearchQuery);
  }

  function resetListSearchWhenCleared() {
    if (searchInput.value.trim() !== '' || listSearchQuery === '') return;
    listSearchQuery = '';
    window.renderLists(listSearchQuery);
  }

  function updateUI() {
    const isAdmin = window.AUTH?.isLoggedIn();
    document.getElementById('manage-btn').style.display = isAdmin ? 'inline-block' : 'none';
    window.renderLists(listSearchQuery);
  }

  searchBtn?.addEventListener('click', submitListSearch);
  searchInput?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submitListSearch();
  });
  searchInput?.addEventListener('input', resetListSearchWhenCleared);

  document.getElementById('manage-btn').onclick = showManageModal;

  window.addEventListener('auth-change', updateUI);
  updateUI();
});

function showManageModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:500px;">
      <h2>MANAGE LISTS</h2>
      <div class="tag-input-group" style="margin-bottom:16px;">
        <input type="text" id="new-list-name" placeholder="New list name">
        <button class="btn btn-primary" id="create-list-btn">CREATE</button>
      </div>
      <div id="manage-list" style="max-height:300px;overflow-y:auto;"></div>
      <div class="modal-buttons" style="margin-top:16px;">
        <button class="btn btn-secondary" id="close-manage">CLOSE</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function renderManageList() {
    const listEl = modal.querySelector('#manage-list');
    listEl.innerHTML = listsData.map((l, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee;">
        <span style="flex:1;">${l.name}</span>
        <button class="btn btn-secondary delete-list-btn" data-index="${i}" style="padding:4px 8px;">DELETE</button>
      </div>
    `).join('') || '<p style="color:#666;">No lists</p>';

    listEl.querySelectorAll('.delete-list-btn').forEach(btn => {
      btn.onclick = async () => {
        const idx = parseInt(btn.dataset.index);
        const name = listsData[idx].name;
        const listId = sanitizeName(name);
        if (await showConfirm(`Delete list "${name}"?`)) {
          try {
            await deleteListPage(listId);
            listsData.splice(idx, 1);
            await saveLists();
            renderManageList();
            window.renderLists?.('');
          } catch (e) {
            toast('Delete failed: ' + e.message, { type: 'error' });
          }
        }
      };
    });
  }

  modal.querySelector('#create-list-btn').onclick = async () => {
    const input = modal.querySelector('#new-list-name');
    const name = input.value.trim();
    if (!name) return;
    if (listsData.find(l => l.name === name)) {
      toast('List already exists', { type: 'error' });
      return;
    }
    const listId = sanitizeName(name);
    listsData.push({ name, cover: '', description: '', packs: [] });
    localStorage.setItem('vale_lists', JSON.stringify(listsData));
    await createListWithPage(listId);
    input.value = '';
    renderManageList();
    window.renderLists?.('');
  };

  modal.querySelector('#close-manage').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  renderManageList();
}

async function loadListDetail(listId) {
  const list = listsData.find(l => sanitizeName(l.name) === listId);

  if (!list) {
    document.querySelector('.explore-section').innerHTML = '<p>List not found. <a href="/l/">Back to Lists</a></p>';
    return;
  }

  document.title = `${list.name} - VALE`;

  const heroEl = document.querySelector('.hero');
  if (heroEl) heroEl.style.display = 'none';

  if (allPacks.length === 0) {
    try {
      const index = await fetch('/data/index.json').then(r => r.json());
      allPacks = index.items;
    } catch (e) {}
  }

  let searchQuery = '';
  let detailSortByDate = false;

  function render() {
    const isAdmin = window.AUTH?.isLoggedIn();
    let packsInList = list.packs.map(name => allPacks.find(p => p.name === name)).filter(Boolean);

    if (searchQuery) {
      packsInList = packsInList.filter(p =>
        p.displayName.toLowerCase().includes(searchQuery) ||
        p.name.toLowerCase().includes(searchQuery)
      );
    }

    if (detailSortByDate) {
      packsInList = [...packsInList].reverse();
    } else {
      packsInList = [...packsInList].sort((a, b) => a.displayName.localeCompare(b.displayName));
    }

    document.querySelector('.explore-section').innerHTML = `
      <div class="section-header">
        <div class="section-tabs">
          <a href="/" class="tab-btn">EXPLORE</a>
          <a href="/l/" class="tab-btn active">LISTS</a>
        </div>
        <button class="sort-btn" id="detail-sort-btn">${detailSortByDate ? 'DATE' : 'A-Z'}</button>
      </div>
      <div style="margin-bottom:24px;">
        <a href="/l/" class="back-link">← Back to Lists</a>
        <div style="display:flex;align-items:center;gap:12px;margin:16px 0 8px;">
          <h1 style="margin:0;">${list.name}</h1>
          ${isAdmin ? `<button class="btn btn-secondary" id="edit-list-btn" style="padding:4px 12px;">EDIT</button>` : ''}
        </div>
        ${list.description ? `<p class="list-description">${list.description}</p>` : ''}
        <p class="meta">${list.packs.length} packs</p>
      </div>
      <div class="search-box" style="margin:0 0 24px;max-width:calc((100% - 48px) / 3);justify-content:stretch;">
        <input type="text" id="list-pack-search" placeholder="Search packs..." value="${searchQuery}" style="flex:1;padding:12px 16px;border:2px solid #000;font-size:14px;outline:none;">
        <button class="search-btn" id="list-pack-search-btn" aria-label="Search"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></button>
      </div>
      ${isAdmin ? `
        <div style="margin-bottom:24px;">
          <button class="btn btn-primary" id="add-packs-btn">ADD PACKS</button>
          <button class="btn btn-secondary" id="delete-list-btn">DELETE LIST</button>
        </div>
      ` : ''}
      <div class="pack-grid">
        ${packsInList.length === 0 ? '<p>No packs found.</p>' : packsInList.map(pack => `
          <div class="pack-card-wrapper">
            <a class="pack-card" href="/p/${pack.name}/" target="_blank" rel="noopener noreferrer">
              <img class="cover" src="${pack.cover}" alt="${pack.displayName}">
              <div class="info">
                <img class="pack-icon" src="${pack.packPng}" alt="">
                <div class="name">${pack.coloredName || pack.displayName}</div>
              </div>
            </a>
            ${isAdmin ? `<button class="remove-pack-btn" data-pack="${pack.name}">×</button>` : ''}
          </div>
        `).join('')}
      </div>
    `;

    document.querySelectorAll('.pack-card .cover').forEach(img => {
      img.onload = function() {
        const frameH = this.naturalWidth / 2;
        const frames = this.naturalHeight / frameH;
        if (Number.isInteger(frames) && frames > 1) {
          const wrapper = document.createElement('div');
          wrapper.className = 'cover animated-cover';
          wrapper.style.backgroundImage = `url(${this.src})`;
          wrapper.style.backgroundSize = `100% ${frames * 100}%`;
          wrapper.style.imageRendering = 'pixelated';
          let currentFrame = 0;
          setInterval(() => {
            currentFrame = (currentFrame + 1) % frames;
            wrapper.style.backgroundPosition = `0 ${(currentFrame / (frames - 1)) * 100}%`;
          }, 100);
          this.replaceWith(wrapper);
        }
      };
    });

    document.getElementById('detail-sort-btn')?.addEventListener('click', () => {
      detailSortByDate = !detailSortByDate;
      render();
    });

    function submitPackSearch() {
      const input = document.getElementById('list-pack-search');
      searchQuery = (input?.value || '').toLowerCase();
      render();
    }

    const packSearchInput = document.getElementById('list-pack-search');
    document.getElementById('list-pack-search-btn')?.addEventListener('click', submitPackSearch);
    packSearchInput?.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      submitPackSearch();
    });
    packSearchInput?.addEventListener('input', () => {
      if (packSearchInput.value.trim() !== '' || searchQuery === '') return;
      searchQuery = '';
      render();
    });

    if (isAdmin) {
      document.getElementById('edit-list-btn')?.addEventListener('click', () => showEditModal(list, render));
      document.getElementById('add-packs-btn')?.addEventListener('click', () => showAddPackModal(list, render));
      document.getElementById('delete-list-btn')?.addEventListener('click', async () => {
        if (await showConfirm(`Delete list "${list.name}"?`)) {
          try {
            const listId = sanitizeName(list.name);
            await deleteListPage(listId);
            listsData = listsData.filter(l => l.name !== list.name);
            await saveLists();
            window.location.href = '/l/';
          } catch (e) {
            toast('Delete failed: ' + e.message, { type: 'error' });
          }
        }
      });

      document.querySelectorAll('.remove-pack-btn').forEach(btn => {
        btn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const packName = btn.dataset.pack;
          if (await showConfirm(`Remove "${packName}" from list?`)) {
            list.packs = list.packs.filter(p => p !== packName);
            const saved = await saveLists();
            if (!saved) {
              await loadLists();
              loadListDetail(listId);
              return;
            }
            render();
          }
        };
      });
    }
  }

  window.addEventListener('auth-change', render);
  render();
}

function showEditModal(list, onDone) {
  const listId = sanitizeName(list.name);
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:400px;">
      <h2>EDIT LIST</h2>
      <div class="form-group">
        <label>NAME</label>
        <input type="text" id="edit-name" value="${list.name}">
      </div>
      <div class="form-group">
        <label>COVER IMAGE</label>
        <input type="file" id="edit-cover-file" accept="image/*">
        ${list.cover ? `<p style="margin-top:8px;font-size:12px;color:#666;">Current: ${list.cover}</p>` : ''}
      </div>
      <div class="form-group">
        <label>DESCRIPTION</label>
        <textarea id="edit-desc" rows="3" style="width:100%;padding:8px;border:2px solid #000;">${list.description || ''}</textarea>
      </div>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="save-edit">SAVE</button>
        <button class="btn btn-secondary" id="cancel-edit">CANCEL</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector('#save-edit').onclick = async () => {
    const newName = modal.querySelector('#edit-name').value.trim();
    if (!newName) return;
    const newListId = sanitizeName(newName);
    const coverFile = modal.querySelector('#edit-cover-file').files[0];

    if (coverFile) {
      const token = AUTH.getToken();
      if (token) {
        const coverPath = `l/${newListId}/${newListId}_cover.png`;
        const content = await fileToBase64(coverFile);
        let sha;
        try {
          const res = await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/${coverPath}`, {
            headers: { Authorization: `token ${token}` }
          });
          if (res.ok) sha = (await res.json()).sha;
        } catch (e) {}
        await fetch(`https://api.github.com/repos/${AUTH.REPO_OWNER}/${AUTH.REPO_NAME}/contents/${coverPath}`, {
          method: 'PUT',
          headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Upload cover for ${newListId}`, content, sha })
        });
        list.cover = `/${coverPath}`;
      }
    }

    list.name = newName;
    list.description = modal.querySelector('#edit-desc').value.trim();
    await saveLists();
    modal.remove();
    window.history.replaceState({}, '', '/l/' + newListId + '/');
    onDone();
  };

  modal.querySelector('#cancel-edit').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showAddPackModal(list, onDone) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:500px;">
      <h2>Add Packs</h2>
      <input type="text" id="pack-search" placeholder="Search packs..." style="width:100%;padding:12px;border:2px solid #000;margin-bottom:16px;">
      <div id="pack-list" style="max-height:300px;overflow-y:auto;"></div>
      <div class="modal-buttons">
        <button class="btn btn-primary" id="confirm-add-packs">ADD SELECTED</button>
        <button class="btn btn-secondary" id="cancel-add-packs">CANCEL</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const selected = new Set();
  const searchInput = modal.querySelector('#pack-search');
  const packList = modal.querySelector('#pack-list');

  function renderPackList(query = '') {
    const filtered = allPacks.filter(p =>
      !list.packs.includes(p.name) &&
      (p.displayName.toLowerCase().includes(query) || p.name.toLowerCase().includes(query))
    );

    packList.innerHTML = filtered.map(p => `
      <label style="display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee;cursor:pointer;">
        <input type="checkbox" value="${p.name}" ${selected.has(p.name) ? 'checked' : ''}>
        <img src="${p.packPng}" style="width:32px;height:32px;image-rendering:pixelated;">
        <span>${p.displayName}</span>
      </label>
    `).join('') || '<p style="padding:8px;color:#666;">No packs found</p>';

    packList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) selected.add(cb.value);
        else selected.delete(cb.value);
      };
    });
  }

  searchInput.oninput = () => renderPackList(searchInput.value.toLowerCase());
  renderPackList();

  modal.querySelector('#cancel-add-packs').onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  modal.querySelector('#confirm-add-packs').onclick = async () => {
    selected.forEach(name => {
      if (!list.packs.includes(name)) list.packs.push(name);
    });
    modal.remove();
    onDone();
    saveLists();
  };
}

function showConfirm(message) {
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-content" style="max-width:350px;text-align:center;">
        <p style="margin-bottom:24px;">${message}</p>
        <div class="modal-buttons">
          <button class="btn btn-primary" id="confirm-yes">CONFIRM</button>
          <button class="btn btn-secondary" id="confirm-no">CANCEL</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#confirm-yes').onclick = () => { modal.remove(); resolve(true); };
    modal.querySelector('#confirm-no').onclick = () => { modal.remove(); resolve(false); };
    modal.onclick = (e) => { if (e.target === modal) { modal.remove(); resolve(false); } };
  });
}
