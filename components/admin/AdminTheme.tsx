'use client'

import { useEffect } from 'react'

/**
 * O painel /admin é sempre escuro (marca WaDelivery). Força `data-theme="dark"`
 * enquanto montado e restaura a preferência do usuário ao sair do painel.
 */
export default function AdminTheme({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute('data-theme')
    root.setAttribute('data-theme', 'dark')
    return () => {
      if (previous) root.setAttribute('data-theme', previous)
      else root.removeAttribute('data-theme')
    }
  }, [])

  return <div className="wa-app">{children}</div>
}
