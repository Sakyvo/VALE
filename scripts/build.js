const fs = require('fs');
const path = require('path');

// Generate pack subdirectories from pack.html template
const indexPath = 'data/index.json';
if (fs.existsSync(indexPath)) {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const packHtml = fs.readFileSync('pack.html', 'utf-8');

  fs.mkdirSync('p', { recursive: true });
  const routes = new Set(index.items.map(pack => pack.name));
  // Retained legacy routes use the same shell and must share its cache versions.
  for (const name of fs.readdirSync('p')) {
    if (fs.existsSync(path.join('p', name, 'index.html'))) routes.add(name);
  }
  for (const name of routes) {
    const packDir = path.join('p', name);
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'index.html'), packHtml);
  }
  console.log(`Generated ${routes.size} pack routes (${index.items.length} catalog entries).`);
}

console.log('Build complete.');