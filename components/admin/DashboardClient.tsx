'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminShell from './AdminShell'
import {
  fetchOrdersDashboard,
  fetchPlatformStores,
  fetchPlatformTraffic,
  fetchPublicCatalog,
  fetchStoreConfig,
  fetchStoreStats,
  probeServiceHealth,
  type HealthProbe,
  type OrdersDashboard,
  type PlatformStore,
  type PublicCatalog,
  type StoreConfig,
  type StoreStats,
  type TrafficSummary,
} from '@/lib/admin-api'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const number = new Intl.NumberFormat('pt-BR')

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('pt-BR')
}

function statusPillClass(status: string) {
  const value = String(status || '').toLowerCase()
  if (value === 'active') return 'wa-pill is-active'
  if (value === 'setup') return 'wa-pill is-setup'
  return 'wa-pill'
}

interface DashboardData {
  stores: PlatformStore[]
  traffic: TrafficSummary | null
  stats: StoreStats | null
  orders: OrdersDashboard | null
  store: StoreConfig | null
  catalog: PublicCatalog | null
  health: HealthProbe[]
}

function Kpi({
  icon,
  label,
  value,
  hint,
  tone = 'brand',
}: {
  icon: string
  label: string
  value: string
  hint?: string
  tone?: 'brand' | 'success' | 'accent' | 'error'
}) {
  return (
    <div className={`wa-card wa-panel wa-kpi tone-${tone}`}>
      <div className="wa-kpi-top">
        <span className="wa-kpi-label">{label}</span>
        <span className="wa-kpi-icon" aria-hidden>
          {icon}
        </span>
      </div>
      <span className="wa-kpi-value">{value}</span>
      {hint && <span className="wa-kpi-hint">{hint}</span>}
    </div>
  )
}

function Panel({
  title,
  note,
  children,
}: {
  title: string
  note?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="wa-card wa-panel">
      <div className="wa-panel-head">
        <h2 className="wa-panel-title">{title}</h2>
        {note && <span className="wa-panel-note">{note}</span>}
      </div>
      {children}
    </section>
  )
}

export default function DashboardClient() {
  const [data, setData] = useState<DashboardData>({
    stores: [],
    traffic: null,
    stats: null,
    orders: null,
    store: null,
    catalog: null,
    health: [],
  })
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const [stores, traffic, stats, orders, store, catalog, health] = await Promise.allSettled([
      fetchPlatformStores(),
      fetchPlatformTraffic(7),
      fetchStoreStats(),
      fetchOrdersDashboard('today'),
      fetchStoreConfig(),
      fetchPublicCatalog(),
      probeServiceHealth(),
    ])

    setData({
      stores: stores.status === 'fulfilled' ? stores.value : [],
      traffic: traffic.status === 'fulfilled' ? traffic.value : null,
      stats: stats.status === 'fulfilled' ? stats.value : null,
      orders: orders.status === 'fulfilled' ? orders.value : null,
      store: store.status === 'fulfilled' ? store.value : null,
      catalog: catalog.status === 'fulfilled' ? catalog.value : null,
      health: health.status === 'fulfilled' ? health.value : [],
    })
    setUpdatedAt(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const metrics = useMemo(() => {
    const stores = data.stores
    const active = stores.filter((s) => String(s.status).toLowerCase() === 'active')
    const setup = stores.filter((s) => String(s.status).toLowerCase() === 'setup')
    const inactive = stores.filter((s) => String(s.status).toLowerCase() === 'inactive')
    const recurring = active.filter((s) => !s.courtesy && Number(s.monthlyFee) > 0)
    const mrr = recurring.reduce((sum, s) => sum + Number(s.monthlyFee || 0), 0)
    const overdue = stores.filter((s) => String(s.paymentStatus).toLowerCase() === 'overdue')

    const products = (data.catalog?.categories ?? [])
      .filter((c) => c.showInMenu !== false)
      .flatMap((c) => c.items ?? [])
    const withoutPrice = products.filter((p) => !p.price || Number(p.price) <= 0)

    return {
      total: stores.length,
      active: active.length,
      setup: setup.length,
      inactive: inactive.length,
      mrr,
      overdue,
      products: products.length,
      withoutPrice: withoutPrice.length,
      categories: data.catalog?.categories?.length ?? 0,
    }
  }, [data])

  const alerts = useMemo(() => {
    const list: { tone: 'error' | 'accent'; text: string }[] = []
    data.health
      .filter((h) => !h.ok)
      .forEach((h) =>
        list.push({
          tone: 'error',
          text: `Serviço ${h.label} indisponível${h.status ? ` (HTTP ${h.status})` : ''}.`,
        })
      )
    if (metrics.overdue.length > 0)
      list.push({
        tone: 'accent',
        text: `${metrics.overdue.length} loja(s) com pagamento em atraso: ${metrics.overdue
          .map((s) => s.name)
          .slice(0, 3)
          .join(', ')}.`,
      })
    if (metrics.withoutPrice > 0)
      list.push({
        tone: 'accent',
        text: `${metrics.withoutPrice} produto(s) sem preço no cardápio da loja atual.`,
      })
    if (data.stats?.error)
      list.push({ tone: 'accent', text: `Estatísticas da loja: ${data.stats.error}` })
    return list
  }, [data.health, data.stats, metrics])

  const daily = data.traffic?.daily ?? []
  const maxDaily = daily.reduce((max, d) => Math.max(max, d.pageviews), 1)
  const sortedStores = useMemo(
    () => [...data.stores].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    [data.stores]
  )

  return (
    <AdminShell
      title="Dashboard"
      subtitle="Visão geral da plataforma e das lojas"
      actions={
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="wa-btn wa-btn-ghost"
        >
          {loading ? 'Atualizando…' : '↻ Atualizar'}
        </button>
      }
    >
      <div className="wa-grid wa-kpis mb-8">
        <Kpi
          icon="🏪"
          label="Lojas"
          value={number.format(metrics.total)}
          hint={`${metrics.active} ativas · ${metrics.setup} em setup · ${metrics.inactive} inativas`}
        />
        <Kpi
          icon="💰"
          label="Receita recorrente"
          value={currency.format(metrics.mrr)}
          hint={`${metrics.overdue.length} em atraso`}
          tone={metrics.overdue.length ? 'accent' : 'success'}
        />
        <Kpi
          icon="🧾"
          label="Pedidos hoje"
          value={data.orders ? number.format(data.orders.ordersToday) : '—'}
          hint={
            data.orders
              ? `${currency.format(data.orders.grossRevenue)} faturado`
              : 'orders-api indisponível'
          }
        />
        <Kpi
          icon="📈"
          label="Acessos (7 dias)"
          value={data.traffic ? number.format(data.traffic.pageviewsPeriod) : '—'}
          hint={data.traffic ? `${number.format(data.traffic.pageviewsToday)} hoje` : 'sem dados'}
        />
      </div>

      <div className="wa-grid wa-cols-3 mb-8">
        <Panel title="Alertas" note={alerts.length}>
          {alerts.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Nenhum alerta. Tudo operando.</p>
          ) : (
            <ul className="space-y-2">
              {alerts.map((a, i) => (
                <li key={i} className={`wa-alert ${a.tone === 'error' ? 'is-error' : 'is-warn'}`}>
                  {a.text}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Saúde dos serviços" note="gateway · catalog · orders">
          <ul className="space-y-2">
            {data.health.map((h) => (
              <li key={h.label} className="wa-row">
                <span className="text-sm">{h.label}</span>
                <span
                  className={`text-sm ${h.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}
                >
                  {h.ok ? '● online' : `● offline${h.status ? ` (${h.status})` : ''}`}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Cardápio da loja atual">
          <dl className="wa-dl">
            <dt>Categorias</dt>
            <dd>{number.format(metrics.categories)}</dd>
            <dt>Produtos</dt>
            <dd>{number.format(metrics.products)}</dd>
            <dt>Sem preço</dt>
            <dd className={metrics.withoutPrice ? 'text-[var(--accent)]' : ''}>
              {number.format(metrics.withoutPrice)}
            </dd>
            <dt>Loja</dt>
            <dd>{data.store?.name || '—'}</dd>
            <dt>Último acesso</dt>
            <dd>{formatDate(data.stats?.lastAccessAt)}</dd>
          </dl>
        </Panel>
      </div>

      <div className="wa-grid wa-cols-2">
        <Panel title="Acessos ao cardápio (7 dias)" note={`pico ${data.traffic?.peakHourLabel ?? '—'}`}>
          {daily.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Sem dados de tráfego.</p>
          ) : (
            <div className="wa-chart">
              {daily.map((d) => (
                <div key={d.date} className="wa-chart-col">
                  <div
                    className="wa-bar"
                    style={{ height: `${Math.max(4, (d.pageviews / maxDaily) * 100)}%` }}
                    title={`${d.date}: ${number.format(d.pageviews)} acessos`}
                  />
                  <span className="wa-chart-label">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Lojas"
          note={
            <Link href="/admin/lojas" className="text-[var(--brand-light)]">
              ver todas →
            </Link>
          }
        >
          {sortedStores.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Nenhuma loja cadastrada.</p>
          ) : (
            <ul>
              {sortedStores.slice(0, 6).map((s) => (
                <li key={s.id} className="wa-row">
                  <div className="min-w-0">
                    <p className="truncate text-sm">{s.name}</p>
                    <p className="truncate text-xs text-[var(--text-faint)]">
                      {[s.city, s.state].filter(Boolean).join(' · ') || s.plan || '—'}
                    </p>
                  </div>
                  <span className={statusPillClass(s.status)}>{s.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <p className="mt-4 text-right text-[11px] text-[var(--text-faint)]">
        {updatedAt ? `Atualizado às ${updatedAt.toLocaleTimeString('pt-BR')}` : 'Carregando…'}
      </p>
    </AdminShell>
  )
}
