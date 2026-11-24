'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  createStoreUser,
  deleteStoreUser,
  fetchStoreUsers,
  resetStoreUserPassword,
  type StoreUser,
} from '@/lib/admin-api'

const ROLE_LABEL: Record<string, string> = {
  AdminLoja: 'Proprietário',
  Admin: 'Administrador',
  Atendimento: 'Atendimento',
  Garçom: 'Garçom',
}

/** Senha temporária forte gerada no navegador (sem caracteres ambíguos). */
export function generateTemporaryPassword(length = 12): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz'
  const digits = '23456789'
  const all = letters + digits
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  const chars = Array.from(bytes, (b) => all[b % all.length])
  chars[bytes[0] % length] = digits[bytes[1] % digits.length] // ao menos um dígito
  return chars.join('')
}

interface Credentials {
  username: string
  password: string
  reason: string
}

/** Usuários da loja: lista, criação, redefinição de senha e remoção (perfil Dev). */
export default function StoreUsersPanel({
  platformId,
  panelUrl,
  onAction,
}: {
  platformId: string
  panelUrl?: string | null
  /** Chamado após criar, remover ou redefinir senha (ex.: recarregar o histórico). */
  onAction?: () => void
}) {
  const [users, setUsers] = useState<StoreUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const [copied, setCopied] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', role: 'Atendimento', displayName: '' })

  const load = useCallback(async () => {
    try {
      setUsers(await fetchStoreUsers(platformId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar os usuários.')
    }
  }, [platformId])

  useEffect(() => {
    void load()
  }, [load])

  async function run(key: string, task: () => Promise<void>) {
    if (busy) return
    setBusy(key)
    setError(null)
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A operação não foi concluída.')
    } finally {
      setBusy(null)
    }
  }

  const reset = (user: StoreUser) =>
    run(`reset-${user.id}`, async () => {
      if (!window.confirm(`Redefinir a senha de "${user.username}"? A senha atual deixa de funcionar.`)) return
      const password = generateTemporaryPassword()
      await resetStoreUserPassword(platformId, user.id, password)
      setCopied(false)
      setCredentials({ username: user.username, password, reason: 'Senha redefinida' })
      onAction?.()
    })

  const remove = (user: StoreUser) =>
    run(`delete-${user.id}`, async () => {
      const admins = (users ?? []).filter((u) => u.role === 'AdminLoja' || u.role === 'Admin')
      const lastAdmin = (user.role === 'AdminLoja' || user.role === 'Admin') && admins.length <= 1
      const warning = lastAdmin ? '\n\nAtenção: é o último administrador; a loja ficará sem acesso ao painel.' : ''
      if (!window.confirm(`Remover o usuário "${user.username}"?${warning}`)) return
      await deleteStoreUser(platformId, user.id)
      await load()
      onAction?.()
    })

  const create = () =>
    run('create', async () => {
      const username = newUser.username.trim()
      if (!/^[A-Za-z0-9_-]{2,64}$/.test(username)) throw new Error('Usuário: use letras, números, _ ou - (2 a 64 caracteres).')
      const password = generateTemporaryPassword()
      await createStoreUser(platformId, {
        username,
        password,
        role: newUser.role,
        displayName: newUser.displayName.trim() || undefined,
      })
      setNewUser({ username: '', role: 'Atendimento', displayName: '' })
      setCopied(false)
      setCredentials({ username, password, reason: 'Usuário criado' })
      await load()
      onAction?.()
    })

  async function copy() {
    if (!credentials) return
    await navigator.clipboard.writeText(
      `Login: ${credentials.username}\nSenha temporária: ${credentials.password}${panelUrl ? `\nPainel: ${panelUrl}` : ''}`,
    )
    setCopied(true)
  }

  return (
    <div className="wa-form-section">
      {error && <p className="wa-alert is-error">{error}</p>}

      {credentials && (
        <div className="wa-alert is-ok wa-credentials" role="status">
          <strong>{credentials.reason}. Anote agora: a senha aparece só uma vez.</strong>
          <span>
            Login: <code>{credentials.username}</code>
          </span>
          <span>
            Senha temporária: <code>{credentials.password}</code>
          </span>
          <span className="text-xs">No primeiro acesso o usuário define a própria senha.</span>
          <div className="wa-actions">
            <button type="button" className="wa-btn wa-btn-ghost" onClick={() => void copy()}>
              {copied ? 'Copiado ✓' : 'Copiar credenciais'}
            </button>
            <button type="button" className="wa-btn wa-btn-ghost" onClick={() => setCredentials(null)}>
              Ocultar
            </button>
          </div>
        </div>
      )}

      {users === null ? (
        <p className="text-sm text-[var(--text-muted)]">Carregando usuários…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Nenhum usuário nesta loja.</p>
      ) : (
        <ul className="text-sm">
          {users.map((u) => (
            <li key={u.id} className="wa-row">
              <span className="min-w-0">
                <span className="block truncate font-semibold">{u.displayName || u.username}</span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {u.username} · {ROLE_LABEL[u.role] ?? u.role}
                </span>
              </span>
              <span className="flex shrink-0 gap-2">
                <button type="button" className="wa-btn wa-btn-ghost" disabled={!!busy} onClick={() => void reset(u)}>
                  {busy === `reset-${u.id}` ? 'Aguarde…' : 'Redefinir senha'}
                </button>
                <button type="button" className="wa-btn wa-btn-ghost wa-btn-danger" disabled={!!busy} onClick={() => void remove(u)}>
                  Remover
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3 className="text-sm font-semibold">Novo usuário</h3>
      <div className="grid gap-x-3 sm:grid-cols-3">
        <label className="wa-field">
          <span className="wa-label">Usuário</span>
          <input
            className="wa-input"
            placeholder="ex.: caixa-centro"
            value={newUser.username}
            onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
          />
        </label>
        <label className="wa-field">
          <span className="wa-label">Papel</span>
          <select className="wa-input" value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
            <option value="Atendimento">Atendimento</option>
            <option value="Admin">Administrador</option>
          </select>
        </label>
        <label className="wa-field">
          <span className="wa-label">Nome (opcional)</span>
          <input
            className="wa-input"
            value={newUser.displayName}
            onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
          />
        </label>
      </div>
      <p className="wa-hint text-xs text-[var(--text-muted)]">
        A senha temporária é gerada automaticamente. Garçons são cadastrados pelo lojista em Equipe (exigem PIN).
      </p>
      <div className="wa-actions">
        <button type="button" className="wa-btn wa-btn-primary" disabled={!!busy} onClick={() => void create()}>
          {busy === 'create' ? 'Criando…' : 'Criar usuário'}
        </button>
      </div>
    </div>
  )
}
