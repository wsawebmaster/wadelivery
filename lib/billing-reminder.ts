// Lembrete de cobrança pelo WhatsApp (link wa.me com a mensagem pronta; sem integração/custo).
import type { PlatformStore } from './admin-api'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const DAY_MS = 86_400_000

function utcDay(value: string | Date) {
  const d = new Date(value)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

function day(value?: string | null) {
  if (!value) return ''
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'UTC' })
}

/** Dígitos do telefone com DDI 55 quando faltar (formato do wa.me). Null = telefone inválido. */
export function whatsappPhone(phone?: string | null): string | null {
  const digits = String(phone || '').replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.length <= 11 ? `55${digits}` : digits
}

export function whatsappUrl(phone: string | null | undefined, text: string): string | null {
  const target = whatsappPhone(phone)
  return target ? `https://wa.me/${target}?text=${encodeURIComponent(text)}` : null
}

/**
 * Mensagem conforme a situação da cobrança. blockAfterDays = tolerância antes do bloqueio
 * automático (Billing:BlockAfterDays, padrão 5).
 */
export function reminderMessage(store: PlatformStore, now = new Date(), blockAfterDays = 5): string {
  const greeting = `Olá${store.contactName ? `, ${String(store.contactName).split(' ')[0]}` : ''}! Aqui é da WaDelivery.`
  const name = store.name
  const fee = currency.format(Number(store.monthlyFee || 0))
  const today = utcDay(now)

  if (store.billingBlocked || store.active === false) {
    return `${greeting} O cardápio da ${name} está fora do ar por mensalidade em aberto. Assim que o pagamento de ${fee} for confirmado, reativamos a loja na hora. Precisa de ajuda?`
  }
  if (store.courtesy && store.courtesyUntil) {
    const left = Math.round((utcDay(store.courtesyUntil) - today) / DAY_MS)
    const when = left > 0 ? `termina em ${left} dia(s), em ${day(store.courtesyUntil)}` : `terminou em ${day(store.courtesyUntil)}`
    return `${greeting} O período grátis da ${name} ${when}.${Number(store.monthlyFee) > 0 ? ` Para continuar recebendo pedidos, a mensalidade é de ${fee}.` : ''} Posso te ajudar com algo?`
  }
  if (store.nextDueAt) {
    const diff = Math.round((utcDay(store.nextDueAt) - today) / DAY_MS)
    if (diff < 0) {
      const blockAt = new Date(utcDay(store.nextDueAt) + (blockAfterDays + 1) * DAY_MS)
      const blockText = blockAt.getTime() > today ? ` Para evitar a suspensão do cardápio, o pagamento precisa ser feito até ${blockAt.toLocaleDateString('pt-BR', { timeZone: 'UTC' })}.` : ''
      return `${greeting} A mensalidade da ${name} (${fee}) venceu em ${day(store.nextDueAt)}.${blockText} Qualquer dúvida, é só chamar.`
    }
    if (diff === 0) return `${greeting} Passando para lembrar que a mensalidade da ${name} (${fee}) vence hoje. Obrigado!`
    return `${greeting} Passando para lembrar que a mensalidade da ${name} (${fee}) vence em ${day(store.nextDueAt)}. Obrigado!`
  }
  return `${greeting} Tudo certo com a ${name}? Estamos à disposição.`
}
