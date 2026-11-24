'use client'

import type { AuditEntry } from '@/lib/admin-api'
import { segmentLabel } from '@/lib/segments'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

function day(value: unknown) {
  if (typeof value !== 'string' || !value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

/** Texto legível de cada ação registrada na auditoria. */
export function describeAudit(entry: AuditEntry): string {
  const d = (entry.details ?? {}) as Record<string, unknown>
  switch (entry.action) {
    case 'store.create': return 'Loja cadastrada na plataforma'
    case 'store.update': return 'Dados cadastrais atualizados'
    case 'store.delete': return `Removida da plataforma${d.name ? ` (${d.name})` : ''}`
    case 'store.duplicate': return 'Loja duplicada'
    case 'store.block': return 'Loja bloqueada manualmente'
    case 'store.unblock': return 'Loja desbloqueada'
    case 'store.abandoned': return 'Desativada por abandono (dono não acessou o painel)'
    case 'store.files-purged': return 'Arquivos da loja abandonada apagados'
    case 'payment.register': {
      const amount = typeof d.amount === 'number' ? currency.format(d.amount) : ''
      return `Pagamento registrado${amount ? ` · ${amount}` : ''}${d.note ? ` · ${d.note}` : ''}`
    }
    case 'billing.update': {
      const parts: string[] = []
      if (typeof d.monthlyFee === 'number') parts.push(`mensalidade ${currency.format(d.monthlyFee)}`)
      if (d.nextDueAt) parts.push(`vencimento ${day(d.nextDueAt)}`)
      if (d.courtesy === true) parts.push('cortesia')
      return `Cobrança ajustada${parts.length ? ` · ${parts.join(', ')}` : ''}`
    }
    case 'billing.auto-block': return `Bloqueio automático por atraso${typeof d.daysOverdue === 'number' ? ` (${d.daysOverdue} dias)` : ''}`
    case 'billing.auto-unblock': return 'Desbloqueio automático (cobrança regularizada)'
    case 'billing.trial-ended': return 'Teste grátis terminou; cobrança iniciada'
    case 'segment.change': {
      const applied = (d.applied ?? {}) as Record<string, unknown>
      const extras = [applied.colors ? 'cores' : '', applied.logo ? 'logo' : '', applied.samplesAdded ? 'produtos de exemplo' : '']
        .filter(Boolean)
      return `Segmento alterado para ${segmentLabel(String(d.segment ?? ''))}${extras.length ? ` · aplicou ${extras.join(', ')}` : ''}`
    }
    case 'logo.update': return 'Logo atualizado'
    case 'gallery.add': return 'Imagem adicionada à galeria'
    case 'gallery.remove': return 'Imagem removida da galeria'
    case 'user.create': return `Usuário criado${d.username ? ` · ${d.username}` : ''}${d.role ? ` (${d.role})` : ''}`
    case 'user.reset-password': return 'Senha de usuário redefinida'
    case 'user.delete': return 'Usuário removido'
    case 'reminder.whatsapp': return `Lembrete de cobrança enviado pelo WhatsApp${d.note ? ` · ${d.note}` : ''}`
    default: return entry.action
  }
}

function when(at: string) {
  const d = new Date(at)
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function AuditTimeline({
  entries,
  showStore = false,
  empty = 'Nenhuma ação registrada.',
}: {
  entries: AuditEntry[] | null
  showStore?: boolean
  empty?: string
}) {
  if (entries === null) return <p className="text-sm text-[var(--text-muted)]">Carregando histórico…</p>
  if (entries.length === 0) return <p className="text-sm text-[var(--text-muted)]">{empty}</p>
  return (
    <ol className="wa-timeline">
      {entries.map((e) => (
        <li key={e.id} className={e.actor === 'sistema' ? 'is-system' : ''}>
          <span className="wa-timeline-text">
            {showStore && e.storeName && <strong>{e.storeName} · </strong>}
            {describeAudit(e)}
          </span>
          <span className="wa-timeline-meta">
            {when(e.at)} · {e.actor === 'sistema' ? 'automático' : e.actor}
          </span>
        </li>
      ))}
    </ol>
  )
}
