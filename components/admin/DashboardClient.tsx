'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import AdminShell from './AdminShell'
import AuditTimeline from './AuditTimeline'
import { ReminderButton, billingPillClass, billingSummary, daysUntil } from './BillingDialog'
import { storeFlags } from './LojasClient'
import {
  fetchPlatformAudit,
  fetchPlatformOverview,
  fetchPlatformStores,
  fetchPlatformTraffic,
  probeServiceHealth,
  type AuditEntry,
  type HealthProbe,
  type PlatformStore,
  type PlatformStoreActivity,
  type TrafficSummary,
} from '@/lib/admin-api'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const number = new Intl.NumberFormat('pt-BR')
const percent = new Intl.NumberFormat('pt-BR', { style: 'percent', maximumFractionDigits: 0 })
const HIDDEN_KEY = 'wa-admin-hidden-stores'
const DAY_MS = 86_400_000
/** Mesmo prazo do catalog-api (Signup:AbandonAfterDays) para avisar antes da desativação. */
const ABANDON_AFTER_DAYS = 7

interface DashboardData {
  stores: PlatformStore[]
  activity: Map<string, PlatformStoreActivity>
  audit: AuditEntry[] | null
  traffic: TrafficSummary | null
  health: HealthProbe[]
}

function Kpi({ icon, label, value, hint, tone = 'brand' }: {
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
        <span className="wa-kpi-icon" aria-hidden>{icon}</span>
      </div>
      <span className="wa-kpi-value">{value}</span>
      {hint && <span className="wa-kpi-hint">{hint}</span>}
    </div>
  )
}

function Panel({ title, note, children, className = '' }: { title: string; note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`wa-card wa-panel ${className}`}>
      <div className="wa-panel-head">
        <h2 className="wa-panel-title">{title}</h2>
        {note && <span className="wa-panel-note">{note}</span>}
      </div>
      {children}
    </section>
  )
}

function readHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[])
  } catch {
    return new Set()
  }
}

/** Início da semana (segunda-feira, horário local) de uma data. */
function weekStart(d: Date) {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const dow = (day.getDay() + 6) % 7
  day.setDate(day.getDate() - dow)
  return day
}

export default function DashboardClient() {
  const [data, setData] = useState<DashboardData>({ stores: [], activity: new Map(), audit: null, traffic: null, health: [] })
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setHidden(readHidden())
    const [stores, overview, audit, traffic, health] = await Promise.allSettled([
      fetchPlatformStores(),
      fetchPlatformOverview(),
      fetchPlatformAudit(12),
      fetchPlatformTraffic(7),
      probeServiceHealth(),
    ])
    setData({
      stores: stores.status === 'fulfilled' ? stores.value : [],
      activity: new Map((overview.status === 'fulfilled' ? overview.value : []).map((a) => [a.platformStoreId, a])),
      audit: audit.status === 'fulfilled' ? audit.value : [],
      traffic: traffic.status === 'fulfilled' ? traffic.value : null,
      health: health.status === 'fulfilled' ? health.value : [],
    })
    setUpdatedAt(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const m = useMemo(() => {
    const now = Date.now()
    const stores = data.stores.filter((s) => !hidden.has(s.id))
    const act = (s: PlatformStore) => data.activity.get(s.id)
    const paying = stores.filter((s) => s.active && !s.courtesy && Number(s.monthlyFee) > 0)
    const trial = stores.filter((s) => s.active && s.courtesy)
    const flags = stores.map((s) => ({ s, f: storeFlags(s) }))
    const created = (s: PlatformStore) => (s.createdAt ? new Date(s.createdAt).getTime() : 0)

    // Lojas que serão desativadas por abandono em breve (dono nunca entrou).
    const nearAbandon = stores
      .filter((s) => s.active && !s.lastAccessAt && s.plan === 'teste' && created(s) > 0)
      .map((s) => ({ s, left: ABANDON_AFTER_DAYS - Math.floor((now - created(s)) / DAY_MS) }))
      .filter((x) => x.left >= 0 && x.left <= 2)

    // Cadastros por semana (8 semanas).
    const thisWeek = weekStart(new Date())
    const weeks = Array.from({ length: 8 }, (_, i) => {
      const start = new Date(thisWeek)
      start.setDate(start.getDate() - (7 - i) * 7)
      const end = new Date(start)
      end.setDate(end.getDate() + 7)
      return {
        label: start.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        count: stores.filter((s) => created(s) >= start.getTime() && created(s) < end.getTime()).length,
      }
    })

    const funnel = [
      { label: 'Cadastradas', value: stores.length },
      { label: 'Dono entrou no painel', value: stores.filter((s) => s.lastAccessAt).length },
      { label: 'Cadastrou produto próprio', value: stores.filter((s) => (act(s)?.ownProducts ?? 0) > 0).length },
      { label: 'Recebeu pedido', value: stores.filter((s) => (act(s)?.ordersTotal ?? 0) > 0).length },
    ]

    const ranking = stores
      .map((s) => ({ s, orders: act(s)?.orders30d ?? 0, views: act(s)?.menuViews30d ?? 0 }))
      .filter((x) => x.orders > 0 || x.views > 0)
      .sort((a, b) => b.orders - a.orders || b.views - a.views)
      .slice(0, 10)

    return {
      total: stores.length,
      hiddenCount: data.stores.length - stores.length,
      paying,
      trial,
      blocked: flags.filter((x) => x.f.blocked || x.f.abandoned).map((x) => x.s),
      overdue: flags.filter((x) => x.f.overdue).map((x) => x.s),
      trialEnding: flags.filter((x) => x.f.trial).map((x) => x.s),
      nearAbandon,
      mrr: paying.reduce((sum, s) => sum + Number(s.monthlyFee || 0), 0),
      signups30: stores.filter((s) => now - created(s) <= 30 * DAY_MS).length,
      signups7: stores.filter((s) => now - created(s) <= 7 * DAY_MS).length,
      orders30: stores.reduce((sum, s) => sum + (act(s)?.orders30d ?? 0), 0),
      storesWithOrders: stores.filter((s) => (act(s)?.orders30d ?? 0) > 0).length,
      weeks,
      funnel,
      ranking,
    }
  }, [data, hidden])

  const offline = data.health.filter((h) => !h.ok)
  const actionCount = m.overdue.length + m.trialEnding.length + m.blocked.length + m.nearAbandon.length + offline.length
  const maxWeek = Math.max(1, ...m.weeks.map((w) => w.count))
  const daily = data.traffic?.daily ?? []
  const maxDaily = daily.reduce((max, d) => Math.max(max, d.pageviews), 1)
  const funnelBase = Math.max(1, m.funnel[0].value)

  const storeLink = (s: PlatformStore) => (
    <Link href={`/admin/lojas/${s.id}`} className="truncate font-semibold hover:underline">{s.name}</Link>
  )

  return (
    <AdminShell
      title="Dashboard"
      subtitle="Visão geral do negócio"
      actions={
        <button type="button" onClick={() => void load()} disabled={loading} className="wa-btn wa-btn-ghost">
          {loading ? 'Atualizando…' : '↻ Atualizar'}
        </button>
      }
    >
      <div className="wa-grid wa-kpis mb-8">
        <Kpi icon="💰" label="Receita recorrente" value={currency.format(m.mrr)} hint={`${m.paying.length} loja(s) pagante(s)`} tone={m.overdue.length ? 'accent' : 'success'} />
        <Kpi icon="🏪" label="Lojas" value={number.format(m.total)} hint={`${m.paying.length} pagantes · ${m.trial.length} em teste · ${m.blocked.length} fora do ar`} />
        <Kpi icon="✨" label="Cadastros (30 dias)" value={number.format(m.signups30)} hint={`${m.signups7} nos últimos 7 dias`} />
        <Kpi icon="🧾" label="Pedidos (30 dias)" value={number.format(m.orders30)} hint={`em ${m.storesWithOrders} loja(s)`} />
      </div>

      <div className="wa-grid wa-cols-2 mb-8">
        <Panel title="Ações do dia" note={actionCount}>
          {actionCount === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Nada pendente. Tudo em dia.</p>
          ) : (
            <ul className="wa-actions-list">
              {offline.map((h) => (
                <li key={h.label} className="is-error">
                  <span>Serviço {h.label} indisponível{h.status ? ` (HTTP ${h.status})` : ''}</span>
                </li>
              ))}
              {m.overdue.map((s) => (
                <li key={`o-${s.id}`}>
                  <span className="min-w-0">{storeLink(s)} <span className={billingPillClass('error')}>{billingSummary(s).label}</span></span>
                  <ReminderButton store={s} className="wa-btn wa-btn-ghost wa-btn-sm" />
                </li>
              ))}
              {m.trialEnding.map((s) => (
                <li key={`t-${s.id}`}>
                  <span className="min-w-0">{storeLink(s)} <span className={billingPillClass('warn')}>{billingSummary(s).label}</span></span>
                  <ReminderButton store={s} className="wa-btn wa-btn-ghost wa-btn-sm" />
                </li>
              ))}
              {m.blocked.map((s) => (
                <li key={`b-${s.id}`}>
                  <span className="min-w-0">{storeLink(s)} <span className={billingPillClass('error')}>{billingSummary(s).label}</span></span>
                  <Link href={`/admin/lojas/${s.id}#cobranca`} className="wa-btn wa-btn-ghost wa-btn-sm">Resolver</Link>
                </li>
              ))}
              {m.nearAbandon.map(({ s, left }) => (
                <li key={`a-${s.id}`}>
                  <span className="min-w-0">
                    {storeLink(s)}{' '}
                    <span className={billingPillClass('warn')}>
                      {left === 0 ? 'Desativa hoje' : `Desativa em ${left} dia(s)`} · dono nunca entrou
                    </span>
                  </span>
                  <Link href={`/admin/lojas/${s.id}#usuarios`} className="wa-btn wa-btn-ghost wa-btn-sm">Contatar</Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Ativação dos lojistas" note="funil">
          <ol className="wa-funnel">
            {m.funnel.map((step) => (
              <li key={step.label}>
                <div className="wa-funnel-row">
                  <span>{step.label}</span>
                  <span>
                    <strong>{number.format(step.value)}</strong>{' '}
                    <span className="text-[var(--text-faint)]">{percent.format(step.value / funnelBase)}</span>
                  </span>
                </div>
                <div className="wa-funnel-bar"><i style={{ width: `${(step.value / funnelBase) * 100}%` }} /></div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>

      <div className="wa-grid wa-cols-2 mb-8">
        <Panel title="Pedidos por loja (30 dias)" note={<Link href="/admin/lojas" className="text-[var(--brand-light)]">ver lojas →</Link>}>
          {m.ranking.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">Nenhum pedido ou acesso nos últimos 30 dias.</p>
          ) : (
            <ol className="wa-ranking">
              {m.ranking.map(({ s, orders, views }, i) => (
                <li key={s.id} className="wa-row">
                  <span className="min-w-0">
                    <span className="wa-rank">{i + 1}</span>
                    {storeLink(s)}
                  </span>
                  <span className="shrink-0 text-sm">
                    <strong>{number.format(orders)}</strong> pedidos
                    <span className="ml-2 text-xs text-[var(--text-faint)]">{number.format(views)} acessos</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="Cadastros por semana" note="8 semanas">
          <div className="wa-chart">
            {m.weeks.map((w) => (
              <div key={w.label} className="wa-chart-col">
                <div className="wa-bar" style={{ height: `${Math.max(4, (w.count / maxWeek) * 100)}%` }} title={`Semana de ${w.label}: ${w.count} cadastro(s)`} />
                <span className="wa-chart-label">{w.label}</span>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="wa-grid wa-cols-3">
        <Panel title="Atividade recente" className="wa-span-2">
          <AuditTimeline entries={data.audit} showStore empty="Nenhuma ação registrada ainda." />
        </Panel>

        <div className="grid gap-4">
          <Panel title="Saúde dos serviços" note="gateway · catalog · orders">
            <ul className="space-y-2">
              {data.health.map((h) => (
                <li key={h.label} className="wa-row">
                  <span className="text-sm">{h.label}</span>
                  <span className={`text-sm ${h.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                    {h.ok ? '● online' : `● offline${h.status ? ` (${h.status})` : ''}`}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Acessos aos cardápios" note="7 dias">
            {daily.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">Sem dados de tráfego.</p>
            ) : (
              <div className="wa-chart">
                {daily.map((d) => (
                  <div key={d.date} className="wa-chart-col">
                    <div className="wa-bar" style={{ height: `${Math.max(4, (d.pageviews / maxDaily) * 100)}%` }} title={`${d.date}: ${number.format(d.pageviews)} acessos`} />
                    <span className="wa-chart-label">{d.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>

      <p className="mt-4 text-right text-[11px] text-[var(--text-faint)]">
        {m.hiddenCount > 0 && `${m.hiddenCount} loja(s) oculta(s) na lista não entram nos números · `}
        {updatedAt ? `Atualizado às ${updatedAt.toLocaleTimeString('pt-BR')}` : 'Carregando…'}
      </p>
    </AdminShell>
  )
}
