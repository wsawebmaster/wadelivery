// Sessão do painel /admin.
//
// As chaves são as mesmas usadas pelo painel administrativo legado
// (apps/admin) para que a sessão seja compartilhada com o iframe em
// /admin/legado no mesmo origin (localStorage).

export const ADMIN_TOKEN_KEY = 'delivery-admin-token'
export const ADMIN_ROLE_KEY = 'delivery-admin-role'
export const ADMIN_USER_KEY = 'delivery-admin-user'
export const ADMIN_DEV_SESSION_KEY = 'delivery-admin-dev-session'

export interface AdminSession {
  token: string
  role: string
  username: string
}

export interface AdminJwtPayload {
  role?: string
  name?: string
  store_id?: string
  exp?: number
  [claim: string]: unknown
}

const ROLE_CLAIM = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role'

export function decodeJwtPayload(token: string): AdminJwtPayload | null {
  try {
    const part = String(token || '').split('.')[1]
    if (!part) return null
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    if (typeof atob === 'undefined') return null
    return JSON.parse(atob(padded)) as AdminJwtPayload
  } catch {
    return null
  }
}

export function roleFromToken(token: string): string {
  const payload = decodeJwtPayload(token)
  if (!payload) return ''
  const claim = payload[ROLE_CLAIM]
  return String(payload.role || claim || '')
}

export function isSessionExpired(token: string): boolean {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload.exp !== 'number') return false
  return payload.exp * 1000 <= Date.now()
}

export function isDevRole(role: string): boolean {
  return /^dev$/i.test(String(role || '').trim())
}

export function getAdminSession(): AdminSession | null {
  if (typeof window === 'undefined') return null
  try {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY) || ''
    if (!token) return null
    if (isSessionExpired(token)) {
      clearAdminSession()
      return null
    }
    const role = localStorage.getItem(ADMIN_ROLE_KEY) || roleFromToken(token) || ''
    const username = localStorage.getItem(ADMIN_USER_KEY) || ''
    return { token, role, username }
  } catch {
    return null
  }
}

export function saveAdminSession(session: AdminSession): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, session.token)
    localStorage.setItem(ADMIN_ROLE_KEY, session.role)
    localStorage.setItem(ADMIN_USER_KEY, session.username)
    // Snapshot do perfil dev: permite ao legado "Voltar para dev" ao alternar perfil.
    localStorage.setItem(
      ADMIN_DEV_SESSION_KEY,
      JSON.stringify({ token: session.token, role: session.role, username: session.username })
    )
  } catch {
    // storage indisponível (modo privado) — sessão apenas em memória
  }
}

export function clearAdminSession(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY)
    localStorage.removeItem(ADMIN_ROLE_KEY)
    localStorage.removeItem(ADMIN_USER_KEY)
    localStorage.removeItem(ADMIN_DEV_SESSION_KEY)
  } catch {
    // ignore
  }
}

export function adminDisplayName(session: AdminSession): string {
  const payload = decodeJwtPayload(session.token)
  const name = payload && typeof payload.name === 'string' ? payload.name.trim() : ''
  if (name) return name
  if (session.username) {
    return session.username.charAt(0).toUpperCase() + session.username.slice(1)
  }
  return 'Conta'
}
