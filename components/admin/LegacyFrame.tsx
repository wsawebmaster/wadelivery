'use client'

import { useEffect, useState } from 'react'
import AdminShell from './AdminShell'
import { getApiBaseUrl } from '@/lib/admin-api'

export default function LegacyFrame() {
  const [src, setSrc] = useState('')

  useEffect(() => {
    const base = getApiBaseUrl()
    // Sessão é compartilhada via localStorage (mesmo origin); o legado lê a API
    // base de ?api= para não depender da detecção automática de host.
    setSrc(`/legacy-admin/index.html?api=${encodeURIComponent(base)}`)
  }, [])

  return (
    <AdminShell
      title="Painel completo"
      subtitle="Catálogo, pedidos, banco e ferramentas avançadas"
      actions={
        src ? (
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="wa-btn wa-btn-ghost"
          >
            Abrir em nova aba ↗
          </a>
        ) : null
      }
    >
      <div className="wa-card overflow-hidden p-1" style={{ background: '#fff' }}>
        {src ? (
          <iframe
            title="Painel administrativo completo"
            src={src}
            className="h-[calc(100vh-190px)] w-full rounded-xl border-0 bg-white"
          />
        ) : (
          <div className="grid h-[calc(100vh-190px)] place-items-center text-sm text-[var(--text-muted)]">
            Carregando painel completo…
          </div>
        )}
      </div>
    </AdminShell>
  )
}
