'use client'

import { useEffect, useState } from 'react'
import { getApiBaseUrl } from '@/lib/admin-api'

interface StoreAdminFrameProps {
  slug: string
  storeName: string
}

/**
 * Painel operacional da loja em tela cheia (/{slug}/admin). O painel legado entra em
 * "modo loja" com ?tenant=: sessão própria desta loja, X-Tenant-Slug em todas as
 * chamadas e login recusado para usuários de outra loja.
 */
export default function StoreAdminFrame({ slug, storeName }: StoreAdminFrameProps) {
  const [src, setSrc] = useState('')

  useEffect(() => {
    const params = new URLSearchParams({ tenant: slug, api: getApiBaseUrl() })
    setSrc(`/legacy-admin/index.html?${params.toString()}`)
  }, [slug])

  if (!src) {
    return (
      <main className="tenant-api-error" aria-busy="true">
        <p>Carregando painel da loja…</p>
      </main>
    )
  }

  return (
    <iframe
      className="fabin-storefront-frame"
      src={src}
      title={`Painel da loja ${storeName}`}
    />
  )
}
