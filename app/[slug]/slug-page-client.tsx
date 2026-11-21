'use client'

import { useState } from 'react'
import { CartProvider, useCart } from './cart-context'
import { MenuPage } from './menu-page'
import { CartModal } from './cart-modal'
import { CheckoutModal } from './checkout-modal'
import { OrderTrack } from './order-track'
import { SegmentProvider } from './segment-provider'
import { mockCategories, mockProducts } from '@/lib/mock-data'
import type { Tenant } from '@/lib/types'

interface SlugPageClientProps {
  tenant: Tenant | null
}

function SlugPageInner({ tenant }: { tenant: Tenant }) {
  const { items, total } = useCart()
  const [cartOpen, setCartOpen] = useState(false)
  const [checkoutOpen, setCheckoutOpen] = useState(false)
  const [orderVisible, setOrderVisible] = useState(false)

  return (
    <>
      <MenuPage
        tenant={tenant}
        categories={mockCategories}
        products={mockProducts}
        onOpenCart={() => setCartOpen(true)}
      />

      <CartModal
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        onCheckout={() => {
          setCartOpen(false)
          setCheckoutOpen(true)
        }}
      />

      <CheckoutModal
        open={checkoutOpen}
        onClose={() => setCheckoutOpen(false)}
        onBackToCart={() => {
          setCheckoutOpen(false)
          setCartOpen(true)
        }}
        onOrderConfirmed={() => {
          setCheckoutOpen(false)
          setOrderVisible(true)
        }}
        tenant={tenant}
      />

      <OrderTrack
        visible={orderVisible}
        onClose={() => setOrderVisible(false)}
        items={items}
        total={total}
      />
    </>
  )
}

export function SlugPageClient({ tenant }: SlugPageClientProps) {
  if (!tenant) {
    return (
      <div style={{ padding: '100px 24px', textAlign: 'center' }}>
        <h1 style={{ fontSize: '48px', marginBottom: '16px' }}>404</h1>
        <p style={{ color: 'var(--menu-text-muted)', fontSize: '18px', marginBottom: '24px' }}>
          Cardápio não encontrado.
        </p>
        <a
          href="/"
          style={{
            display: 'inline-flex',
            padding: '12px 24px',
            borderRadius: 'var(--seg-radius)',
            background: 'var(--seg-primary)',
            color: '#fff',
            fontWeight: 700,
            textDecoration: 'none',
          }}
        >
          Voltar ao início
        </a>
      </div>
    )
  }

  return (
    <SegmentProvider segment={tenant.segment}>
      <CartProvider slug={tenant.slug}>
        <SlugPageInner tenant={tenant} />
      </CartProvider>
    </SegmentProvider>
  )
}
