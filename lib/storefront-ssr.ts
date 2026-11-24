/**
 * Renderização no servidor da página pública da loja (/{slug}).
 *
 * O cardápio continua sendo o app em apps/storefront (publicado em /storefront). Estas funções
 * só preparam o HTML que o servidor entrega: SEO (título, descrição, canônica, Open Graph),
 * dados estruturados Restaurant/Menu e a lista de produtos já no HTML, para buscadores e
 * prévias de link. O JavaScript do cardápio assume a página em seguida (carrinho, checkout,
 * mesa, acompanhamento) exatamente como antes.
 */

export interface SsrStore {
  storeName?: string
  whatsapp?: string
  address?: string | null
  addressNumber?: string | null
  city?: string | null
  state?: string | null
  cep?: string | null
  logoUrl?: string | null
  coverUrl?: string | null
  bannerUrl?: string | null
  active?: boolean
  schedule?: {
    perDay?: Array<{ day: number, enabled: boolean, open?: string, close?: string }>
    days?: number[]
    open?: string
    close?: string
  } | null
}

export interface SsrProduct {
  id: string
  name: string
  price: number
  description?: string | null
  imageUrl?: string | null
  available?: boolean
  showInMenu?: boolean
  ingredients?: Array<{ name?: string }> | null
}

export interface SsrCategory {
  id: string
  title: string
  showInMenu?: boolean
  items?: SsrProduct[]
}

export interface SsrPageInput {
  slug: string
  pageUrl: string
  apiPublicBase: string
  store: SsrStore
  categories: SsrCategory[]
  segment?: string | null
}

const SCHEMA_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SEGMENT_CUISINE: Record<string, string> = {
  lanchonete: 'Lanches',
  hamburgueria: 'Hambúrguer artesanal',
  pizzaria: 'Pizza',
  marmitaria: 'Marmitas e comida caseira',
  assai: 'Açaí',
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** JSON seguro dentro de <script>: impede fechar a tag com "</script>". */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
}

export function formatBrl(value: number): string {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** URL absoluta de imagem: uploads ficam na API; caminhos absolutos/https passam direto. */
export function absoluteAssetUrl(url: string | null | undefined, apiPublicBase: string, pageUrl: string): string | null {
  const value = String(url ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  if (value.startsWith('/uploads/')) return `${apiPublicBase.replace(/\/$/, '')}${value}`
  try {
    return new URL(value, pageUrl).href
  } catch {
    return null
  }
}

/** Categorias e produtos visíveis no cardápio público (mesmas regras de exibição do app). */
export function visibleCategories(categories: SsrCategory[]): SsrCategory[] {
  return (categories || [])
    .filter((c) => c && c.showInMenu !== false && !/^(ingredientes?|adicionais?|opcionais?)$/i.test(String(c.title || '').trim()))
    .map((c) => ({
      ...c,
      items: (c.items || []).filter((i) => i && i.showInMenu !== false && i.available !== false),
    }))
    .filter((c) => (c.items || []).length > 0)
}

function productDescription(p: SsrProduct): string {
  const ingredients = (p.ingredients || []).map((i) => i?.name).filter(Boolean) as string[]
  if (ingredients.length) return ingredients.join(', ')
  return String(p.description || '').trim()
}

export function storeAddressLine(store: SsrStore): string {
  const street = [store.address, store.addressNumber].filter(Boolean).join(', ')
  const city = [store.city, store.state].filter(Boolean).join('/')
  return [street, city].filter(Boolean).join(' — ')
}

export function buildMetaDescription(input: SsrPageInput): string {
  const name = input.store.storeName || input.slug
  const cats = visibleCategories(input.categories).slice(0, 4).map((c) => c.title.toLowerCase())
  const where = [input.store.city, input.store.state].filter(Boolean).join('/')
  const parts = [
    `Cardápio online de ${name}${where ? ` em ${where}` : ''}.`,
    cats.length ? `Peça ${cats.join(', ')} com entrega ou retirada.` : 'Peça com entrega ou retirada.',
    'Pedido rápido pelo WhatsApp.',
  ]
  return parts.join(' ').slice(0, 300)
}

/** Horário no formato schema.org a partir do horário por dia da loja. */
export function openingHours(store: SsrStore) {
  const schedule = store.schedule
  const perDay = schedule?.perDay?.length
    ? schedule.perDay
    : (schedule?.days || []).map((day) => ({ day, enabled: true, open: schedule?.open, close: schedule?.close }))
  return perDay
    .filter((d) => d.enabled && d.open && d.close && SCHEMA_DAYS[d.day])
    .map((d) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: `https://schema.org/${SCHEMA_DAYS[d.day]}`,
      opens: d.open,
      closes: d.close,
    }))
}

export function buildStructuredData(input: SsrPageInput) {
  const { store } = input
  const image = absoluteAssetUrl(store.logoUrl || store.coverUrl || store.bannerUrl, input.apiPublicBase, input.pageUrl)
  const cuisine = SEGMENT_CUISINE[String(input.segment || '').toLowerCase()]
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: store.storeName || input.slug,
    url: input.pageUrl,
    acceptsReservations: false,
    hasMenu: {
      '@type': 'Menu',
      name: `Cardápio ${store.storeName || ''}`.trim(),
      hasMenuSection: visibleCategories(input.categories).map((c) => ({
        '@type': 'MenuSection',
        name: c.title,
        hasMenuItem: (c.items || []).map((p) => ({
          '@type': 'MenuItem',
          name: p.name,
          ...(productDescription(p) ? { description: productDescription(p) } : {}),
          ...(absoluteAssetUrl(p.imageUrl, input.apiPublicBase, input.pageUrl)
            ? { image: absoluteAssetUrl(p.imageUrl, input.apiPublicBase, input.pageUrl) }
            : {}),
          offers: { '@type': 'Offer', price: Number(p.price || 0).toFixed(2), priceCurrency: 'BRL' },
        })),
      })),
    },
  }
  if (image) data.image = image
  if (cuisine) data.servesCuisine = cuisine
  if (store.whatsapp) {
    // WhatsApp salvo só com DDD (10–11 dígitos) ganha o código do Brasil.
    const digits = String(store.whatsapp).replace(/\D/g, '')
    data.telephone = `+${digits.length <= 11 ? `55${digits}` : digits}`
  }
  if (store.city || store.address) {
    data.address = {
      '@type': 'PostalAddress',
      ...(store.address ? { streetAddress: [store.address, store.addressNumber].filter(Boolean).join(', ') } : {}),
      ...(store.city ? { addressLocality: store.city } : {}),
      ...(store.state ? { addressRegion: store.state } : {}),
      ...(store.cep ? { postalCode: store.cep } : {}),
      addressCountry: 'BR',
    }
  }
  const hours = openingHours(store)
  if (hours.length) data.openingHoursSpecification = hours
  return data
}

/**
 * Imagem de compartilhamento: capa, banner, logo ou a primeira foto de produto.
 * SVG fica de fora (logo padrão do cadastro): WhatsApp/Facebook não exibem SVG em og:image.
 */
function shareImageUrl(input: SsrPageInput): string | null {
  const raster = (url?: string | null) => {
    const value = String(url ?? '').trim()
    return value && !/\.svg(\?|#|$)/i.test(value) ? value : null
  }
  const productPhoto = visibleCategories(input.categories)
    .flatMap((c) => c.items || [])
    .map((p) => raster(p.imageUrl))
    .find(Boolean)
  return raster(input.store.coverUrl) || raster(input.store.bannerUrl) || raster(input.store.logoUrl) || productPhoto || null
}

/** Tags de <head>: título, descrição, canônica, Open Graph/Twitter e JSON-LD. */
export function buildHeadTags(input: SsrPageInput): string {
  const name = input.store.storeName || input.slug
  const title = `${name} — Cardápio Delivery`
  const description = buildMetaDescription(input)
  const image = absoluteAssetUrl(shareImageUrl(input), input.apiPublicBase, input.pageUrl)
  const robots = input.store.active === false ? 'noindex, follow' : 'index, follow'
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="robots" content="${robots}">`,
    `<link rel="canonical" href="${escapeHtml(input.pageUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:locale" content="pt_BR">`,
    `<meta property="og:site_name" content="${escapeHtml(name)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(input.pageUrl)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    image ? `<meta name="twitter:image" content="${escapeHtml(image)}">` : '',
    `<script type="application/ld+json">${jsonForScript(buildStructuredData(input))}</script>`,
  ].filter(Boolean).join('\n    ')
}

/** Produtos já no HTML (o app substitui este conteúdo ao carregar). */
export function buildMenuHtml(input: SsrPageInput): string {
  return visibleCategories(input.categories).map((c) =>
    `<section class="category-page ssr-menu" aria-label="${escapeHtml(c.title)}">` +
    `<h2 class="category-section-title">${escapeHtml(c.title)}</h2>` +
    (c.items || []).map((p) => {
      const description = productDescription(p)
      return `<article class="menu-item"><strong class="item-name">${escapeHtml(p.name)}</strong>` +
        (description ? `<p class="item-description">${escapeHtml(description)}</p>` : '') +
        `<span class="item-price">${escapeHtml(formatBrl(p.price))}</span></article>`
    }).join('') +
    `</section>`).join('')
}

/**
 * Injeta no index.html do storefront: <base> para os assets relativos, a loja da URL
 * (antes do api-config.js), as tags de SEO no lugar das genéricas e o cardápio no #menu.
 */
export function renderStorefrontPage(indexHtml: string, input: SsrPageInput): string {
  let html = indexHtml
  // Remove título/descrição/OG genéricos do template (são da Fabin).
  html = html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, '')
    .replace(/<meta\s+name="description"[^>]*>\s*/gi, '')
    .replace(/<meta\s+property="og:[^"]*"[^>]*>\s*/gi, '')
  html = html.replace(
    /<meta charset="UTF-8">/i,
    `<meta charset="UTF-8">\n    <base href="/storefront/">\n    ${buildHeadTags(input)}`,
  )
  html = html.replace(
    /<script src="assets\/script\/api-config\.js/i,
    `<script>window.WA_TENANT_SLUG = ${jsonForScript(input.slug)};</script>\n<script src="assets/script/api-config.js`,
  )
  html = html.replace(
    /(<section id="menu"[^>]*>)(<\/section>)/i,
    `$1${buildMenuHtml(input)}$2`,
  )
  const name = input.store.storeName
  if (name) {
    html = html.replace(/(<div class="barra-topo-brand">\s*<h3>)[^<]*(<\/h3>)/i, `$1${escapeHtml(name.toUpperCase())}$2`)
  }
  return html
}
