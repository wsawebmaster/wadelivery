import type { NextRequest } from 'next/server'
import { resolvePublicTenant } from '@/lib/public-tenant'
import { RESERVED_SLUGS } from '@/lib/tenant-hosts'
import { browserApiBase, hostnameFromHostHeader } from '@/lib/api-base'
import { externalStoreRedirect } from '@/lib/external-stores'
import { escapeHtml, renderStorefrontPage, type SsrCategory, type SsrStore } from '@/lib/storefront-ssr'

/**
 * Página pública da loja (/{slug}) entregue pelo servidor, sem iframe: o cardápio do
 * storefront com SEO (título, descrição, Open Graph, dados estruturados) e os produtos já
 * no HTML. O JavaScript do cardápio continua cuidando de carrinho, checkout, mesa e
 * acompanhamento. /storefront/index.html?tenant= segue funcionando (prévia, QR de mesa).
 */
export const dynamic = 'force-dynamic'

const REVALIDATE_SECONDS = 60

function apiBase(): string {
  return (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:5100').replace(/\/$/, '')
}

/** Base da API nas URLs do HTML (imagens, Open Graph); localhost vira o host da página (celular na rede). */
function apiPublicBase(pageHost?: string | null): string {
  const configured = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || 'http://localhost:5100'
  return browserApiBase(configured, hostnameFromHostHeader(pageHost))
}

function htmlResponse(body: string, status: number, cache = 'no-store') {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cache },
  })
}

function simplePage(title: string, message: string, link: { href: string, label: string }, status: number) {
  return htmlResponse(
    `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
    `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0;text-align:center;padding:24px}` +
    `a{display:inline-block;margin-top:16px;padding:12px 22px;border-radius:10px;background:#1f6feb;color:#fff;text-decoration:none;font-weight:700}</style></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></main></body></html>`,
    status,
  )
}

async function fetchJson<T>(url: string, slug: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'X-Tenant-Slug': slug }, next: { revalidate: REVALIDATE_SECONDS } })
    return res.ok ? ((await res.json()) as T) : null
  } catch {
    return null
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params
  const slug = rawSlug.toLowerCase()
  // Loja que ainda roda fora da plataforma (Fabin): vai para o site real (o middleware já faz;
  // aqui é a segunda camada caso a rota seja alcançada sem ele).
  const external = externalStoreRedirect(`/${slug}`, request.nextUrl.searchParams)
  if (external) return Response.redirect(external, 307)
  if (RESERVED_SLUGS.includes(slug) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return simplePage('Cardápio não encontrado', 'Verifique o link e tente novamente.', { href: '/', label: 'Voltar para a página inicial' }, 404)
  }

  const lookup = await resolvePublicTenant(slug)
  if (lookup.status === 'not-found') {
    return simplePage('Cardápio não encontrado', 'Verifique o link e tente novamente.', { href: '/', label: 'Voltar para a página inicial' }, 404)
  }
  if (lookup.status !== 'found') {
    return simplePage('Não foi possível carregar o cardápio', 'A API está indisponível no momento. Tente novamente em instantes.', { href: `/${slug}`, label: 'Tentar novamente' }, 503)
  }

  const tenantSlug = lookup.tenant.slug
  const origin = request.nextUrl.origin
  const [indexRes, store, catalog] = await Promise.all([
    fetch(new URL('/storefront/index.html', origin), { next: { revalidate: REVALIDATE_SECONDS } }).catch(() => null),
    fetchJson<SsrStore>(`${apiBase()}/api/v1/store`, tenantSlug),
    fetchJson<{ categories?: SsrCategory[] }>(`${apiBase()}/api/v1/catalog`, tenantSlug),
  ])
  if (!indexRes || !indexRes.ok) {
    return simplePage('Não foi possível carregar o cardápio', 'Tente novamente em instantes.', { href: `/${slug}`, label: 'Tentar novamente' }, 503)
  }

  const publicBase = (process.env.PUBLIC_APP_BASE_URL || origin).replace(/\/$/, '')
  const html = renderStorefrontPage(await indexRes.text(), {
    slug: tenantSlug,
    pageUrl: `${publicBase}/${tenantSlug}`,
    apiPublicBase: apiPublicBase(request.headers.get('x-forwarded-host') || request.headers.get('host')),
    store: { ...(store || {}), storeName: store?.storeName || lookup.tenant.name, active: lookup.tenant.active },
    categories: catalog?.categories || [],
    segment: lookup.tenant.segment,
  })
  // Cache curto no CDN: preços/horários mudam pelo painel; o app atualiza os dados ao vivo.
  return htmlResponse(html, 200, `public, s-maxage=${REVALIDATE_SECONDS}, stale-while-revalidate=300`)
}
