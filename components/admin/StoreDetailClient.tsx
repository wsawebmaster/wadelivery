'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import AdminShell from './AdminShell'
import AuditTimeline from './AuditTimeline'
import { BillingPanel, billingPillClass, billingSummary, formatBillingDay } from './BillingDialog'
import { SegmentPanel } from './SegmentDialog'
import StoreToolsDialog from './StoreToolsDialog'
import StoreUsersPanel from './StoreUsersPanel'
import {
  deletePlatformStore,
  fetchPlatformOverview,
  fetchPlatformStore,
  fetchStoreAudit,
  getApiBaseUrl,
  setPlatformStoreBlocked,
  updatePlatformStore,
  uploadPlatformLogo,
  type AuditEntry,
  type PlatformStore,
  type PlatformStoreActivity,
} from '@/lib/admin-api'
import { browserApiBase } from '@/lib/api-base'
import { segmentLabel } from '@/lib/segments'

const number = new Intl.NumberFormat('pt-BR')

const SECTIONS = [
  ['resumo', 'Resumo'],
  ['dados', 'Dados'],
  ['cobranca', 'Cobrança'],
  ['segmento', 'Segmento'],
  ['usuarios', 'Usuários'],
  ['logo', 'Logo'],
  ['historico', 'Histórico'],
  ['risco', 'Zona de risco'],
] as const

const FIELDS: { key: string; label: string; wide?: boolean; type?: string }[] = [
  { key: 'name', label: 'Nome da loja', wide: true },
  { key: 'contactName', label: 'Contato' },
  { key: 'phone', label: 'Telefone / WhatsApp', type: 'tel' },
  { key: 'email', label: 'E-mail', type: 'email' },
  { key: 'cnpj', label: 'CPF / CNPJ' },
  { key: 'razaoSocial', label: 'Razão social' },
  { key: 'address', label: 'Endereço', wide: true },
  { key: 'addressNumber', label: 'Número' },
  { key: 'cep', label: 'CEP' },
  { key: 'city', label: 'Cidade' },
  { key: 'state', label: 'UF' },
  { key: 'domain', label: 'Domínio próprio' },
]

function dateTime(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

/** URL de arquivo da API (/uploads/...) acessível pelo navegador. */
function assetUrl(url?: string | null) {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return url
  return `${getApiBaseUrl()}${url}`
}

/** Links da loja gravados com localhost (desenvolvimento) seguem o host da página. */
function pageLink(url?: string | null) {
  if (!url) return null
  return browserApiBase(url, typeof window !== 'undefined' ? window.location.hostname : null)
}

function Section({ id, title, children, note }: { id: string; title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section id={id} className="wa-card wa-detail-section">
      <header className="wa-panel-head">
        <h2 className="wa-panel-title">{title}</h2>
        {note && <span className="wa-panel-note">{note}</span>}
      </header>
      {children}
    </section>
  )
}

export default function StoreDetailClient({ id }: { id: string }) {
  const router = useRouter()
  const [store, setStore] = useState<PlatformStore | null>(null)
  const [activity, setActivity] = useState<PlatformStoreActivity | null>(null)
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [formMessage, setFormMessage] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [logoBusy, setLogoBusy] = useState(false)
  const [tools, setTools] = useState(false)
  const [segmentKey, setSegmentKey] = useState(0)

  const loadAudit = useCallback(() => {
    fetchStoreAudit(id, 50).then(setAudit).catch(() => setAudit([]))
  }, [id])

  const load = useCallback(async () => {
    setError(null)
    try {
      const s = await fetchPlatformStore(id)
      setStore(s)
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key] ?? '')])))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Loja não encontrada.')
    }
    fetchPlatformOverview()
      .then((list) => setActivity(list.find((a) => a.platformStoreId === id) ?? null))
      .catch(() => setActivity(null))
    loadAudit()
  }, [id, loadAudit])

  useEffect(() => {
    void load()
  }, [load])

  /** Atualiza a loja exibida após uma ação e recarrega o histórico. */
  const changed = useCallback(
    (updated: PlatformStore) => {
      setStore((prev) => (prev ? { ...prev, ...updated } : updated))
      loadAudit()
    },
    [loadAudit],
  )

  async function saveData() {
    if (!store || saving) return
    setSaving(true)
    setFormMessage(null)
    setFormError(null)
    try {
      if (!form.name?.trim()) throw new Error('Informe o nome da loja.')
      // PUT é upsert completo: parte do registro atual e aplica só os campos do formulário.
      const body: Record<string, unknown> = { ...store }
      for (const f of FIELDS) body[f.key] = form[f.key]?.trim() ? form[f.key].trim() : null
      body.name = form.name.trim()
      changed(await updatePlatformStore(store.id, body))
      setFormMessage('Dados salvos.')
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Não foi possível salvar.')
    } finally {
      setSaving(false)
    }
  }

  async function sendLogo(file: File | undefined) {
    if (!store || !file) return
    setLogoBusy(true)
    setError(null)
    try {
      changed(await uploadPlatformLogo(store.id, file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar o logo.')
    } finally {
      setLogoBusy(false)
    }
  }

  async function toggleBlock() {
    if (!store) return
    const block = store.active
    if (block && !window.confirm(`Bloquear "${store.name}"? O cardápio sai do ar e os pedidos são recusados.`)) return
    try {
      changed(await setPlatformStoreBlocked(store.id, block))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A operação não foi concluída.')
    }
  }

  async function removeFromPlatform() {
    if (!store) return
    const typed = window.prompt(
      `Remover "${store.name}" da plataforma?\n\nApaga só o registro da plataforma (cobrança, histórico de pagamentos e vínculo). ` +
        'O cardápio, os produtos e o slug da loja continuam existindo.\n\nDigite o nome da loja para confirmar:',
    )
    if (typed === null) return
    if (typed.trim() !== store.name.trim()) {
      setError('Nome digitado não confere. Nada foi removido.')
      return
    }
    try {
      await deletePlatformStore(store.id)
      router.push('/admin/lojas')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível remover.')
    }
  }

  if (!store) {
    return (
      <AdminShell title="Loja" subtitle="Carregando…">
        {error ? <p className="wa-alert is-error">{error}</p> : <p className="text-sm text-[var(--text-muted)]">Carregando loja…</p>}
        <Link href="/admin/lojas" className="wa-btn wa-btn-ghost mt-4">← Voltar para as lojas</Link>
      </AdminShell>
    )
  }

  const summary = billingSummary(store)
  const menuUrl = pageLink(store.frontUrl)
  const adminUrl = pageLink(store.adminUrl)
  const logo = assetUrl(store.logoUrl)
  const isDefaultLogo = /\/logo-padrao-/.test(String(store.logoUrl || ''))
  const hasStoreId = typeof store.storeId === 'number' && store.storeId > 0

  return (
    <AdminShell
      title={store.name}
      subtitle={[segmentLabel(store.segment), store.city && store.state ? `${store.city}/${store.state}` : null].filter(Boolean).join(' · ')}
      actions={
        <div className="flex flex-wrap gap-2">
          <Link href="/admin/lojas" className="wa-btn wa-btn-ghost">← Lojas</Link>
          {menuUrl && <a href={menuUrl} target="_blank" rel="noreferrer" className="wa-btn wa-btn-ghost">Cardápio ↗</a>}
          {adminUrl && <a href={adminUrl} target="_blank" rel="noreferrer" className="wa-btn wa-btn-primary">Painel da loja ↗</a>}
        </div>
      }
    >
      <div className="wa-detail-head">
        {logo ? <img src={logo} alt="" className="wa-detail-logo" /> : <span className="wa-detail-logo is-empty" aria-hidden="true">🏪</span>}
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className={billingPillClass(summary.tone)}>{summary.label}</span>
            <span className={store.active ? 'wa-pill is-active' : 'wa-pill is-error'}>{store.active ? 'Ativa' : 'Fora do ar'}</span>
            {store.plan && <span className="wa-pill">{store.plan}</span>}
          </p>
          <nav className="wa-detail-nav" aria-label="Seções da loja">
            {SECTIONS.map(([key, label]) => (
              <a key={key} href={`#${key}`}>{label}</a>
            ))}
          </nav>
        </div>
      </div>

      {error && <p className="wa-alert is-error mb-4">{error}</p>}

      <div className="wa-detail-grid">
        <Section id="resumo" title="Resumo">
          <dl className="wa-dl">
            <dt>Cadastrada em</dt>
            <dd>{dateTime(store.createdAt)}</dd>
            <dt>Último acesso do dono</dt>
            <dd>{store.lastAccessAt ? dateTime(store.lastAccessAt) : 'Nunca acessou'}</dd>
            <dt>Pedidos (30 dias / total)</dt>
            <dd>{activity ? `${number.format(activity.orders30d)} / ${number.format(activity.ordersTotal)}` : '—'}</dd>
            <dt>Último pedido</dt>
            <dd>{activity?.lastOrderAt ? dateTime(activity.lastOrderAt) : '—'}</dd>
            <dt>Acessos ao cardápio (30 dias)</dt>
            <dd>{activity ? number.format(activity.menuViews30d) : '—'}</dd>
            <dt>Produtos próprios</dt>
            <dd>
              {activity ? number.format(activity.ownProducts) : '—'}
              {activity && activity.sampleProducts > 0 ? ` (+${activity.sampleProducts} de exemplo)` : ''}
            </dd>
            <dt>Mensalidade</dt>
            <dd>{Number(store.monthlyFee || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</dd>
            <dt>Próximo vencimento</dt>
            <dd>{formatBillingDay(store.nextDueAt)}</dd>
          </dl>
        </Section>

        <Section id="dados" title="Dados cadastrais">
          <div className="wa-form-section">
            {formError && <p className="wa-alert is-error">{formError}</p>}
            {formMessage && <p className="wa-alert is-ok">{formMessage}</p>}
            <div className="grid gap-x-3 sm:grid-cols-2">
              {FIELDS.map((f) => (
                <label key={f.key} className={`wa-field ${f.wide ? 'sm:col-span-2' : ''}`}>
                  <span className="wa-label">{f.label}</span>
                  <input
                    className="wa-input"
                    type={f.type ?? 'text'}
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  />
                </label>
              ))}
            </div>
            <div className="wa-actions">
              <button type="button" className="wa-btn wa-btn-primary" disabled={saving} onClick={() => void saveData()}>
                {saving ? 'Salvando…' : 'Salvar dados'}
              </button>
            </div>
          </div>
        </Section>

        <Section id="cobranca" title="Cobrança" note={store.lastPaymentAt ? `último pagamento ${formatBillingDay(store.lastPaymentAt)}` : undefined}>
          <BillingPanel key={`billing-${store.id}`} store={store} onChanged={changed} showBlock={false} />
        </Section>

        <Section id="segmento" title="Segmento" note={`atual: ${segmentLabel(store.segment)}`}>
          <SegmentPanel key={`segment-${segmentKey}`} store={store} onChanged={changed} onDone={() => setSegmentKey((k) => k + 1)} />
        </Section>

        <Section id="usuarios" title="Usuários da loja">
          {hasStoreId ? (
            <StoreUsersPanel platformId={store.id} panelUrl={adminUrl} onAction={loadAudit} />
          ) : (
            <p className="text-sm text-[var(--text-muted)]">Loja sem vínculo (StoreId) — não há usuários para gerenciar.</p>
          )}
        </Section>

        <Section id="logo" title="Logo" note={isDefaultLogo ? 'logo padrão (gerado pela plataforma)' : store.logoUrl ? 'logo enviado' : 'sem logo'}>
          <div className="wa-form-section flex flex-wrap items-center gap-4">
            {logo ? <img src={logo} alt={`Logo de ${store.name}`} className="wa-detail-logo is-large" /> : <span className="text-sm text-[var(--text-muted)]">Nenhum logo.</span>}
            <label className="wa-btn wa-btn-ghost cursor-pointer">
              {logoBusy ? 'Enviando…' : 'Enviar logo próprio'}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={logoBusy} onChange={(e) => void sendLogo(e.target.files?.[0])} />
            </label>
          </div>
        </Section>

        <Section id="historico" title="Histórico" note="ações da plataforma e rotinas automáticas">
          <AuditTimeline entries={audit} />
        </Section>

        <Section id="risco" title="Zona de risco">
          <div className="wa-form-section">
            <div className="wa-row">
              <span>
                <strong className="block">{store.active ? 'Bloquear loja' : 'Desbloquear loja'}</strong>
                <span className="text-xs text-[var(--text-muted)]">
                  {store.active ? 'Tira o cardápio do ar e recusa pedidos até o desbloqueio.' : 'Volta a publicar o cardápio e aceitar pedidos.'}
                </span>
              </span>
              <button type="button" className={`wa-btn wa-btn-ghost ${store.active ? 'wa-btn-danger' : ''}`} onClick={() => void toggleBlock()}>
                {store.active ? 'Bloquear' : 'Desbloquear'}
              </button>
            </div>
            <div className="wa-row">
              <span>
                <strong className="block">Ferramentas</strong>
                <span className="text-xs text-[var(--text-muted)]">Comparar, backup e sincronização com o ambiente remoto.</span>
              </span>
              <button type="button" className="wa-btn wa-btn-ghost" disabled={!hasStoreId} onClick={() => setTools(true)}>
                Abrir ferramentas
              </button>
            </div>
            <div className="wa-row">
              <span>
                <strong className="block">Remover da plataforma</strong>
                <span className="text-xs text-[var(--text-muted)]">
                  Apaga só o registro da plataforma (cobrança e histórico de pagamentos). O cardápio, os produtos e o slug continuam existindo.
                </span>
              </span>
              <button type="button" className="wa-btn wa-btn-ghost wa-btn-danger" disabled={store.storeId === 1} onClick={() => void removeFromPlatform()}>
                Remover
              </button>
            </div>
          </div>
        </Section>
      </div>

      {tools && hasStoreId && (
        <StoreToolsDialog storeId={store.storeId as number} storeName={store.name} onClose={() => setTools(false)} />
      )}
    </AdminShell>
  )
}
