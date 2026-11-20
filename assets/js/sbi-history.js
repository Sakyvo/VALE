(function() {
'use strict';

const KEY = 'vale-sbi-history';

function getHistory() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function renderList() {
  const list = document.getElementById('sbi-history-list');
  const detail = document.getElementById('sbi-history-detail');
  const history = getHistory();
  detail.hidden = true;
  list.hidden = false;
  if (history.length === 0) {
    list.innerHTML = '<p class="sbi-no-results">No search history yet</p>';
    return;
  }
  list.innerHTML = history.map((h, i) =>
    '<div class="sbi-history-item" data-idx="' + i + '">' +
      '<img class="sbi-history-thumb" src="' + h.imageDataUrl + '">' +
      '<div class="sbi-history-meta">' +
        '<div>' + formatTime(h.timestamp) + '</div>' +
        '<div class="sbi-history-count">' + h.results.length + ' match' + (h.results.length !== 1 ? 'es' : '') + '</div>' +
      '</div>' +
    '</div>'
  ).join('');
  list.querySelectorAll('.sbi-history-item').forEach(el => {
    el.addEventListener('click', () => showDetail(parseInt(el.dataset.idx)));
  });
}

function showDetail(idx) {
  const history = getHistory();
  const h = history[idx];
  if (!h) return;
  document.getElementById('sbi-history-list').hidden = true;
  const detail = document.getElementById('sbi-history-detail');
  detail.hidden = false;
  window.location.hash = '#' + (idx + 1);
  let html = '<button class="btn btn-secondary sbi-back-btn" id="sbi-back">← Back to history</button>';
  html += '<img class="sbi-detail-img" src="' + h.imageDataUrl + '">';
  if (!h.results.length) {
    html += '<p class="sbi-no-results">No results found</p>';
  } else {
    html += h.results.map(r => {
      const pct = Math.min(100, Math.round(r.score * 100));
      return '<a class="sbi-result-card" href="/p/' + encodeURIComponent(r.name) + '/">' +
        '<div class="sbi-score">' + pct + '%</div>' +
        '<div class="sbi-result-info"><div class="sbi-result-name">' + r.name.replace(/_/g, ' ') + '</div></div>' +
        '<img class="sbi-result-cover" src="' + valeCoverUrl(r.cover) + '" onerror="this.src=\'' + r.packPng + '\'">' +
      '</a>';
    }).join('');
  }
  detail.innerHTML = html;
  document.getElementById('sbi-back').addEventListener('click', () => {
    window.location.hash = '';
    renderList();
  });
}

function init() {
  renderList();
  const hash = window.location.hash;
  if (hash && /^#\d+$/.test(hash)) showDetail(parseInt(hash.slice(1)) - 1);
  window.addEventListener('hashchange', () => {
    const h = window.location.hash;
    if (!h || h === '#') renderList();
    else if (/^#\d+$/.test(h)) showDetail(parseInt(h.slice(1)) - 1);
  });
}

init();
})();
