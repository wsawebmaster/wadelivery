'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import AdminShell from './AdminShell'
import {
  fetchPlatformOverview,
  fetchPlatformStores,
  getApiBaseUrl,
  logReminder,
  type PlatformStore,
  type PlatformStoreActivity,
} from '@/lib/admin-api'
import { browserApiBase } from '@/lib/api-base'
import { reminderMessage, whatsappUrl } from '@/lib/billing-reminder'
import { STORE_SEGMENTS, segmentColor, segmentLabel } from '@/lib/segments'
import StoreToolsDialog from './StoreToolsDialog'
import BillingDialog, { billingPillClass, billingSummary, daysUntil, formatBillingDay } from './BillingDialog'
import SegmentDialog from './SegmentDialog'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const number = new Intl.NumberFormat('pt-BR')
const HIDDEN_KEY = 'wa-admin-hidden-stores'
const PAGE_SIZE_KEY = 'wa-admin-stores-page-size'
const DAY_MS = 86_400_000

type FilterKey = 'all' | 'overdue' | 'blocked' | 'trial' | 'abandoned' | 'noaccess'
type SortKey = 'name' | 'billing' | 'due' | 'access' | 'orders' | 'newest'
type SortDir = 'asc' | 'desc'

/** Situações usadas nos filtros rápidos (mesmas regras do resumo de cobrança). */
export function storeFlags(s: PlatformStore) {
  const abandoned = Boolean(s.abandonedAt) && !s.active
  const due = daysUntil(s.nextDueAt)
  const trialLeft = daysUntil(s.courtesyUntil)
  return {
    abandoned,
    blocked: !s.active && !abandoned,
    overdue: s.active && !s.courtesy && Number(s.monthlyFee) > 0 && due !== null && due < 0,
    trial: s.active && s.courtesy && trialLeft !== null && trialLeft <= 7,
    noaccess: s.active && !s.lastAccessAt,
  }
}

/** Gravidade da cobrança para ordenar a coluna (maior = mais urgente). */
function billingRank(s: PlatformStore) {
  const f = storeFlags(s)
  if (f.abandoned || f.blocked) return 5
  if (f.overdue) return 4
  if (f.trial) return 3
  const due = daysUntil(s.nextDueAt)
  if (due !== null && due <= 5) return 2
  return s.courtesy ? 1 : 0
}

/** "hoje", "ontem", "há 5 dias", "há 2 meses". */
function relative(value?: string | null) {
  if (!value) return null
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return null
  const days = Math.floor((Date.now() - t) / DAY_MS)
  if (days <= 0) return 'hoje'
  if (days === 1) return 'ontem'
  if (days < 30) return `há ${days} dias`
  const months = Math.floor(days / 30)
  return months < 12 ? `há ${months} ${months === 1 ? 'mês' : 'meses'}` : `há ${Math.floor(months / 12)} ano(s)`
}

function readSet(key: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]') as string[])
  } catch {
    return new Set()
  }
}

function pageLink(url?: string | null) {
  if (!url) return null
  return browserApiBase(url, typeof window !== 'undefined' ? window.location.hostname : null)
}

function initials(name: string) {
  const words = name.split(/[\s-]+/).filter((w) => w && !/^(de|da|do|das|dos|e)$/i.test(w))
  return (words.slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase()
}

/** Logo da loja ou iniciais na cor do segmento. */
function StoreAvatar({ store }: { store: PlatformStore }) {
  const [failed, setFailed] = useState(false)
  const url = store.logoUrl
    ? /^https?:\/\//i.test(store.logoUrl) ? store.logoUrl : `${getApiBaseUrl()}${store.logoUrl}`
    : null
  if (url && !failed) {
    return <img src={url} alt="" className="wa-avatar" loading="lazy" onError={() => setFailed(true)} />
  }
  const color = segmentColor(store.segment)
  return (
    <span className="wa-avatar is-initials" style={{ background: `linear-gradient(135deg, ${color}, ${color}99)` }} aria-hidden="true">
      {initials(store.name)}
    </span>
  )
}

/** Menu "⋯" com as ações secundárias da loja (abre para cima perto do fim da tela). */
function ActionsMenu({
  store,
  hidden,
  onBilling,
  onSegment,
  onTools,
  onToggleHidden,
}: {
  store: PlatformStore
  hidden: boolean
  onBilling: () => void
  onSegment: () => void
  onTools: () => void
  onToggleHidden: () => void
}) {
  const [open, setOpen] = useState(false)
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  function toggle() {
    const rect = ref.current?.getBoundingClientRect()
    setUp(!!rect && window.innerHeight - rect.bottom < 340)
    setOpen((v) => !v)
  }

  const menuUrl = pageLink(store.frontUrl)
  const adminUrl = pageLink(store.adminUrl)
  const reminderUrl = whatsappUrl(store.phone, reminderMessage(store))
  const hasStoreId = typeof store.storeId === 'number' && store.storeId > 0
  const item = (label: string, action: () => void, disabled = false) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false)
        action()
      }}
    >
      {label}
    </button>
  )

  return (
    <div className="wa-menu" ref={ref}>
      <button
        type="button"
        className="wa-icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Mais ações de ${store.name}`}
        onClick={toggle}
      >
        ⋯
      </button>
      {open && (
        <div className={`wa-menu-list ${up ? 'is-up' : ''}`} role="menu">
          {item('Cobrança', onBilling)}
          {item('Segmento', onSegment)}
          <a
            role="menuitem"
            href={reminderUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            aria-disabled={!reminderUrl}
            className={reminderUrl ? '' : 'is-disabled'}
            onClick={() => {
              setOpen(false)
              if (reminderUrl) void logReminder(store.id, billingSummary(store).label).catch(() => {})
            }}
          >
            Lembrar pelo WhatsApp{reminderUrl ? '' : ' (sem telefone)'}
          </a>
          {menuUrl && <a role="menuitem" href={menuUrl} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Cardápio ↗</a>}
          {adminUrl && <a role="menuitem" href={adminUrl} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>Painel da loja ↗</a>}
          {item('Ferramentas', onTools, !hasStoreId)}
          {item(hidden ? 'Mostrar na lista' : 'Ocultar da lista', onToggleHidden)}
        </div>
      )}
    </div>
  )
}

const COLUMNS: { key: SortKey | null; label: string; className?: string; defaultDir?: SortDir }[] = [
  { key: 'name', label: 'Loja' },
  { key: 'billing', label: 'Cobrança', defaultDir: 'desc' },
  { key: 'due', label: 'Vencimento' },
  { key: 'access', label: 'Último acesso', defaultDir: 'desc' },
  { key: 'orders', label: 'Pedidos 30d', className: 'is-num', defaultDir: 'desc' },
  { key: null, label: '' },
]

export default function LojasClient() {
  const router = useRouter()
  const [stores, setStores] = useState<PlatformStore[]>([])
  const [activity, setActivity] = useState<Map<string, PlatformStoreActivity>>(new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [segment, setSegment] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [toolsStore, setToolsStore] = useState<{ id: string; name: string; storeId: number } | null>(null)
  const [billingStore, setBillingStore] = useState<PlatformStore | null>(null)
  const [segmentStore, setSegmentStore] = useState<PlatformStore | null>(null)
  const closeBilling = useCallback(() => setBillingStore(null), [])
  const closeSegment = useCallback(() => setSegmentStore(null), [])

  useEffect(() => {
    setHidden(readSet(HIDDEN_KEY))
    try {
      const size = Number(localStorage.getItem(PAGE_SIZE_KEY))
      if ([25, 50, 100].includes(size)) setPageSize(size)
    } catch {
      // sem storage: só nesta sessão
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStores(await fetchPlatformStores())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar as lojas.')
    } finally {
      setLoading(false)
    }
    fetchPlatformOverview()
      .then((list) => setActivity(new Map(list.map((a) => [a.platformStoreId, a]))))
      .catch(() => setActivity(new Map()))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Qualquer mudança de filtro volta para a primeira página.
  useEffect(() => setPage(1), [search, filter, segment, sort, showHidden, pageSize])

  const onChanged = useCallback((updated: PlatformStore) => {
    setStores((list) => list.map((s) => (s.id === updated.id ? { ...s, ...updated, stats: s.stats } : s)))
  }, [])

  function toggleHidden(id: string) {
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      try {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...next]))
      } catch {
        // sem storage
      }
      return next
    })
  }

  function changePageSize(size: number) {
    setPageSize(size)
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size))
    } catch {
      // sem storage
    }
  }

  function sortBy(key: SortKey, defaultDir: SortDir = 'asc') {
    setSort((current) => (current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir }))
  }

  const visible = useMemo(() => stores.filter((s) => showHidden || !hidden.has(s.id)), [stores, hidden, showHidden])

  const counts = useMemo(() => {
    const c = { all: visible.length, overdue: 0, blocked: 0, trial: 0, abandoned: 0, noaccess: 0 }
    for (const s of visible) {
      const f = storeFlags(s)
      if (f.overdue) c.overdue++
      if (f.blocked) c.blocked++
      if (f.trial) c.trial++
      if (f.abandoned) c.abandoned++
      if (f.noaccess) c.noaccess++
    }
    return c
  }, [visible])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    const time = (v?: string | null) => (v ? new Date(v).getTime() : 0)
    const sign = sort.dir === 'asc' ? 1 : -1
    return visible
      .filter((s) => filter === 'all' || storeFlags(s)[filter])
      .filter((s) => segment === 'all' || String(s.segment || '').toLowerCase() === segment)
      .filter((s) => {
        if (!term) return true
        return [s.name, s.city, s.state, s.plan, s.email, s.contactName, s.phone, segmentLabel(s.segment)]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term))
      })
      .sort((a, b) => {
        let diff = 0
        switch (sort.key) {
          case 'billing': diff = billingRank(a) - billingRank(b); break
          case 'due': {
            // Sem vencimento sempre no fim, em qualquer direção.
            const ad = time(a.nextDueAt), bd = time(b.nextDueAt)
            if (!ad || !bd) return (ad ? 0 : 1) - (bd ? 0 : 1)
            diff = ad - bd
            break
          }
          case 'access': diff = time(a.lastAccessAt) - time(b.lastAccessAt); break
          case 'orders': diff = (activity.get(a.id)?.orders30d ?? 0) - (activity.get(b.id)?.orders30d ?? 0); break
          case 'newest': diff = time(a.createdAt) - time(b.createdAt); break
          default: diff = a.name.localeCompare(b.name, 'pt-BR')
        }
        return diff * sign || a.name.localeCompare(b.name, 'pt-BR')
      })
  }, [visible, filter, segment, search, sort, activity])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const current = Math.min(page, pages)
  const rows = filtered.slice((current - 1) * pageSize, current * pageSize)
  const maxOrders = Math.max(1, ...filtered.map((s) => activity.get(s.id)?.orders30d ?? 0))

  const chips: [FilterKey, string, number][] = [
    ['all', 'Todas', counts.all],
    ['overdue', 'Vencidas', counts.overdue],
    ['blocked', 'Bloqueadas', counts.blocked],
    ['trial', 'Teste terminando', counts.trial],
    ['abandoned', 'Abandonadas', counts.abandoned],
    ['noaccess', 'Sem acesso do dono', counts.noaccess],
  ]

  /** Linha clicável: abre a loja, exceto em links, botões e no menu. */
  function openRow(e: MouseEvent<HTMLTableRowElement>, id: string) {
    if ((e.target as HTMLElement).closest('a, button, .wa-menu, input, select')) return
    if (e.metaKey || e.ctrlKey) window.open(`/admin/lojas/${id}`, '_blank')
    else router.push(`/admin/lojas/${id}`)
  }

  return (
    <AdminShell
      title="Lojas"
      subtitle={loading ? 'Carregando…' : `${number.format(stores.length)} loja(s) na plataforma`}
      actions={
        <button type="button" onClick={() => void load()} disabled={loading} className="wa-btn wa-btn-ghost">
          {loading ? 'Atualizando…' : '↻ Atualizar'}
        </button>
      }
    >
      <div className="wa-card wa-stores">
        <div className="wa-stores-toolbar">
          <div className="wa-search">
            <span aria-hidden="true">⌕</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nome, cidade, contato, telefone…"
              aria-label="Buscar lojas"
            />
          </div>
          <select className="wa-input wa-select" value={segment} onChange={(e) => setSegment(e.target.value)} aria-label="Segmento">
            <option value="all">Todos os segmentos</option>
            {STORE_SEGMENTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <select
            className="wa-input wa-select wa-only-mobile"
            value={`${sort.key}:${sort.dir}`}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':') as [SortKey, SortDir]
              setSort({ key, dir })
            }}
            aria-label="Ordenar"
          >
            <option value="name:asc">Nome (A–Z)</option>
            <option value="newest:desc">Mais recentes</option>
            <option value="billing:desc">Cobrança (urgentes primeiro)</option>
            <option value="due:asc">Próximo vencimento</option>
            <option value="access:desc">Último acesso</option>
            <option value="orders:desc">Pedidos (30 dias)</option>
          </select>
        </div>

        <div className="wa-stores-chips" role="group" aria-label="Filtros">
          {chips.map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
              className={`wa-chip ${filter === value ? 'is-active' : ''}`}
            >
              {label}
              <span className="wa-chip-count">{count}</span>
            </button>
          ))}
          {hidden.size > 0 && (
            <label className="wa-hidden-toggle">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Mostrar ocultas ({hidden.size})
            </label>
          )}
        </div>

        {error && <p className="wa-alert is-error wa-stores-msg">{error}</p>}

        {loading && stores.length === 0 ? (
          <div className="wa-stores-empty">Carregando lojas…</div>
        ) : filtered.length === 0 ? (
          <div className="wa-stores-empty">
            Nenhuma loja encontrada{search || filter !== 'all' || segment !== 'all' ? ' com esses filtros' : ''}.
          </div>
        ) : (
          <>
            <div className="wa-table-wrap">
              <table className="wa-table wa-stores-table">
                <thead>
                  <tr>
                    {COLUMNS.map((col, i) =>
                      col.key ? (
                        <th
                          key={col.label}
                          className={col.className}
                          aria-sort={sort.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        >
                          <button type="button" onClick={() => sortBy(col.key as SortKey, col.defaultDir)}>
                            {col.label}
                            <span className="wa-sort" aria-hidden="true">
                              {sort.key === col.key ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
                            </span>
                          </button>
                        </th>
                      ) : (
                        <th key={`c-${i}`} aria-label="Ações" />
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => {
                    const billing = billingSummary(s)
                    const a = activity.get(s.id)
                    const orders = a?.orders30d ?? 0
                    const access = relative(s.lastAccessAt)
                    return (
                      <tr key={s.id} className={hidden.has(s.id) ? 'is-hidden' : ''} onClick={(e) => openRow(e, s.id)}>
                        <td data-label="Loja" className="wa-cell-store">
                          <StoreAvatar store={s} />
                          <span className="min-w-0">
                            <Link href={`/admin/lojas/${s.id}`} className="wa-store-name">{s.name}</Link>
                            <span className="wa-store-meta">
                              <i className="wa-dot" style={{ background: segmentColor(s.segment) }} aria-hidden="true" />
                              {s.segment ? segmentLabel(s.segment) : 'Sem segmento'}
                              {s.city ? ` · ${s.city}${s.state ? `/${s.state}` : ''}` : ''}
                            </span>
                          </span>
                        </td>
                        <td data-label="Cobrança">
                          <span className={billingPillClass(billing.tone)}>{billing.label}</span>
                          {Number(s.monthlyFee) > 0 && <span className="wa-cell-sub">{currency.format(Number(s.monthlyFee))}/mês</span>}
                        </td>
                        <td data-label="Vencimento">{formatBillingDay(s.nextDueAt)}</td>
                        <td data-label="Último acesso">
                          {access ? (
                            <span title={new Date(s.lastAccessAt as string).toLocaleString('pt-BR')}>{access}</span>
                          ) : (
                            <span className="wa-muted-strong">Nunca entrou</span>
                          )}
                        </td>
                        <td data-label="Pedidos 30d" className="is-num">
                          <span className="wa-orders">
                            <span className="wa-orders-bar" aria-hidden="true">
                              <i style={{ width: `${(orders / maxOrders) * 100}%` }} />
                            </span>
                            {a ? number.format(orders) : '—'}
                          </span>
                        </td>
                        <td className="wa-cell-actions">
                          <Link href={`/admin/lojas/${s.id}`} className="wa-btn wa-btn-primary wa-btn-sm">Abrir</Link>
                          <ActionsMenu
                            store={s}
                            hidden={hidden.has(s.id)}
                            onBilling={() => setBillingStore(s)}
                            onSegment={() => setSegmentStore(s)}
                            onTools={() => {
                              if (typeof s.storeId === 'number' && s.storeId > 0) setToolsStore({ id: s.id, name: s.name, storeId: s.storeId })
                            }}
                            onToggleHidden={() => toggleHidden(s.id)}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <footer className="wa-stores-footer">
              <span>
                Mostrando <strong>{(current - 1) * pageSize + 1}–{Math.min(current * pageSize, filtered.length)}</strong> de{' '}
                <strong>{number.format(filtered.length)}</strong>
              </span>
              <span className="wa-pager">
                <label>
                  Por página
                  <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
                    {[25, 50, 100].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="wa-icon-btn" disabled={current <= 1} onClick={() => setPage(current - 1)} aria-label="Página anterior">‹</button>
                <span>{current} / {pages}</span>
                <button type="button" className="wa-icon-btn" disabled={current >= pages} onClick={() => setPage(current + 1)} aria-label="Próxima página">›</button>
              </span>
            </footer>
          </>
        )}
      </div>

      {toolsStore && (
        <StoreToolsDialog key={toolsStore.id} storeId={toolsStore.storeId} storeName={toolsStore.name} onClose={() => setToolsStore(null)} />
      )}
      {billingStore && <BillingDialog key={billingStore.id} store={billingStore} onClose={closeBilling} onChanged={onChanged} />}
      {segmentStore && <SegmentDialog key={segmentStore.id} store={segmentStore} onClose={closeSegment} onChanged={onChanged} />}
    </AdminShell>
  )
}
