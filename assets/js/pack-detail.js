const ITEM_PREVIEW_ROWS = [
  ['diamond_sword.png', 'ender_pearl.png', '__potion__', 'steak.png'],
  ['iron_sword.png', 'fishing_rod_uncast.png', 'apple_golden.png', 'golden_carrot.png'],
];
const BLOCK_PREVIEW_ROWS = [
  ['grass_side.png', 'stone.png', 'cobblestone.png', 'wool_colored_white.png'],
  ['dirt.png', 'planks_oak.png', 'log_oak.png', 'diamond_ore.png'],
];

function buildPreviewRows(rows, renderCell) {
  return rows.map(row => `<div class="grid-row">${row.map(renderCell).join('')}</div>`).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const packName = pathParts[0] === 'p' ? pathParts[1] : pathParts[0];

  if (!packName) {
    document.getElementById('pack-content').innerHTML = 'Pack not found';
    return;
  }

  try {
    const pack = await fetch(`/data/packs/${packName}.json`).then(r => r.json());
    document.title = `${pack.displayName} - VALE`;

    const base = `/thumbnails/${encodeURIComponent(pack.name)}/`;
    const packPng = `${base}pack.png`;
    const img = (name) => `<img src="${base}${encodeURIComponent(name)}" alt="${name}" data-texture="${name}">`;
    const renderPreviewCell = (name) => name === '__potion__'
      ? '<canvas id="potion-canvas" class="potion-canvas"></canvas>'
      : img(name);
    const itemPreviewHtml = buildPreviewRows(ITEM_PREVIEW_ROWS, renderPreviewCell);
    const blockPreviewHtml = buildPreviewRows(BLOCK_PREVIEW_ROWS, img);

    // Set pack.png as favicon (center-crop to 1:1 if needed)
    const favicon = document.getElementById('favicon');
    if (favicon) {
      const setFavicon = (src) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const w = img.naturalWidth, h = img.naturalHeight;
          if (w === h) { favicon.href = src; return; }
          const size = Math.min(w, h);
          const c = document.createElement('canvas');
          c.width = size; c.height = size;
          c.getContext('2d').drawImage(img, (w - size) / 2, (h - size) / 2, size, size, 0, 0, size, size);
          favicon.href = c.toDataURL('image/png');
        };
        img.src = src;
      };
      const testImg = new Image();
      testImg.onload = () => setFavicon(packPng);
      testImg.onerror = () => setFavicon('/Default_Texture/pack.png');
      testImg.src = packPng;
    }

    const lists = JSON.parse(localStorage.getItem('vale_lists') || '[]');
    const inLists = lists.filter(l => l.packs.includes(packName)).map(l => l.name);
    inLists.sort((a, b) => {
      if (a === 'Overlay') return -1;
      if (b === 'Overlay') return 1;
      return 0;
    });

    document.getElementById('pack-content').innerHTML = `
      <div class="pack-cards">
        <div class="main-card">
          <img class="main-card-icon" src="${packPng}" alt="Pack">
          <div class="main-card-info">
            <h1>${pack.coloredName || pack.displayName}</h1>
            <p class="description">${pack.description || ''}</p>
          </div>
        </div>
        <div class="sub-card">
          <p class="original-name">${pack.id.replace('.zip', '')}</p>
          <p class="file-size">${pack.fileSize}</p>
          ${inLists.length ? `<p class="in-lists">${inLists.map(name => {
            const listId = name.replace(/^#/, '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
            const cls = name === 'Overlay' ? ' class="overlay-link"' : '';
            return `<a href="/l/${listId}/"${cls}>[${name}]</a>`;
          }).join(' ')}</p>` : ''}
        </div>
      </div>
      <div class="download-section">
        <h2>DOWNLOAD</h2>
        <a class="btn btn-primary" href="${pack.downloads.github}" target="_blank" download>GitHub</a>
        <a class="btn btn-secondary" href="${pack.downloads.mirror}" target="_blank" download>Mirror</a>
      </div>
      <div class="preview-section">
        <h2>Preview</h2>
        <div class="preview-grid">
          <div class="preview-card texture-grid">
            ${itemPreviewHtml}
            ${blockPreviewHtml}
          </div>
          <div class="preview-card armor-card">
            <div class="armor-wrapper">
              <div class="buff-side buff-left">
                <img src="${base}buff_speed.png" alt="speed" class="buff-img" onerror="this.style.display='none'">
                <img src="${base}buff_fire_resistance.png" alt="fire_resistance" class="buff-img" onerror="this.style.display='none'">
              </div>
              <div id="armor-viewer"></div>
              <div class="particle-side particle-right">
                <img src="${base}particle_magicCrit.png" alt="magicCrit" class="particle-img" onerror="this.style.display='none'">
                <img src="${base}particle_crit.png" alt="crit" class="particle-img" onerror="this.style.display='none'">
              </div>
            </div>
          </div>
          <div class="preview-card gui-card"><canvas id="gui-preview"></canvas></div>
          <div class="preview-card inventory-card">${img('inv.png')}</div>
        </div>
      </div>
      <div class="admin-actions is-hidden" id="admin-actions">
        <h3>ADMIN</h3>
        <button class="btn btn-primary" id="add-to-list-btn">ADD TO LIST</button>
      </div>
    `;

    // Admin actions
    function updateAdminUI() {
      const adminSection = document.getElementById('admin-actions');
      if (window.AUTH?.isLoggedIn()) {
        adminSection.style.display = 'block';
      } else {
        adminSection.style.display = 'none';
      }
    }

    window.addEventListener('auth-change', updateAdminUI);
    updateAdminUI();

    // Add to list modal
    document.getElementById('add-to-list-btn').onclick = () => {
      const modalLists = JSON.parse(localStorage.getItem('vale_lists') || '[]');
      const alreadyIn = modalLists.filter(l => l.packs.includes(packName)).map(l => l.name);

      const modal = document.createElement('div');
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-content">
          <h2>Add to List</h2>
          <input type="text" id="list-search" class="form-input-lg" placeholder="Search or create list...">
          <div id="list-options" class="modal-scroll"></div>
          <div class="modal-buttons">
            <button class="btn btn-primary" id="confirm-add-list">ADD</button>
            <button class="btn btn-secondary" id="cancel-add-list">CANCEL</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      const selected = new Set(alreadyIn);
      const searchInput = modal.querySelector('#list-search');
      const optionsDiv = modal.querySelector('#list-options');

      function renderOptions(query = '') {
        const q = query.toLowerCase();
        const filtered = modalLists.filter(l => l.name.toLowerCase().includes(q));

        let html = filtered.map(l => `
          <label class="option-row">
            <input type="checkbox" value="${l.name}" ${selected.has(l.name) ? 'checked' : ''} ${alreadyIn.includes(l.name) ? 'disabled' : ''}>
            <span>${l.name}</span>
            ${alreadyIn.includes(l.name) ? '<span class="option-note">(already added)</span>' : ''}
          </label>
        `).join('');

        if (query && !modalLists.find(l => l.name.toLowerCase() === q)) {
          html += `
            <label class="option-row option-row--create">
              <input type="checkbox" value="__new__${query}" ${selected.has('__new__' + query) ? 'checked' : ''}>
              <span>Create "${query}"</span>
            </label>
          `;
        }

        optionsDiv.innerHTML = html || '<p class="empty-note">No lists found</p>';

        optionsDiv.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(cb => {
          cb.onchange = () => {
            if (cb.checked) selected.add(cb.value);
            else selected.delete(cb.value);
          };
        });
      }

      searchInput.oninput = () => renderOptions(searchInput.value.trim());
      renderOptions();

      modal.querySelector('#cancel-add-list').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

      modal.querySelector('#confirm-add-list').onclick = () => {
        selected.forEach(val => {
          if (val.startsWith('__new__')) {
            const name = val.replace('__new__', '');
            modalLists.push({ name, cover: '', packs: [packName] });
          } else {
            const list = modalLists.find(l => l.name === val);
            if (list && !list.packs.includes(packName)) {
              list.packs.push(packName);
            }
          }
        });
        localStorage.setItem('vale_lists', JSON.stringify(modalLists));
        modal.remove();
        toast('Added to list(s)');
      };
    };

    // DELETE PACK is disabled: it targeted resourcepacks/ in the main repository,
    // but archives now live in the numbered pack repositories. A correct rebuild must
    // go through the two-phase deletion contract (see finalize-pack-replacements).
    // document.getElementById('delete-pack-btn').onclick = async () => {
    // if (!await confirmDialog(`Delete "${pack.displayName}"?`, { confirmText: 'DELETE', danger: true })) return;
    //
    // const token = window.AUTH?.getToken();
    // if (!token) return toast('Please login first', { type: 'error' });
    //
    // try {
    // const path = `resourcepacks/${pack.id}.zip`;
    // const fileRes = await fetch(`https://api.github.com/repos/Sakyvo/VALE/contents/${path}`, {
    // headers: { Authorization: `token ${token}` }
    // });
    //
    // if (!fileRes.ok) return toast('Pack file not found in the repository', { type: 'error' });
    //
    // const fileData = await fileRes.json();
    // const res = await fetch(`https://api.github.com/repos/Sakyvo/VALE/contents/${path}`, {
    // method: 'DELETE',
    // headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    // body: JSON.stringify({ message: `Delete ${pack.id}`, sha: fileData.sha })
    // });
    //
    // if (res.ok) {
    // toast('Deleted. Site will update after the next build.');
    // setTimeout(() => { window.location.href = '/'; }, 1200);
    // } else {
    // const err = await res.json();
    // toast(`Delete failed: ${err.message}`, { type: 'error' });
    // }
    // } catch (e) {
    // toast(`Delete failed: ${e.message}`, { type: 'error' });
    // }
    // }
;

    // Setup animated textures - hide until loaded to prevent flash
    document.querySelectorAll('.texture-grid img').forEach(img => {
      img.style.visibility = 'hidden';
      img.onload = async function() {
        if (this.naturalHeight > this.naturalWidth) {
          const frames = this.naturalHeight / this.naturalWidth;
          if (Number.isInteger(frames) && frames > 1) {
            const wrapper = document.createElement('div');
            wrapper.className = 'animated-texture';
            wrapper.style.backgroundImage = `url(${this.src})`;
            wrapper.style.backgroundSize = `100% ${frames * 100}%`;

            let frameTime = 2;
            try {
              const mcmeta = await fetch(this.src + '.mcmeta').then(r => r.json());
              if (mcmeta.animation?.frametime) frameTime = mcmeta.animation.frametime;
            } catch(e) {}

            let currentFrame = 0;
            setInterval(() => {
              currentFrame = (currentFrame + 1) % frames;
              wrapper.style.backgroundPosition = `0 ${(currentFrame / (frames - 1)) * 100}%`;
            }, frameTime * 50);

            this.parentNode.replaceChild(wrapper, this);
            return;
          }
        }
        this.style.visibility = 'visible';
      };
    });

    // Potion dynamic rendering
    const potionCanvas = document.getElementById('potion-canvas');
    if (potionCanvas && window.renderPotion) {
      renderPotion(potionCanvas, `${base}potion_overlay.png`, `${base}potion_bottle_splash.png`, POTION_COLORS.instant_health);
    }

    const container = document.getElementById('armor-viewer');
    if (container && window.ArmorViewer) {
      new ArmorViewer(
        container,
        '/Default_Texture/Steve.png',
        `${base}diamond_layer_1.png`,
        `${base}diamond_layer_2.png`
      );
    }

    // GUI Preview
    const guiCanvas = document.getElementById('gui-preview');
    if (guiCanvas && window.GuiPreview) {
      const gui = new GuiPreview(guiCanvas, base);
      gui.load().then(() => gui.render()).catch(() => {});
    }
  } catch (e) {
    document.getElementById('pack-content').innerHTML = 'Pack not found';
  }
});
