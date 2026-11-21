export interface PublicTenant {
  storeId: number
  slug: string
  name: string
  status: string
  active: boolean
  acceptingOrders: boolean
  logoUrl: string | null
  iconUrl: string | null
  segment: string | null
  currencyLocale: string
  corPrimaria: string | null
  corSecundaria: string | null
  corFundo: string | null
  corTexto: string | null
  tipoCard: string | null
  layoutCardapio: string | null
  estiloBotao: string | null
  bannerUrl: string | null
  coverUrl: string | null
}

export type PublicTenantLookup =
  | { status: 'found'; tenant: PublicTenant }
  | { status: 'not-found' }
  | { status: 'unavailable' }

function isPublicTenant(value: unknown): value is PublicTenant {
  if (typeof value !== 'object' || value === null) return false
  const tenant = value as Record<string, unknown>
  return typeof tenant.storeId === 'number'
    && typeof tenant.slug === 'string'
    && typeof tenant.name === 'string'
    && typeof tenant.active === 'boolean'
    && typeof tenant.acceptingOrders === 'boolean'
}

export async function resolvePublicTenant(slug: string): Promise<PublicTenantLookup> {
  const apiBase = (
    process.env.NEXT_PUBLIC_API_BASE_URL
    || process.env.API_BASE_URL
    || 'http://localhost:5100'
  ).replace(/\/$/, '')

  try {
    const response = await fetch(
      `${apiBase}/api/lojas/slug/${encodeURIComponent(slug)}`,
      { next: { revalidate: 60 } },
    )
    if (response.status === 404) return { status: 'not-found' }
    if (!response.ok) return { status: 'unavailable' }
    const tenant: unknown = await response.json()
    if (!isPublicTenant(tenant) || tenant.slug.toLowerCase() !== slug.toLowerCase()) {
      return { status: 'unavailable' }
    }
    return { status: 'found', tenant }
  } catch {
    return { status: 'unavailable' }
  }
}
