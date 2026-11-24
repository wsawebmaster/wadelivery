// Cliente HTTP do painel /admin. Fala com a API do catálogo/plataforma
// (gateway :5100 no stack completo, catalog-api :5101 no modo leve).
import { clearAdminSession, getAdminSession } from './admin-session'
import { browserApiBase } from './api-base'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

let unauthorizedHandler: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn
}

export function getApiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const globalOverride = (window as unknown as { API_BASE_URL?: string }).API_BASE_URL
    if (globalOverride) return String(globalOverride).replace(/\/$/, '')
  }

  const env = process.env.NEXT_PUBLIC_API_BASE_URL
  if (env && env.trim()) {
    // Página aberta pelo IP da rede (celular): "localhost" vira o host da página.
    return browserApiBase(env, typeof window !== 'undefined' ? window.location.hostname : null)
  }

  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    const isLan =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      !host.includes('.') ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    return `http://${isLan ? host : 'localhost'}:5100`
  }

  return 'http://localhost:5100'
}

interface RequestOptions extends RequestInit {
  auth?: boolean
}

export async function adminFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { auth = true, headers, ...rest } = options
  const finalHeaders = new Headers(headers)
  finalHeaders.set('Accept', 'application/json')

  if (auth) {
    const session = getAdminSession()
    if (session?.token) finalHeaders.set('Authorization', `Bearer ${session.token}`)
  }

  let res: Response
  try {
    res = await fetch(`${getApiBaseUrl()}${path}`, {
      ...rest,
      headers: finalHeaders,
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'Não foi possível conectar à API.')
  }

  if (res.status === 401) {
    clearAdminSession()
    unauthorizedHandler?.()
    throw new ApiError(401, 'Sessão expirada. Faça login novamente.')
  }

  if (!res.ok) {
    let message = `Erro ${res.status}`
    try {
      const body = await res.json()
      message = body?.error || body?.message || message
    } catch {
      // resposta sem corpo JSON
    }
    throw new ApiError(res.status, message)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export interface LoginResponse {
  token: string
  username: string
  role: string
}

export async function adminLogin(username: string, password: string): Promise<LoginResponse> {
  return adminFetch<LoginResponse>('/api/v1/auth/login', {
    method: 'POST',
    auth: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

export interface StoreStats {
  fetchedAt: string
  error: string | null
  lastAccessAt: string | null
  menuViews30d: number
  menuViewsTotal: number
  orders30d: number | null
  ordersTotal: number | null
  ordersAvailable: boolean
}

export interface PlatformStore {
  id: string
  name: string
  status: string
  plan: string | null
  segment: string | null
  active: boolean
  monthlyFee: number
  courtesy: boolean
  paymentStatus: string
  nextDueAt: string | null
  lastPaymentAt: string | null
  createdAt: string
  updatedAt: string
  storeId: number | null
  city: string | null
  state: string | null
  domain: string | null
  frontUrl: string | null
  adminUrl: string | null
  backUrl: string | null
  lastAccessAt: string | null
  logoUrl: string | null
  email: string | null
  phone: string | null
  contactName: string | null
  stats: StoreStats | null
  courtesyUntil?: string | null
  paymentNotes?: string | null
  payments?: PlatformPayment[]
  billingBlocked?: boolean
  billingBlockSuspendedUntil?: string | null
  abandonedAt?: string | null
  [key: string]: unknown
}

export function fetchPlatformStores(): Promise<PlatformStore[]> {
  return adminFetch<PlatformStore[]>('/api/v1/admin/platform-stores')
}

export interface PlatformPayment {
  paidAt: string
  amount: number
  note: string | null
}

export interface UpdateBillingInput {
  monthlyFee?: number
  courtesy?: boolean
  courtesyUntil?: string | null
  clearCourtesyUntil?: boolean
  nextDueAt?: string | null
  paymentNotes?: string | null
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export function updatePlatformBilling(id: string, input: UpdateBillingInput): Promise<PlatformStore> {
  return adminFetch<PlatformStore>(`/api/v1/admin/platform-stores/${id}/billing`, jsonInit('PATCH', input))
}

export function registerPlatformPayment(
  id: string,
  input: { paidAt?: string; amount?: number; note?: string; nextDueAt?: string },
): Promise<PlatformStore> {
  return adminFetch<PlatformStore>(`/api/v1/admin/platform-stores/${id}/payments`, jsonInit('POST', input))
}

export function setPlatformStoreBlocked(id: string, blocked: boolean): Promise<PlatformStore> {
  return adminFetch<PlatformStore>(`/api/v1/admin/platform-stores/${id}/block`, jsonInit('POST', { blocked }))
}

export interface SegmentChangeResult {
  store: PlatformStore
  applied: { colors: boolean; logo: boolean; samplesRemoved: number; samplesAdded: number }
}

export function setPlatformSegment(
  id: string,
  segment: string,
  options: { applyPalette: boolean; applySamples: boolean },
): Promise<SegmentChangeResult> {
  return adminFetch<SegmentChangeResult>(
    `/api/v1/admin/platform-stores/${id}/segment`,
    jsonInit('PATCH', { segment, ...options }),
  )
}

export interface SegmentPalette {
  segment: string
  name: string
  corPrimaria: string
  corSecundaria: string
  corFundo: string
  corTexto: string
}

export function fetchSegmentPalettes(): Promise<{ segments: SegmentPalette[] }> {
  return adminFetch<{ segments: SegmentPalette[] }>('/api/v1/segment-palettes', { auth: false })
}

// ── Página da loja (plataforma) ──
const storePath = (id: string) => `/api/v1/admin/platform-stores/${id}`

export function fetchPlatformStore(id: string): Promise<PlatformStore> {
  return adminFetch<PlatformStore>(storePath(id))
}

/** PUT é upsert completo: envie o objeto atual mesclado com as alterações. */
export function updatePlatformStore(id: string, data: Record<string, unknown>): Promise<PlatformStore> {
  return adminFetch<PlatformStore>(storePath(id), jsonInit('PUT', data))
}

export function deletePlatformStore(id: string): Promise<void> {
  return adminFetch<void>(storePath(id), { method: 'DELETE' })
}

export interface StoreUser {
  id: number
  username: string
  role: string
  storeId: number | null
  displayName?: string | null
  hasPin?: boolean
}

export function fetchStoreUsers(id: string): Promise<StoreUser[]> {
  return adminFetch<StoreUser[]>(`${storePath(id)}/users`)
}

export function createStoreUser(
  id: string,
  input: { username: string; password: string; role: string; displayName?: string },
): Promise<StoreUser> {
  return adminFetch<StoreUser>(`${storePath(id)}/users`, jsonInit('POST', input))
}

export function resetStoreUserPassword(id: string, userId: number, password: string): Promise<{ ok: boolean }> {
  return adminFetch<{ ok: boolean }>(`${storePath(id)}/users/${userId}/reset-password`, jsonInit('POST', { password }))
}

export function deleteStoreUser(id: string, userId: number): Promise<void> {
  return adminFetch<void>(`${storePath(id)}/users/${userId}`, { method: 'DELETE' })
}

export function uploadPlatformLogo(id: string, file: File): Promise<PlatformStore> {
  const body = new FormData()
  body.append('file', file)
  return adminFetch<PlatformStore>(`${storePath(id)}/logo`, { method: 'POST', body })
}

export interface AuditEntry {
  id: number
  at: string
  actor: string
  action: string
  platformStoreId: string | null
  storeId: number | null
  storeName: string | null
  details: Record<string, unknown> | null
}

export function fetchStoreAudit(id: string, limit = 50): Promise<AuditEntry[]> {
  return adminFetch<AuditEntry[]>(`${storePath(id)}/audit?limit=${limit}`)
}

export function fetchPlatformAudit(limit = 20): Promise<AuditEntry[]> {
  return adminFetch<AuditEntry[]>(`/api/v1/admin/platform-stores/audit?limit=${limit}`)
}

export function logReminder(id: string, note?: string): Promise<void> {
  return adminFetch<void>(`${storePath(id)}/audit`, jsonInit('POST', { action: 'reminder.whatsapp', note }))
}

export interface PlatformStoreActivity {
  platformStoreId: string
  storeId: number | null
  orders30d: number
  ordersTotal: number
  lastOrderAt: string | null
  menuViews30d: number
  ownProducts: number
  sampleProducts: number
  ownerLoggedIn: boolean
}

export function fetchPlatformOverview(): Promise<PlatformStoreActivity[]> {
  return adminFetch<PlatformStoreActivity[]>('/api/v1/admin/platform-stores/overview')
}

export function runPlatformBilling(): Promise<{ changed: number }> {
  return adminFetch<{ changed: number }>('/api/v1/admin/platform-stores/billing/run', { method: 'POST' })
}

export interface StoreToolsStatus {
  serviceAvailable: boolean
  remoteBaseUrl: string | null
  hasRemoteCreds: boolean
  remoteReachable: boolean
  remoteError: string | null
  lastBackupAt: string | null
  localCategories: number
  localProducts: number
  localIngredients: number
  localStoreName: string | null
}

export interface StoreToolsCompareReport {
  mode: string
  remoteBaseUrl: string | null
  warnings: string[]
  categoriesLocal: number
  categoriesRemote: number
  productsLocal: number
  productsRemote: number
  ingredientsLocal: number
  ingredientsRemote: number
  equalProducts: number
  categoriesOnlyLocal: string[]
  categoriesOnlyRemote: string[]
  productsOnlyLocal: string[]
  productsOnlyRemote: string[]
  ingredientsOnlyLocal: string[]
  ingredientsOnlyRemote: string[]
  changedProducts: { id: string; name: string; changedFields: string[] }[]
  imagesMissingLocal: string[]
  storeDiffs: { field: string; local: string | null; remote: string | null }[]
  storeConfigEqual: boolean
  storeNameLocal: string | null
  storeNameRemote: string | null
}

export interface StoreToolsBackupResult {
  storeId: number
  directory: string
  categories: number
  products: number
  ingredients: number
  imagesDownloaded: number
  imagesExisting: number
  imagesFailed: number
  warnings: string[]
  createdAt: string
}

export interface StoreToolsSyncReport {
  storeId: number
  dryRun: boolean
  skipDelete: boolean
  mode: string
  categoriesSynced: number
  categoriesDeleted: number
  ingredientsSynced: number
  ingredientsDeleted: number
  productsSynced: number
  productsDeleted: number
  imagesDownloaded: number
  imagesExisting: number
  imagesUpdated: number
  imagesFailed: number
  storeUpdated: boolean
  productsOnlyLocal: number
  categoriesOnlyLocal: number
  ingredientsOnlyLocal: number
  warnings: string[]
  error: string | null
}

function storeToolsPath(storeId: number): string {
  if (!Number.isInteger(storeId) || storeId <= 0) {
    throw new Error('Esta loja não possui um StoreId válido.')
  }
  return `/api/v1/admin/tools/${storeId}`
}

export function fetchStoreToolsStatus(storeId: number): Promise<StoreToolsStatus> {
  return adminFetch<StoreToolsStatus>(`${storeToolsPath(storeId)}/status`)
}

export function compareStoreTools(storeId: number): Promise<StoreToolsCompareReport> {
  return adminFetch<StoreToolsCompareReport>(`${storeToolsPath(storeId)}/compare`)
}

export function createStoreToolsBackup(storeId: number): Promise<StoreToolsBackupResult> {
  return adminFetch<StoreToolsBackupResult>(`${storeToolsPath(storeId)}/backup`, {
    method: 'POST',
  })
}

export function syncStoreFromRemote(
  storeId: number,
  dryRun: boolean,
  skipDelete: boolean
): Promise<StoreToolsSyncReport> {
  const query = new URLSearchParams({
    dryRun: String(dryRun),
    skipDelete: String(skipDelete),
  })
  return adminFetch<StoreToolsSyncReport>(
    `${storeToolsPath(storeId)}/sync-from-remote?${query.toString()}`,
    { method: 'POST' }
  )
}

export interface StoreToolsOrdersPreview {
  mode: string
  remoteBaseUrl: string | null
  warnings: string[]
  ordersToCreate: number
  ordersToReplace: number
  ordersEqual: number
  totalRemote: number
  sampleNewOrderIds: string[]
  error: string | null
}

export interface StoreToolsOrdersSyncReport {
  storeId: number
  dryRun: boolean
  mode: string
  ordersCreated: number
  ordersReplaced: number
  ordersEqual: number
  ordersFailed: number
  warnings: string[]
  error: string | null
}

export function previewStoreOrdersFromRemote(storeId: number): Promise<StoreToolsOrdersPreview> {
  return adminFetch<StoreToolsOrdersPreview>(`${storeToolsPath(storeId)}/orders-preview`, {
    method: 'POST',
  })
}

export function syncStoreOrdersFromRemote(
  storeId: number,
  dryRun: boolean
): Promise<StoreToolsOrdersSyncReport> {
  const query = new URLSearchParams({ dryRun: String(dryRun) })
  return adminFetch<StoreToolsOrdersSyncReport>(
    `${storeToolsPath(storeId)}/orders-sync?${query.toString()}`,
    { method: 'POST' }
  )
}

export interface TrafficDay {
  date: string
  pageviews: number
  apiHits: number
}

export interface TrafficHour {
  label: string
  hour: number
  date: string
  pageviews: number
  apiHits: number
}

export interface TrafficSummary {
  days: number
  timeZone: string
  pageviewsToday: number
  pageviewsPeriod: number
  apiHitsToday: number
  apiHitsPeriod: number
  peakHourLabel: string | null
  peakHourCount: number
  last24Hours: TrafficHour[]
  daily: TrafficDay[]
  topRoutes: { route: string; count: number }[]
  railway: { dashboardUrl: string; apiHitsPeriod: number; note: string; estimatedNote: string }
}

export function fetchPlatformTraffic(days = 7): Promise<TrafficSummary> {
  return adminFetch<TrafficSummary>(`/api/v1/admin/platform-traffic?days=${days}`)
}

export type StoreStatsDto = StoreStats

export function fetchStoreStats(): Promise<StoreStatsDto> {
  return adminFetch<StoreStatsDto>('/api/v1/admin/platform/store-stats')
}

export interface OrdersDashboard {
  totalOrders: number
  ordersToday: number
  openOrders: number
  deliveredOrders: number
  cancelledOrders: number
  grossRevenue: number
  averageTicket: number
  period: string
  periodLabel: string
}

export function fetchOrdersDashboard(period = 'today'): Promise<OrdersDashboard> {
  return adminFetch<OrdersDashboard>(`/api/v1/orders/dashboard?period=${period}`)
}

export interface StoreConfig {
  name?: string
  active?: boolean
  acceptingOrders?: boolean
  whatsapp?: string
  phone?: string
  [key: string]: unknown
}

export function fetchStoreConfig(): Promise<StoreConfig> {
  return adminFetch<StoreConfig>('/api/v1/store', { auth: false })
}

export interface PublicProduct {
  id: string
  name: string
  price: number
  available: boolean
  showInMenu?: boolean
}

export interface PublicCategory {
  id: string
  title?: string
  showInMenu?: boolean
  items?: PublicProduct[]
}

export interface PublicCatalog {
  categories: PublicCategory[]
}

export function fetchPublicCatalog(): Promise<PublicCatalog> {
  return adminFetch<PublicCatalog>('/api/v1/catalog', { auth: false })
}

export interface HealthProbe {
  label: string
  url: string
  ok: boolean
  status: number | null
  service?: string | null
}

export async function probeHealth(path: string, label: string): Promise<HealthProbe> {
  const url = `${getApiBaseUrl()}${path}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    let service: string | null = null
    if (res.ok) {
      try {
        const body = (await res.clone().json()) as { service?: string }
        service = body?.service ?? null
      } catch {
        // resposta sem corpo JSON
      }
    }
    return { label, url, ok: res.ok, status: res.status, service }
  } catch {
    return { label, url, ok: false, status: null, service: null }
  }
}

/**
 * Sonda a saúde de forma agnóstica ao modo de execução:
 * - base apontando para o gateway (:5100) → sonda gateway + catálogo + pedidos;
 * - base apontando direto para um serviço (modo leve, :5101) → devolve só ele,
 *   evitando "offline" falso em rotas que só existem no gateway.
 */
export async function probeServiceHealth(): Promise<HealthProbe[]> {
  const base = await probeHealth('/api/v1/health', 'API')
  if (base.service && base.service !== 'gateway') {
    const label =
      base.service === 'catalog-api'
        ? 'Catálogo'
        : base.service === 'orders-api'
          ? 'Pedidos'
          : base.service
    return [{ ...base, label }]
  }

  const [catalog, orders] = await Promise.all([
    probeHealth('/api/v1/health/catalog', 'Catálogo'),
    probeHealth('/api/v1/health/orders', 'Pedidos'),
  ])
  return [{ ...base, label: 'Gateway' }, catalog, orders]
}
