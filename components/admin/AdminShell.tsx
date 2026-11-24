'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import {
  adminDisplayName,
  clearAdminSession,
  getAdminSession,
  isDevRole,
  type AdminSession,
} from '@/lib/admin-session'
import { setUnauthorizedHandler } from '@/lib/admin-api'

// /admin/legado (painel operacional antigo) continua acessível pela URL, fora do menu.
const NAV = [
  { href: '/admin', label: 'Dashboard', icon: '📊' },
  { href: '/admin/lojas', label: 'Lojas', icon: '🏪' },
]

interface AdminShellProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
}

export default function AdminShell({ title, subtitle, actions, children }: AdminShellProps) {
  const router = useRouter()
  const pathname = usePathname()
  const [session, setSession] = useState<AdminSession | null>(null)
  const [ready, setReady] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    const current = getAdminSession()
    // /admin é o painel da plataforma: só perfil Dev. Lojistas usam /{slug}/admin.
    if (!current || !isDevRole(current.role)) {
      router.replace('/login')
      return
    }
    setSession(current)
    setReady(true)
    setUnauthorizedHandler(() => router.replace('/login'))
    return () => setUnauthorizedHandler(null)
  }, [router])

  useEffect(() => {
    setDrawerOpen(false)
  }, [pathname])

  if (!ready || !session) {
    return (
      <div className="grid min-h-screen place-items-center text-sm text-[var(--text-muted)]">
        <span className="animate-pulse">Carregando painel…</span>
      </div>
    )
  }

  function handleLogout() {
    clearAdminSession()
    router.replace('/login')
  }

  const sidebar = (
    <nav className="wa-nav" aria-label="Navegação do painel">
      <div className="wa-nav-brand">
        <span className="wa-logo" aria-hidden>
          W
        </span>
        <span className="wa-nav-brand-title">
          WaDelivery
          <span className="wa-nav-brand-sub">Painel da plataforma</span>
        </span>
      </div>

      {NAV.map((item) => {
        const active =
          item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`wa-nav-link${active ? ' is-active' : ''}`}
          >
            <span className="wa-nav-icon" aria-hidden>
              {item.icon}
            </span>
            {item.label}
          </Link>
        )
      })}

      <div className="wa-user-card">
        <p className="wa-user-name">{adminDisplayName(session)}</p>
        <p className="wa-user-role">{session.role || 'perfil'}</p>
        <button
          type="button"
          onClick={handleLogout}
          className="wa-btn wa-btn-ghost wa-btn-block wa-btn-danger"
        >
          Sair
        </button>
      </div>
    </nav>
  )

  return (
    <div className="wa-shell">
      <aside className="wa-sidebar">{sidebar}</aside>

      {drawerOpen && (
        <div className="wa-drawer">
          <div
            className="wa-drawer-backdrop"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <aside className="wa-drawer-panel">{sidebar}</aside>
        </div>
      )}

      <main className="wa-main">
        <header className="wa-topbar">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="wa-menu-btn"
            aria-label="Abrir menu"
          >
            ☰
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="wa-topbar-title truncate">{title}</h1>
            {subtitle && <p className="wa-topbar-sub truncate">{subtitle}</p>}
          </div>
          {actions}
        </header>

        <div className="wa-content">{children}</div>
      </main>
    </div>
  )
}
