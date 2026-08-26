import { notFound } from 'next/navigation'

const RESERVED_SLUGS = ['admin', 'api', 'assets', 'public', 'login', 'suporte', 'faq']

interface PageProps {
  params: Promise<{ slug: string }>
}

export default async function TenantPage({ params }: PageProps) {
  const { slug } = await params

  if (RESERVED_SLUGS.includes(slug)) {
    notFound()
  }

  // TODO: Fetch tenant data from API
  // const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/tenants/${slug}/menu`)
  // if (!response.ok) notFound()
  // const tenant = await response.json()

  return (
    <div style={{ padding: '100px 24px', textAlign: 'center' }}>
      <h1 style={{ fontSize: '32px', marginBottom: '16px' }}>
        Cardápio: {slug}
      </h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '18px' }}>
        Esta página será o cardápio digital do lojista <strong>{slug}</strong>.
      </p>
      <p style={{ color: 'var(--text-faint)', fontSize: '14px', marginTop: '24px' }}>
        Integração com a API será implementada quando o backend estiver disponível.
      </p>
    </div>
  )
}
