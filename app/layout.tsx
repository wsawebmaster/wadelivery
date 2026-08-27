import type { Metadata, Viewport } from 'next'
import { Inter, Sora } from 'next/font/google'
import { ThemeProvider } from '@/lib/theme-context'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const sora = Sora({
  subsets: ['latin'],
  variable: '--font-head',
  display: 'swap',
})

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0a0f1e' },
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
  ],
}

export const metadata: Metadata = {
  title: 'Delivery sem comissão — Sua própria loja digital',
  description:
    'Plataforma de delivery completa para restaurantes, hamburguerias e lanchonetes. Cardápio digital próprio sem comissão, rastreamento de pedidos em tempo real e painel de gestão. Experimente grátis.',
  openGraph: {
    title: 'Delivery sem comissão — Sua própria loja digital',
    description:
      'Cardápio digital, pedidos em tempo real e gestão completa. Sem taxas abusivas, sem depender de terceiros. Experimente gratuitamente.',
    type: 'website',
    locale: 'pt_BR',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${sora.variable}`} suppressHydrationWarning>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
