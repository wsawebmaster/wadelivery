import type { Metadata, Viewport } from 'next'
import { Roboto } from 'next/font/google'
import { getTenantBySlug } from '@/lib/mock-data'
import { resolvePublicTenant } from '@/lib/public-tenant'
import '@/styles/segments.css'
import '@/styles/menu.css'
import '@/styles/cart.css'

const roboto = Roboto({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-roboto',
  display: 'swap',
})

interface SlugLayoutProps {
  children: React.ReactNode
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: SlugLayoutProps): Promise<Metadata> {
  const { slug } = await params
  const lookup = slug === 'fabin' ? null : await resolvePublicTenant(slug)
  const tenant = lookup?.status === 'found' ? lookup.tenant : getTenantBySlug(slug)

  if (!tenant) {
    return { title: 'Cardápio não encontrado' }
  }

  return {
    title: `${tenant.name} — Cardápio Delivery`,
    description: `Cardápio digital da ${tenant.name}. Peça agora pelo WhatsApp.`,
    openGraph: {
      title: `${tenant.name} — Cardápio Delivery`,
      description: `Cardápio digital da ${tenant.name}. Peça agora pelo WhatsApp.`,
      type: 'website',
      locale: 'pt_BR',
    },
  }
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1e' },
    { media: '(prefers-color-scheme: light)', color: '#f3f4f6' },
  ],
  width: 'device-width',
  initialScale: 1,
}

export default async function SlugLayout({ children, params }: SlugLayoutProps) {
  const { slug } = await params
  const lookup = slug === 'fabin' ? null : await resolvePublicTenant(slug)
  const demoTenant = getTenantBySlug(slug)
  const segment = (lookup?.status === 'found' ? lookup.tenant.segment : demoTenant?.segment) ?? 'lanchonete'

  return (
    <div className={roboto.variable} data-segment={segment}>
      {children}
    </div>
  )
}
