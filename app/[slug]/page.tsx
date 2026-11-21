import { notFound } from 'next/navigation'
import { getTenantBySlug } from '@/lib/mock-data'
import { RESERVED_SLUGS } from '@/lib/tenant-hosts'
import { resolvePublicTenant } from '@/lib/public-tenant'
import { SlugPageClient } from './slug-page-client'

export const dynamicParams = true
export const revalidate = 60

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function TenantPage({ params }: PageProps) {
  const { slug } = await params

  if (RESERVED_SLUGS.includes(slug.toLowerCase())) {
    notFound()
  }

  if (slug === 'fabin') {
    return (
      <iframe
        className="fabin-storefront-frame"
        src="/storefront/index.html?tenant=fabin"
        title="Cardápio digital Fabin Lanches"
      />
    )
  }

  const lookup = await resolvePublicTenant(slug)
  if (lookup.status === 'found') {
    return (
      <iframe
        className="fabin-storefront-frame"
        src={`/storefront/index.html?tenant=${encodeURIComponent(lookup.tenant.slug)}`}
        title={`Cardápio digital ${lookup.tenant.name}`}
      />
    )
  }

  const demoTenant = getTenantBySlug(slug)
  if (demoTenant) return <SlugPageClient tenant={demoTenant} />
  if (lookup.status === 'not-found') notFound()

  return (
    <main className="tenant-api-error" role="alert">
      <h1>Não foi possível carregar o cardápio</h1>
      <p>A API está indisponível no momento. Tente novamente em instantes.</p>
      <a href={`/${encodeURIComponent(slug)}`}>Tentar novamente</a>
    </main>
  )
}
