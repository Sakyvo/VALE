class PackSearch {
  constructor(loader) {
    this.loader = loader;
    this.searchInput = document.querySelector('#search-input');
    this.searchBtn = document.querySelector('.search-btn');
    this.resultsContainer = document.querySelector('.pack-grid');
    this.sortBtn = document.getElementById('sort-btn');
    this.sortByDate = false;
    this.searchBtn?.addEventListener('click', () => this.search());
    this.searchInput?.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.search();
    });
    this.searchInput?.addEventListener('input', () => this.resetWhenCleared());
    this.sortBtn?.addEventListener('click', () => this.toggleSort());
  }

  resetWhenCleared() {
    if (this.searchInput.value.trim() !== '') return;
    this.search();
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
        <a class="pack-card" href="/p/${pack.name}/" target="_blank" rel="noopener noreferrer">
          <img class="cover" src="${valeCoverUrl(pack.cover)}" alt="${pack.displayName}">
          ${badge}
          <div class="info">
            <img class="pack-icon" src="${pack.packPng}" alt="">
            <div class="name">${pack.coloredName || pack.displayName}</div>
          </div>
        </a>
      `;
      })
      .join('');


  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const loader = new PackLoader();
  await loader.init();
  new PackSearch(loader);
});
