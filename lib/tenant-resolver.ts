import { KNOWN_TENANT_HOSTS, PRIMARY_DOMAIN, RESERVED_SLUGS } from './tenant-hosts'

/**
 * Normaliza o Host para comparação: minúsculo, sem protocolo, sem porta e sem "www.".
 * Edge-safe (apenas string/regex).
 */
export function normalizeHost(host: string): string {
  let h = (host || '').trim().toLowerCase()
  const slash = h.indexOf('/')
  if (slash !== -1) h = h.slice(0, slash)
  h = h.replace(/:\d+$/, '')
  if (h.startsWith('www.')) h = h.slice(4)
  return h
}

/** true quando o host é o domínio raiz (landing + rotas de caminho /{slug}). */
export function isApexHost(host: string): boolean {
  const h = normalizeHost(host)
  return !h || h === PRIMARY_DOMAIN
}

/**
 * Resolve o slug do tenant a partir do Host:
 * 1) casamento exato em KNOWN_TENANT_HOSTS (suporta multi-label, ex. gota.acai.wadelivery.com.br);
 * 2) fallback: 1º rótulo de *.wadelivery.com.br (nomedaloja.wadelivery.com.br);
 * 3) apex/desconhecido → null (nenhum tenant).
 * Slugs reservados nunca são resolvidos.
 */
export function resolveTenantSlug(host: string): string | null {
  const h = normalizeHost(host)
  if (isApexHost(h)) return null

  const mapped = KNOWN_TENANT_HOSTS[h]
  if (mapped) return RESERVED_SLUGS.includes(mapped) ? null : mapped

  if (!h.endsWith(`.${PRIMARY_DOMAIN}`)) return null
  const label = h.slice(0, h.length - PRIMARY_DOMAIN.length - 1)
  if (!label || label.includes('.')) return null
  return RESERVED_SLUGS.includes(label) ? null : label
}