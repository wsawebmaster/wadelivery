/**
 * Lojas que continuam rodando fora do WaDelivery (hoje: Fabin, servida pelo projeto
 * D:\delivery em produção). Com FABIN_PUBLIC_URL definida, qualquer acesso à loja por
 * aqui é redirecionado para o site real — assim nenhum pedido cai no sistema errado e o
 * Google não indexa uma cópia. Sem a variável (desenvolvimento local), nada muda.
 *
 * Redirecionamento temporário (307): quando a loja migrar para a plataforma, basta remover
 * as variáveis — navegadores não guardam o redirecionamento.
 */
const FABIN_SLUG = 'fabin'

function clean(url?: string) {
  const value = (url || '').trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(value) ? value : ''
}

/**
 * Destino externo para a requisição, ou null quando não há redirecionamento.
 * `slugFromHost` = loja resolvida pelo subdomínio (fabin.wadelivery.com.br).
 */
export function externalStoreRedirect(
  pathname: string,
  search: URLSearchParams,
  slugFromHost?: string | null,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const publicUrl = clean(env.FABIN_PUBLIC_URL)
  if (!publicUrl) return null
  const adminUrl = clean(env.FABIN_ADMIN_URL) || publicUrl

  const path = pathname.toLowerCase()
  const tenantParam = (search.get('tenant') || search.get('slug') || '').toLowerCase()

  // Entradas diretas dos apps publicados (prévia, QR de mesa, painel em modo loja).
  if (path.startsWith('/storefront/') && tenantParam === FABIN_SLUG) return withQuery(publicUrl, search)
  if (path.startsWith('/legacy-admin/') && tenantParam === FABIN_SLUG) return adminUrl

  // /fabin, /fabin/... ou subdomínio fabin.*
  const viaPath = path === `/${FABIN_SLUG}` || path.startsWith(`/${FABIN_SLUG}/`)
  const viaHost = (slugFromHost || '').toLowerCase() === FABIN_SLUG
  if (!viaPath && !viaHost) return null

  const rest = viaPath ? path.slice(FABIN_SLUG.length + 1) : path
  if (rest === '/admin' || rest.startsWith('/admin/')) return adminUrl
  return withQuery(publicUrl, search)
}

/** Mantém parâmetros úteis (ex.: ?mesa= do QR) e descarta os internos (tenant/slug/api). */
function withQuery(base: string, search: URLSearchParams) {
  const params = new URLSearchParams(search)
  for (const key of ['tenant', 'slug', 'api']) params.delete(key)
  const qs = params.toString()
  return qs ? `${base}/?${qs}` : `${base}/`
}
