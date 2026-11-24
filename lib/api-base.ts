/**
 * Endereço da API como o navegador deve usar.
 *
 * Em desenvolvimento a API é configurada como `http://localhost:5100`. Quando a página é
 * aberta por outro host (IP da rede, ex.: celular em `http://192.168.15.7:3000`), `localhost`
 * seria o próprio aparelho: troca só o hostname pelo da página, mantendo esquema e porta.
 * Endereços que não são localhost (produção) não mudam.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function browserApiBase(configured: string, pageHostname?: string | null): string {
  const base = configured.trim().replace(/\/$/, '')
  const page = (pageHostname || '').trim().toLowerCase()
  if (!page || LOOPBACK.has(page)) return base
  try {
    const url = new URL(base)
    if (!LOOPBACK.has(url.hostname.toLowerCase())) return base
    url.hostname = page
    return url.toString().replace(/\/$/, '')
  } catch {
    return base
  }
}

/** Hostname (sem porta) de um cabeçalho Host, ex.: "192.168.15.7:3000" → "192.168.15.7". */
export function hostnameFromHostHeader(host?: string | null): string {
  const value = (host || '').trim()
  if (!value) return ''
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1)
  return value.split(':')[0]
}
