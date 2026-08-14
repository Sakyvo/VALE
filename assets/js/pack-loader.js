// Issue 019: build-versioned cache key for index.json / page data so Cloudflare caches them.
// generate-index.js rewrites this to the index content hash on each build.
const VALE_INDEX_VERSION = 'b1c721cd';

class PackLoader {
  constructor() {
    this.index = null;
    this.loadedPages = new Set();
    this.pagesData = {};
    this.pageSize = 50;
    this.sortByDate = false;
    this.observer = new IntersectionObserver(
      entries => this.onIntersect(entries),
      { rootMargin: '200px' }
    );
  }

  async init() {
    const raw = await fetch('data/index.json?v=' + VALE_INDEX_VERSION).then(r => r.json());
    this.allItems = raw.items;
    // Issue 019: precompute name -> original index so onIntersect/getPackByIndex are O(1),
    // not O(N) linear scans that make the visibility callback O(N^2) over the full grid.
    this.nameToOrigIndex = new Map();
    this.allItems.forEach((item, i) => this.nameToOrigIndex.set(item.name, i));
    this.nameToPagePack = new Map();
    const displayItems = raw.items.filter(it => !(it.lists || []).includes('Overlay'));
    this.index = { ...raw, items: displayItems };
    this.renderPlaceholders();
    this.observeItems();
  }

  setSortByDate(val) {
    this.sortByDate = val;
    this.renderPlaceholders();
    this.observeItems();
  }

  getItems() {
    return this.sortByDate ? [...this.index.items].reverse() : this.index.items;
  }

  renderPlaceholders() {
    const grid = document.querySelector('.pack-grid');
    const items = this.getItems();
    grid.innerHTML = items
      .map((item, i) => `
        <a class="pack-card" data-index="${i}" data-id="${item.name}" data-loaded="false" href="p/${item.name}/" target="_blank" rel="noopener noreferrer">
          <div class="placeholder"></div>
          <div class="info">
            <div class="name">${item.coloredName || item.displayName}</div>
          </div>
        </a>
      `)
      .join('');
  }

  observeItems() {
    document.querySelectorAll('.pack-card[data-loaded="false"]')
      .forEach(el => this.observer.observe(el));
  }

  async onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;

      const el = entry.target;
      const index = parseInt(el.dataset.index);
      const items = this.getItems();
      const item = items[index];
      if (!item) continue;
      const origIndex = this.nameToOrigIndex.get(item.name);
      if (origIndex == null) continue;
      const page = Math.floor(origIndex / this.pageSize) + 1;

      if (!this.loadedPages.has(page)) {
        await this.loadPage(page);
      }

      const pageItems = this.pagesData[page];
      let pack = pageItems && pageItems[origIndex % this.pageSize];
      if (!pack) {
        // Fall back to the name map only if the precomputed offset didn't line up.
        pack = pageItems && pageItems.find(p => p.name === item.name);
      }
      if (pack) this.renderCard(el, pack);

      el.dataset.loaded = 'true';
      this.observer.unobserve(el);
    }
  }

  async loadPage(page) {
    const data = await fetch(`data/pages/page-${page}.json?v=` + VALE_INDEX_VERSION).then(r => r.json());
    this.pagesData[page] = data.items;
    this.loadedPages.add(page);
  }

  getPackByIndex(index) {
    const items = this.getItems();
    const item = items[index];
    if (!item) return null;
    const origIndex = this.nameToOrigIndex.get(item.name);
    if (origIndex == null) return null;
    const page = Math.floor(origIndex / this.pageSize) + 1;
    const offset = origIndex % this.pageSize;
    return this.pagesData[page]?.[offset];
  }

  renderCard(el, pack) {
    const coverImg = new Image();
    coverImg.className = 'cover';
    coverImg.alt = pack.displayName;
    coverImg.loading = 'lazy';
    coverImg.style.imageRendering = 'pixelated';

    coverImg.onload = function() {
      // Cover is 2:1 ratio, frame height = width / 2
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
    coverImg.src = pack.cover;

    el.innerHTML = `
      <div class="info">
        <img class="pack-icon" src="${pack.packPng}" alt="">
        <div class="name">${pack.coloredName || pack.displayName}</div>
      </div>
    `;
    el.insertBefore(coverImg, el.firstChild);
  }
}

window.PackLoader = PackLoader;
