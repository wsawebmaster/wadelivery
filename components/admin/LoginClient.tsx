'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { adminLogin, ApiError } from '@/lib/admin-api'
import { getAdminSession, isDevRole, roleFromToken, saveAdminSession } from '@/lib/admin-session'

const FEATURES = [
  {
    icon: '🏪',
    title: 'Gestão de lojas',
    text: 'Cadastro, plano, cobrança e status de cada loja da plataforma.',
  },
  {
    icon: '📊',
    title: 'Visão consolidada',
    text: 'Acessos ao cardápio, pedidos e receita recorrente em um só lugar.',
  },
  {
    icon: '🧩',
    title: 'Operação completa',
    text: 'Catálogo, pedidos e ferramentas avançadas no painel integrado.',
  },
]

export default function LoginClient() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const session = getAdminSession()
    if (session && isDevRole(session.role)) router.replace('/admin')
  }, [router])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const result = await adminLogin(username.trim(), password)
      const role = result.role || roleFromToken(result.token)
      if (!isDevRole(role)) {
        setError('Acesso restrito ao perfil Dev (plataforma).')
        return
      }
      saveAdminSession({ token: result.token, role, username: result.username || username.trim() })
      router.replace('/admin')
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Usuário ou senha inválidos.'
          : err instanceof Error
            ? err.message
            : 'Falha ao entrar.'
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="wa-login">
      <aside className="wa-login-brand">
        <div className="wa-login-brand-head">
          <span className="wa-logo wa-logo-lg" aria-hidden>
            W
          </span>
          <div>
            <p className="wa-login-brand-name">WaDelivery</p>
            <p className="wa-login-brand-tag">Painel da plataforma</p>
          </div>
        </div>

        <div className="wa-login-copy">
          <h2>
            Todas as lojas,
            <br />
            em um só lugar.
          </h2>
          <p>
            Administre a plataforma, acompanhe o desempenho das lojas e cuide da operação com
            clareza.
          </p>

          {FEATURES.map((feature) => (
            <div key={feature.title} className="wa-feature">
              <span className="wa-feature-icon" aria-hidden>
                {feature.icon}
              </span>
              <div>
                <p className="wa-feature-title">{feature.title}</p>
                <p className="wa-feature-text">{feature.text}</p>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="wa-login-body">
        <form onSubmit={handleSubmit} className="wa-card wa-login-card">
          <div className="mb-5 flex items-center gap-3 lg:hidden">
            <span className="wa-logo" aria-hidden>
              W
            </span>
            <div>
              <p className="wa-panel-title">WaDelivery</p>
              <p className="wa-panel-note">Painel da plataforma</p>
            </div>
          </div>

          <h1 className="wa-login-title">Entrar</h1>
          <p className="wa-login-sub">Acesse com sua conta de plataforma.</p>

          <div className="wa-field">
            <label className="wa-label" htmlFor="admin-user">
              Usuário
            </label>
            <input
              id="admin-user"
              className="wa-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>

          <div className="wa-field">
            <label className="wa-label" htmlFor="admin-pass">
              Senha
            </label>
            <input
              id="admin-pass"
              type="password"
              className="wa-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && (
            <p className="wa-alert is-error mb-4" role="alert">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading} className="wa-btn wa-btn-primary wa-btn-lg wa-btn-block">
            {loading ? 'Entrando…' : 'Entrar'}
          </button>

        </form>
      </div>
    </div>
  )
}
