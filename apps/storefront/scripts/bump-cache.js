/**
 * Incrementa a versão de cache do storefront (sw.js + query strings no index.html).
 * Uso: node scripts/bump-cache.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const swPath = path.join(root, 'sw.js');
const indexPath = path.join(root, 'index.html');

const sw = fs.readFileSync(swPath, 'utf8');
const swMatch = sw.match(/fabin-lanches-v(\d+)/);
if (!swMatch) {
  console.error('[bump-cache] CACHE_NAME não encontrado em sw.js');
  process.exit(1);
}
const next = Number(swMatch[1]) + 1;
fs.writeFileSync(swPath, sw.replace(/fabin-lanches-v\d+/, `fabin-lanches-v${next}`), 'utf8');

let index = fs.readFileSync(indexPath, 'utf8');
index = index
  .replace(/(style\.css\?v=)\d+/, `$1${next}`)
  .replace(/(script\.js\?v=)\d+/, `$1${next}`);
fs.writeFileSync(indexPath, index, 'utf8');

console.log(`[bump-cache] cache → v${next}`);
