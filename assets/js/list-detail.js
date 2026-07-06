const LISTS_KEY = 'vale_lists';

function getLists() {
  return JSON.parse(localStorage.getItem(LISTS_KEY) || '[]');
}

function saveLists(lists) {
  localStorage.setItem(LISTS_KEY, JSON.stringify(lists));
}

function sanitizeName(name) {
  return name.replace(/^#/, '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
}

document.addEventListener('DOMContentLoaded', async () => {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const listId = pathParts[1];

  if (!listId) {
    document.getElementById('list-content').innerHTML = 'List not found';
    return;
  }

  const lists = getLists();
  const list = lists.find(l => sanitizeName(l.name) === listId);

  if (!list) {
    document.getElementById('list-content').innerHTML = 'List not found';
    return;
  }

  document.title = `${list.name} - VALE`;

  let allPacks = [];
  try {
    const index = await fetch('/data/index.json').then(r => r.json());
    allPacks = index.items;
  } catch (e) {}

  function render() {
    const isAdmin = window.AUTH?.isLoggedIn();
    const packsInList = list.packs.map(name => allPacks.find(p => p.name === name)).filter(Boolean);

    document.getElementById('list-content').innerHTML = `
      <div class="detail-header">
        <div class="detail-info" style="flex:1;">
          <h1>${list.name}</h1>
          <p class="meta">${list.packs.length} packs</p>
        </div>
      </div>
      ${isAdmin ? `
        <div class="admin-actions" style="border-top:none;padding-top:0;margin-top:0;margin-bottom:24px;">
          <button class="btn btn-primary" id="add-packs-btn">ADD PACKS</button>
          <button class="btn btn-secondary" id="delete-list-btn">DELETE LIST</button>
        </div>
      ` : ''}
      <div class="pack-grid">
        ${packsInList.length === 0 ? '<p>No packs in this list.</p>' : packsInList.map(pack => `
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

    if (isAdmin) {
      document.getElementById('add-packs-btn')?.addEventListener('click', showAddPackModal);
      document.getElementById('delete-list-btn')?.addEventListener('click', () => {
        if (confirm(`Delete list "${list.name}"?`)) {
          const newLists = lists.filter(l => l.name !== list.name);
          saveLists(newLists);
          window.location.href = '/l/';
        }
      });

      document.querySelectorAll('.remove-pack-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const packName = btn.dataset.pack;
          list.packs = list.packs.filter(p => p !== packName);
          saveLists(lists);
          render();
        };
      });
    }
  }

  function showAddPackModal() {
    const modal = document.getElementById('add-pack-modal');
    const packList = document.getElementById('pack-list');
    const searchInput = document.getElementById('pack-search');
    let selected = new Set();

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
      `).join('');

      packList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.onchange = () => {
          if (cb.checked) selected.add(cb.value);
          else selected.delete(cb.value);
        };
      });
    }

    searchInput.value = '';
    searchInput.oninput = () => renderPackList(searchInput.value.toLowerCase());
    renderPackList();

    modal.style.display = 'flex';

    document.getElementById('cancel-add-packs').onclick = () => modal.style.display = 'none';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

    document.getElementById('confirm-add-packs').onclick = () => {
      selected.forEach(name => {
        if (!list.packs.includes(name)) list.packs.push(name);
      });
      saveLists(lists);
      modal.style.display = 'none';
      render();
    };
  }

  window.addEventListener('auth-change', render);
  render();
});
