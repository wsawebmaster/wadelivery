// Sincroniza o painel administrativo legado (apps/admin) para
// apps/wadelivery/public/legacy-admin, servindo-o no mesmo origin do novo
// painel React em /admin (iframe /admin/legado) e compartilhando a sessão JWT.
//
// Uso:
//   node scripts/sync-legacy-admin.mjs
//   npm run sync:legacy
//
// Roda antes de `dev`/`build`. Se a origem (apps/admin) não existir — como em
// builds isolados da Vercel — mantém a cópia já versionada em public/legacy-admin.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

const sourceDir = resolve(repoRoot, 'apps', 'admin')
const destDir = join(repoRoot, 'public', 'legacy-admin')

const FILES = ['index.html', 'app.js', 'styles.css', 'escpos.js', 'serialpos.js', 'api-config.js']
const DIRS = ['assets']

function sanitizeLegacyAdminApp() {
  const appJsPath = join(destDir, 'app.js')
  if (!existsSync(appJsPath)) {
    throw new Error('[sync-legacy-admin] app.js não encontrado na cópia pública.')
  }

  const appJs = readFileSync(appJsPath, 'utf8')
  const devProfilesPattern = /const DEV_PROFILES\s*=\s*\{[\s\S]*?\};/
  const sanitizedAppJs = appJs.replace(devProfilesPattern, 'const DEV_PROFILES = {};')
  if (sanitizedAppJs === appJs && !devProfilesPattern.test(appJs)) {
    throw new Error('[sync-legacy-admin] Não foi possível sanitizar os perfis locais.')
  }
  if (/\bpassword\s*:\s*['"][^'"]+['"]/i.test(sanitizedAppJs)) {
    throw new Error('[sync-legacy-admin] A cópia pública ainda contém senha literal.')
  }

  writeFileSync(appJsPath, sanitizedAppJs)
}

if (!existsSync(join(sourceDir, 'index.html'))) {
  console.log('[sync-legacy-admin] origem não encontrada em apps/admin — mantendo cópia versionada.')
  sanitizeLegacyAdminApp()
  process.exit(0)
}

rmSync(destDir, { recursive: true, force: true })
mkdirSync(destDir, { recursive: true })

for (const file of FILES) {
  cpSync(join(sourceDir, file), join(destDir, file))
}

for (const dir of DIRS) {
  cpSync(join(sourceDir, dir), join(destDir, dir), { recursive: true })
}

sanitizeLegacyAdminApp()

// Injeta, no topo do api-config.js, o suporte a ?api=<URL> (definido pelo
// painel React) e a substituição opcional do placeholder por LEGACY_API_BASE_URL.
const apiConfigPath = join(destDir, 'api-config.js')
let apiConfig = readFileSync(apiConfigPath, 'utf8')

const shim =
  '/* legacy-admin: API base definida por /admin via ?api= */\n' +
  '(function () {\n' +
  "  try {\n" +
  "    var q = new URLSearchParams(window.location.search).get('api');\n" +
  '    if (q) window.API_BASE_URL = String(q).replace(/\\/$/, \'\');\n' +
  '  } catch (_) { /* ignore */ }\n' +
  '})();\n'

const injected = process.env.LEGACY_API_BASE_URL
if (injected) {
  apiConfig = apiConfig.replace('__API_BASE_URL__', String(injected).replace(/\/$/, ''))
}

writeFileSync(apiConfigPath, shim + apiConfig)

console.log(`[sync-legacy-admin] copiado apps/admin → public/legacy-admin (${FILES.length} arquivos + ${DIRS.length} pasta).`)
