class PackSearch {
  constructor(loader) {
    this.loader = loader;
    this.searchInput = document.querySelector('#search-input');
    this.resultsContainer = document.querySelector('.pack-grid');
    this.sortBtn = document.getElementById('sort-btn');
    this.sortByDate = false;
    this.searchInput.addEventListener('input', this.debounce(() => this.search(), 300));
    this.sortBtn?.addEventListener('click', () => this.toggleSort());
  }

  toggleSort() {
    this.sortByDate = !this.sortByDate;
    this.sortBtn.textContent = this.sortByDate ? 'DATE' : 'A-Z';
    this.loader.setSortByDate(this.sortByDate);
    this.search();
  }

  search() {
    const query = this.searchInput.value.trim().toLowerCase();

    if (!query) {
      this.loader.renderPlaceholders();
      this.loader.observeItems();
      return;
    }

    let results = (this.loader.allItems || this.loader.index.items).filter(pack =>
      pack.displayName.toLowerCase().includes(query) ||
      pack.name.toLowerCase().includes(query)
    );

    if (this.sortByDate) {
      results = [...results].reverse();
    }

    this.renderResults(results);
  }

  renderResults(results) {
    this.resultsContainer.innerHTML = results
      .map(pack => {
        const isOverlay = (pack.lists || []).includes('Overlay');
        const badge = isOverlay ? '<span class="overlay-badge">OVERLAY</span>' : '';
        return `
        <a class="pack-card" href="/p/${pack.name}/">
          <img class="cover" src="${pack.cover}" alt="${pack.displayName}" style="visibility:hidden">
          ${badge}
          <div class="info">
            <img class="pack-icon" src="${pack.packPng}" alt="">
            <div class="name">${pack.coloredName || pack.displayName}</div>
          </div>
        </a>
      `;
      })
      .join('');

    this.resultsContainer.querySelectorAll('.cover').forEach(img => {
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
          return;
        }
        this.style.visibility = 'visible';
      };
    });
  }

  debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const loader = new PackLoader();
  await loader.init();
  new PackSearch(loader);
});
