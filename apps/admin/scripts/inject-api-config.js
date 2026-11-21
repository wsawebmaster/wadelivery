/**
 * Injeta API_BASE_URL no api-config.js (uso na Vercel / CI).
 * Local sem a env: não altera o arquivo.
 */
const fs = require('fs');
const path = require('path');

const marker = '__API_BASE_URL__';
const target = path.join(__dirname, '..', 'api-config.js');
const raw = (process.env.API_BASE_URL || '').trim().replace(/\/$/, '');
const onVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

if (!raw) {
  if (onVercel) {
    console.error(
      '[inject-api-config] Defina a variável de ambiente API_BASE_URL (ex.: https://sua-api.up.railway.app).'
    );
    process.exit(1);
  }
  console.log('[inject-api-config] API_BASE_URL vazia — mantendo api-config.js local.');
  process.exit(0);
}

if (!/^https?:\/\//i.test(raw)) {
  console.error('[inject-api-config] API_BASE_URL deve começar com http:// ou https://');
  process.exit(1);
}

if (onVercel && !/^https:\/\//i.test(raw)) {
  console.error('[inject-api-config] Em produção (Vercel) use HTTPS na API_BASE_URL.');
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');
if (!source.includes(marker)) {
  console.error('[inject-api-config] Marcador', marker, 'não encontrado em', target);
  process.exit(1);
}

const safe = raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
source = source.replace(marker, safe);
fs.writeFileSync(target, source, 'utf8');
console.log('[inject-api-config] API_BASE_URL injetada:', raw);
