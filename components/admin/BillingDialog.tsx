'use client'

import { useEffect, useRef, useState } from 'react'
import {
  logReminder,
  registerPlatformPayment,
  setPlatformStoreBlocked,
  updatePlatformBilling,
  type PlatformStore,
} from '@/lib/admin-api'
import { reminderMessage, whatsappUrl } from '@/lib/billing-reminder'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const DAY_MS = 86_400_000

/** Datas de cobrança são dias (UTC), iguais ao cálculo do catalog-api. */
export function formatBillingDay(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

function toDayInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

/** "2026-12-05" → meio-dia UTC, para não virar o dia anterior em nenhum fuso. */
function fromDayInput(value: string) {
  return value ? `${value}T12:00:00Z` : null
}

function todayInput() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

export function utcDay(value: string | Date) {
  const d = new Date(value)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** Dias até a data (negativo = já passou), em dias UTC. */
export function daysUntil(value?: string | null, now = new Date()): number | null {
  if (!value) return null
  const t = new Date(value)
  if (Number.isNaN(t.getTime())) return null
  return Math.round((utcDay(t) - utcDay(now)) / DAY_MS)
}

export type BillingTone = 'ok' | 'warn' | 'error' | 'muted'

/** Resumo da cobrança para o card da loja. */
export function billingSummary(store: PlatformStore): { label: string; tone: BillingTone } {
  if (store.abandonedAt && !store.active) return { label: 'Desativada por abandono', tone: 'error' }
  if (store.billingBlocked) return { label: 'Bloqueada por atraso', tone: 'error' }
  if (!store.active) return { label: 'Bloqueada manualmente', tone: 'error' }
  if (store.courtesy) {
    if (!store.courtesyUntil) return { label: 'Cortesia', tone: 'muted' }
    const left = daysUntil(store.courtesyUntil) ?? 0
    return { label: left > 0 ? `Teste grátis · ${left} dia(s)` : 'Teste grátis terminando', tone: left <= 7 ? 'warn' : 'muted' }
  }
  if (!store.monthlyFee || Number(store.monthlyFee) <= 0) return { label: 'Sem mensalidade', tone: 'muted' }
  if (!store.nextDueAt) return { label: 'Sem vencimento definido', tone: 'warn' }
  const diff = daysUntil(store.nextDueAt) ?? 0
  if (diff < 0) return { label: `Vencida há ${-diff} dia(s)`, tone: 'error' }
  if (diff === 0) return { label: 'Vence hoje', tone: 'warn' }
  if (diff <= 5) return { label: `Vence em ${diff} dia(s)`, tone: 'warn' }
  return { label: `Em dia · vence ${formatBillingDay(store.nextDueAt)}`, tone: 'ok' }
}

export function billingPillClass(tone: BillingTone) {
  if (tone === 'ok') return 'wa-pill is-active'
  if (tone === 'warn') return 'wa-pill is-setup'
  if (tone === 'error') return 'wa-pill is-error'
  return 'wa-pill'
}

/** Botão "Lembrar pelo WhatsApp": abre o wa.me com a mensagem e registra no histórico. */
export function ReminderButton({ store, className = 'wa-btn wa-btn-ghost' }: { store: PlatformStore; className?: string }) {
  const url = whatsappUrl(store.phone, reminderMessage(store))
  return (
    <a
      href={url ?? undefined}
      target="_blank"
      rel="noreferrer"
      aria-disabled={!url}
      title={url ? 'Abre o WhatsApp com a mensagem pronta' : 'Loja sem telefone cadastrado'}
      className={`${className} ${url ? '' : 'pointer-events-none opacity-50'}`}
      onClick={() => {
        if (url) void logReminder(store.id, billingSummary(store).label).catch(() => {})
      }}
    >
      Lembrar pelo WhatsApp
    </a>
  )
}

interface PanelProps {
  store: PlatformStore
  onChanged: (store: PlatformStore) => void
  /** Mostra o botão de bloqueio (a página da loja tem a própria zona de risco). */
  showBlock?: boolean
}

/** Conteúdo da cobrança: plano, pagamento, lembrete e histórico (diálogo e página da loja). */
export function BillingPanel({ store, onChanged, showBlock = true }: PanelProps) {
  const [current, setCurrent] = useState(store)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const [fee, setFee] = useState(String(store.monthlyFee ?? 0))
  const [courtesy, setCourtesy] = useState(Boolean(store.courtesy))
  const [courtesyUntil, setCourtesyUntil] = useState(toDayInput(store.courtesyUntil))
  const [nextDue, setNextDue] = useState(toDayInput(store.nextDueAt))
  const [notes, setNotes] = useState(String(store.paymentNotes ?? ''))

  const [payDate, setPayDate] = useState(todayInput())
  const [payAmount, setPayAmount] = useState(String(store.monthlyFee ?? 0))
  const [payNote, setPayNote] = useState('')

  function applyResult(updated: PlatformStore, text: string) {
    setCurrent(updated)
    setNextDue(toDayInput(updated.nextDueAt))
    setCourtesy(Boolean(updated.courtesy))
    setCourtesyUntil(toDayInput(updated.courtesyUntil))
    setMessage(text)
    onChanged(updated)
  }

  async function run(key: string, task: () => Promise<void>) {
    if (busy) return
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      await task()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A operação não foi concluída.')
    } finally {
      setBusy(null)
    }
  }

  const saveSettings = () =>
    run('save', async () => {
      const monthlyFee = Number(fee.replace(',', '.'))
      if (!Number.isFinite(monthlyFee) || monthlyFee < 0) throw new Error('Informe uma mensalidade válida.')
      const updated = await updatePlatformBilling(current.id, {
        monthlyFee,
        courtesy,
        courtesyUntil: courtesy && courtesyUntil ? fromDayInput(courtesyUntil) : null,
        clearCourtesyUntil: courtesy && !courtesyUntil,
        nextDueAt: fromDayInput(nextDue),
        paymentNotes: notes.trim(),
      })
      applyResult(updated, 'Cobrança atualizada.')
    })

  const registerPayment = () =>
    run('pay', async () => {
      const amount = Number(payAmount.replace(',', '.'))
      if (!Number.isFinite(amount) || amount < 0) throw new Error('Informe um valor válido.')
      if (!payDate) throw new Error('Informe a data do pagamento.')
      const updated = await registerPlatformPayment(current.id, {
        paidAt: fromDayInput(payDate) ?? undefined,
        amount,
        note: payNote.trim() || undefined,
      })
      setPayNote('')
      applyResult(updated, `Pagamento registrado. Próximo vencimento: ${formatBillingDay(updated.nextDueAt)}.`)
    })

  const toggleBlock = () =>
    run('block', async () => {
      const block = current.active
      if (block && !window.confirm(`Bloquear "${current.name}"? O cardápio sai do ar e os pedidos são recusados.`)) return
      const updated = await setPlatformStoreBlocked(current.id, block)
      applyResult(updated, block ? 'Loja bloqueada.' : 'Loja desbloqueada.')
    })

  const payments = Array.isArray(current.payments) ? current.payments : []

  return (
    <div className="wa-form-section">
      {error && <p className="wa-alert is-error">{error}</p>}
      {message && <p className="wa-alert is-ok">{message}</p>}

      <h3 className="text-sm font-semibold">Plano</h3>
      <div className="grid gap-x-3 sm:grid-cols-2">
        <label className="wa-field">
          <span className="wa-label">Mensalidade (R$)</span>
          <input className="wa-input" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <label className="wa-field">
          <span className="wa-label">Próximo vencimento</span>
          <input className="wa-input" type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
        </label>
        <label className="wa-field flex items-center gap-2 sm:col-span-1">
          <input type="checkbox" checked={courtesy} onChange={(e) => setCourtesy(e.target.checked)} />
          <span className="text-sm">Cortesia / teste grátis</span>
        </label>
        <label className="wa-field">
          <span className="wa-label">Cortesia até (vazio = sem prazo)</span>
          <input
            className="wa-input"
            type="date"
            value={courtesyUntil}
            disabled={!courtesy}
            onChange={(e) => setCourtesyUntil(e.target.value)}
          />
        </label>
        <label className="wa-field sm:col-span-2">
          <span className="wa-label">Observações</span>
          <textarea className="wa-input" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>
      <div className="wa-actions">
        <button type="button" className="wa-btn wa-btn-primary" disabled={!!busy} onClick={() => void saveSettings()}>
          {busy === 'save' ? 'Salvando…' : 'Salvar plano'}
        </button>
        <ReminderButton store={current} />
        {showBlock && (
          <button
            type="button"
            className={`wa-btn wa-btn-ghost ${current.active ? 'wa-btn-danger' : ''}`}
            disabled={!!busy}
            onClick={() => void toggleBlock()}
          >
            {busy === 'block' ? 'Aguarde…' : current.active ? 'Bloquear loja' : 'Desbloquear loja'}
          </button>
        )}
      </div>

      <h3 className="text-sm font-semibold">Registrar pagamento</h3>
      <div className="grid gap-x-3 sm:grid-cols-3">
        <label className="wa-field">
          <span className="wa-label">Data</span>
          <input className="wa-input" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
        </label>
        <label className="wa-field">
          <span className="wa-label">Valor (R$)</span>
          <input className="wa-input" inputMode="decimal" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
        </label>
        <label className="wa-field">
          <span className="wa-label">Observação</span>
          <input
            className="wa-input"
            placeholder="Pix, dinheiro, permuta…"
            maxLength={200}
            value={payNote}
            onChange={(e) => setPayNote(e.target.value)}
          />
        </label>
      </div>
      <p className="wa-hint text-xs text-[var(--text-muted)]">
        O pagamento quita o vencimento atual, avança o próximo em um mês e desbloqueia a loja se ela foi bloqueada por
        atraso.
      </p>
      <button type="button" className="wa-btn wa-btn-primary" disabled={!!busy} onClick={() => void registerPayment()}>
        {busy === 'pay' ? 'Registrando…' : 'Registrar pagamento'}
      </button>

      <h3 className="text-sm font-semibold">Pagamentos</h3>
      {payments.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Nenhum pagamento registrado.</p>
      ) : (
        <ul className="text-sm">
          {payments.map((p, i) => (
            <li key={`${p.paidAt}-${i}`} className="wa-row !justify-start">
              <span className="w-24 shrink-0">{formatBillingDay(p.paidAt)}</span>
              <span className="w-28 shrink-0 font-semibold">{currency.format(Number(p.amount || 0))}</span>
              <span className="min-w-0 truncate text-[var(--text-muted)]">{p.note || '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface Props {
  store: PlatformStore
  onClose: () => void
  onChanged: (store: PlatformStore) => void
}

export default function BillingDialog({ store, onClose, onChanged }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const [current, setCurrent] = useState(store)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])

  const summary = billingSummary(current)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="billing-title"
        className="wa-card wa-dialog max-h-[92vh] w-full max-w-2xl overflow-y-auto shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="billing-title" className="text-lg font-semibold">
              Cobrança · {current.name}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
              <span className={billingPillClass(summary.tone)}>{summary.label}</span>
              {current.lastPaymentAt && <span>Último pagamento: {formatBillingDay(current.lastPaymentAt)}</span>}
            </p>
          </div>
          <button ref={closeRef} type="button" className="wa-btn wa-btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </header>
        <BillingPanel
          store={store}
          onChanged={(updated) => {
            setCurrent(updated)
            onChanged(updated)
          }}
        />
      </section>
    </div>
  )
}
