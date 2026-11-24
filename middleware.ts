import { NextRequest, NextResponse } from 'next/server'
import { externalStoreRedirect } from '@/lib/external-stores'
import { normalizeHost, resolveTenantSlug } from '@/lib/tenant-resolver'

/**
 * Roteamento multi-tenant por subdomínio (Middleware):
 * - apex (wadelivery.com.br) → roteamento normal (landing `/`) e rota de caminho `/[slug]`;
 * - subdomínio de loja → rewrite interno para `/{slug}` (o cardápio `app/[slug]` renderiza),
 *   mantendo a URL do subdomínio no navegador;
 * - subdomínio sem tenant no catálogo → rewrite para `/{slug}`: a página `[slug]`/SlugPageClient
 *   já renderiza 404 quando o tenant não existe.
 * O Host é a única fonte de resolução (API .NET captura o mesmo valor via cabeçalho host).
 *
 * Lojas que ainda rodam fora da plataforma (Fabin, com FABIN_PUBLIC_URL definida) são
 * redirecionadas para o site real antes de qualquer outra regra.
 */
export function middleware(request: NextRequest) {
  const host = normalizeHost(request.headers.get('host') ?? '')
  const slug = resolveTenantSlug(host)

  const external = externalStoreRedirect(request.nextUrl.pathname, request.nextUrl.searchParams, slug)
  if (external) return NextResponse.redirect(external, 307)

  // Entradas diretas dos apps publicados: só passam pela regra acima, nunca pelo rewrite.
  const path = request.nextUrl.pathname
  if (path.startsWith('/storefront/') || path.startsWith('/legacy-admin/')) return NextResponse.next()

  if (!slug) return NextResponse.next()

  const url = request.nextUrl.clone()
  const base = `/${slug}`
  if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
    url.pathname = `${base}${url.pathname === '/' ? '' : url.pathname}`
  }

  const response = NextResponse.rewrite(url)
  response.headers.set('x-tenant-slug', slug)
  response.headers.set('x-tenant-host', host)
  return response
}

export const config = {
  matcher: [
    // Arquivos estáticos e os apps publicados em public/ (painel e cardápio) não são
    // reescritos para /{slug}: em subdomínio, /legacy-admin/index.html deve continuar
    // apontando para o arquivo, não para /{slug}/legacy-admin/...
    '/((?!_next/static|_next/image|legacy-admin/|storefront/|favicon.ico|icon.svg|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|html|json|webmanifest|map)$).*)',
    // Entradas HTML diretas dos apps (?tenant=): só para o redirecionamento de lojas externas.
    '/storefront/index.html',
    '/legacy-admin/index.html',
  ],
}
