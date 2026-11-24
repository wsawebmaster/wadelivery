'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import AdminShell from './AdminShell'
import { fetchPlatformStores, type PlatformStore } from '@/lib/admin-api'
import StoreToolsDialog from './StoreToolsDialog'
import BillingDialog, { billingPillClass, billingSummary, formatBillingDay } from './BillingDialog'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const number = new Intl.NumberFormat('pt-BR')

function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('pt-BR')
}

function statusPill(status: string) {
  const value = String(status || '').toLowerCase()
  if (value === 'active') return 'wa-pill is-active'
  if (value === 'setup') return 'wa-pill is-setup'
  return 'wa-pill'
}

export default function LojasClient() {
  const [stores, setStores] = useState<PlatformStore[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [toolsStore, setToolsStore] = useState<{ id: string; name: string; storeId: number } | null>(null)
  const [billingStore, setBillingStore] = useState<PlatformStore | null>(null)
  const closeBilling = useCallback(() => setBillingStore(null), [])
  const onBillingChanged = useCallback((updated: PlatformStore) => {
    setStores((list) => list.map((s) => (s.id === updated.id ? { ...s, ...updated, stats: s.stats } : s)))
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
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return stores
      .filter((s) => (status === 'all' ? true : String(s.status).toLowerCase() === status))
      .filter((s) => {
        if (!term) return true
        return [s.name, s.city, s.state, s.plan, s.email, s.contactName]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term))
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  }, [stores, search, status])

  const counts = useMemo(() => {
    const by = (value: string) =>
      stores.filter((s) => String(s.status).toLowerCase() === value).length
    return { all: stores.length, active: by('active'), setup: by('setup'), inactive: by('inactive') }
  }, [stores])

  return (
    <AdminShell
      title="Lojas"
      subtitle="Todas as lojas da plataforma"
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
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome, cidade, plano…"
          className="wa-input md:max-w-sm"
        />
        <div className="flex flex-wrap gap-2">
          {[
            ['all', `Todas (${counts.all})`],
            ['active', `Ativas (${counts.active})`],
            ['setup', `Setup (${counts.setup})`],
            ['inactive', `Inativas (${counts.inactive})`],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                status === value
                  ? 'border-[var(--brand-light)] text-[var(--text)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="wa-alert is-error mb-4">{error}</p>
      )}

      {loading && stores.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Carregando lojas…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">Nenhuma loja encontrada.</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((s) => {
            const menuUrl = s.frontUrl || (s.domain ? `https://${s.domain}` : null)
            const adminUrl = s.adminUrl || null
            const hasStoreId = typeof s.storeId === 'number'
              && Number.isInteger(s.storeId)
              && s.storeId > 0
            const billing = billingSummary(s)
            return (
              <article key={s.id} className="wa-card flex flex-col p-4">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-[family-name:var(--font-head)] text-base font-semibold">
                      {s.name}
                    </h2>
                    <p className="truncate text-xs text-[var(--text-faint)]">
                      {[s.segment, s.plan].filter(Boolean).join(' · ') || '—'}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase ${statusPill(
                      s.status
                    )}`}
                  >
                    {s.status}
                  </span>
                </div>

                <dl className="mb-3 grid grid-cols-2 gap-y-1.5 text-xs">
                  <dt className="text-[var(--text-muted)]">Cidade</dt>
                  <dd className="truncate text-right">
                    {[s.city, s.state].filter(Boolean).join(' / ') || '—'}
                  </dd>
                  <dt className="text-[var(--text-muted)]">Mensalidade</dt>
                  <dd className="text-right">
                    {currency.format(Number(s.monthlyFee || 0))}
                  </dd>
                  <dt className="text-[var(--text-muted)]">Cobrança</dt>
                  <dd className="text-right">
                    <span className={billingPillClass(billing.tone)}>{billing.label}</span>
                  </dd>
                  <dt className="text-[var(--text-muted)]">Próx. vencimento</dt>
                  <dd className="text-right">{formatBillingDay(s.nextDueAt)}</dd>
                  <dt className="text-[var(--text-muted)]">Último acesso</dt>
                  <dd className="text-right">{formatDate(s.lastAccessAt)}</dd>
                  <dt className="text-[var(--text-muted)]">Cardápio 30d</dt>
                  <dd className="text-right">{number.format(Number(s.stats?.menuViews30d || 0))}</dd>
                  <dt className="text-[var(--text-muted)]">Pedidos 30d</dt>
                  <dd className="text-right">
                    {s.stats?.ordersAvailable === false
                      ? '—'
                      : number.format(Number(s.stats?.orders30d || 0))}
                  </dd>
                </dl>

                <div className="mt-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="wa-btn wa-btn-ghost"
                    disabled={!hasStoreId}
                    title={hasStoreId ? 'Verificar e administrar esta loja' : 'Loja sem tenant vinculado (StoreId).'}
                    onClick={() => {
                      if (typeof s.storeId === 'number' && Number.isInteger(s.storeId) && s.storeId > 0) {
                        setToolsStore({ id: s.id, name: s.name, storeId: s.storeId })
                      }
                    }}
                  >
                    Administrar
                  </button>
                  <button type="button" className="wa-btn wa-btn-ghost" onClick={() => setBillingStore(s)}>
                    Cobrança
                  </button>
                  <Link href="/admin/legado" className="wa-btn wa-btn-primary">
                    Gerenciar
                  </Link>
                  {menuUrl && (
                    <a
                      href={menuUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="wa-btn wa-btn-ghost"
                    >
                      Cardápio ↗
                    </a>
                  )}
                  {adminUrl && (
                    <a
                      href={adminUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="wa-btn wa-btn-ghost"
                    >
                      Painel da loja ↗
                    </a>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}
      {toolsStore && (
        <StoreToolsDialog
          key={toolsStore.id}
          storeId={toolsStore.storeId}
          storeName={toolsStore.name}
          onClose={() => setToolsStore(null)}
        />
      )}
      {billingStore && (
        <BillingDialog
          key={billingStore.id}
          store={billingStore}
          onClose={closeBilling}
          onChanged={onBillingChanged}
        />
      )}
    </AdminShell>
  )
}
