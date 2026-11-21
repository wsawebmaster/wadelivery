import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const sourceDir = join(repoRoot, 'apps', 'storefront')
const destinationDir = join(repoRoot, 'public', 'storefront')
const onVercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true'
const apiBaseUrl = (process.env.API_BASE_URL || '').trim().replace(/\/$/, '')

if (!existsSync(join(sourceDir, 'index.html'))) {
  throw new Error('[sync-storefront] apps/storefront/index.html não foi encontrado.')
}

if (onVercel && !apiBaseUrl) {
  throw new Error('[sync-storefront] Defina API_BASE_URL para o deploy na Vercel.')
}

if (apiBaseUrl && !/^https?:\/\//i.test(apiBaseUrl)) {
  throw new Error('[sync-storefront] API_BASE_URL deve começar com http:// ou https://.')
}

if (onVercel && !/^https:\/\//i.test(apiBaseUrl)) {
  throw new Error('[sync-storefront] Em produção, API_BASE_URL deve usar HTTPS.')
}

rmSync(destinationDir, { recursive: true, force: true })
mkdirSync(destinationDir, { recursive: true })

for (const file of ['index.html', 'manifest.json', 'sw.js']) {
  cpSync(join(sourceDir, file), join(destinationDir, file))
}

cpSync(join(sourceDir, 'assets'), join(destinationDir, 'assets'), { recursive: true })

if (apiBaseUrl) {
  const configPath = join(destinationDir, 'assets', 'script', 'api-config.js')
  const marker = '__API_BASE_URL__'
  const config = readFileSync(configPath, 'utf8')

  if (!config.includes(marker)) {
    throw new Error(`[sync-storefront] Marcador ${marker} não encontrado em api-config.js.`)
  }

  const safeUrl = apiBaseUrl.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  writeFileSync(configPath, config.replace(marker, safeUrl), 'utf8')
}

console.log('[sync-storefront] apps/storefront copiado para public/storefront.')
