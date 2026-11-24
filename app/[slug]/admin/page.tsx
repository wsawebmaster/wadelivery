import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import StoreAdminFrame from '@/components/admin/StoreAdminFrame'
import { resolvePublicTenant } from '@/lib/public-tenant'
import { RESERVED_SLUGS } from '@/lib/tenant-hosts'

export const dynamicParams = true

interface PageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const lookup = await resolvePublicTenant(slug)
  return {
    title: lookup.status === 'found' ? `Painel — ${lookup.tenant.name}` : 'Painel da loja — WaDelivery',
    robots: { index: false, follow: false },
  }
}

/** Painel do proprietário da loja: /{slug}/admin. A plataforma (todas as lojas) fica em /admin. */
export default async function StoreAdminPage({ params }: PageProps) {
  const { slug } = await params
  if (RESERVED_SLUGS.includes(slug.toLowerCase())) notFound()

  const lookup = await resolvePublicTenant(slug)
  if (lookup.status === 'not-found') notFound()
  if (lookup.status !== 'found') {
    return (
      <main className="tenant-api-error" role="alert">
        <h1>Não foi possível carregar o painel</h1>
        <p>A API está indisponível no momento. Tente novamente em instantes.</p>
        <a href={`/${encodeURIComponent(slug)}/admin`}>Tentar novamente</a>
      </main>
    )
  }

  return <StoreAdminFrame slug={lookup.tenant.slug} storeName={lookup.tenant.name} />
}
