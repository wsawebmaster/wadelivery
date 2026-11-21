'use client'

import { useState, useEffect, useRef } from 'react'
import { useCart, getItemUnitPrice, getOptionLabel } from './cart-context'
import type { Tenant, PaymentMethod } from '@/lib/types'

interface CheckoutModalProps {
  open: boolean
  onClose: () => void
  onBackToCart: () => void
  onOrderConfirmed: () => void
  tenant: Tenant
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  pix: 'Pix',
  dinheiro: 'Dinheiro',
  credito: 'Cartao de Credito',
  debito: 'Cartao de Debito',
}

function generateOrderId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

export function CheckoutModal({ open, onClose, onBackToCart, onOrderConfirmed, tenant }: CheckoutModalProps) {
  const { items, total, clearCart } = useCart()
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | ''>('')
  const [needChange, setNeedChange] = useState(false)
  const [changeFor, setChangeFor] = useState('')
  const [pixTiming, setPixTiming] = useState<'agora' | 'entrega'>('entrega')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement
      document.body.classList.add('modal-open')
      setTimeout(() => {
        const nameInput = modalRef.current?.querySelector<HTMLInputElement>('#clienteNome')
        nameInput?.focus()
      }, 50)
    } else {
      document.body.classList.remove('modal-open')
      previousFocus.current?.focus()
    }
    return () => {
      document.body.classList.remove('modal-open')
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  function formatBRL(v: number) {
    return v.toFixed(2).replace('.', ',')
  }

  function buildWhatsAppMessage(): string {
    const orderId = generateOrderId()
    let msg = `*Pedido ${orderId} — ${tenant.name}*\n`
    msg += `----------------------------------------\n`

    for (const item of items) {
      const unitPrice = getItemUnitPrice(item)
      const lineTotal = unitPrice * item.quantity
      const optLabel = getOptionLabel(item.product, item.selectedOption)
      msg += `${item.quantity}x ${item.product.name}`
      if (optLabel) msg += ` (${optLabel})`
      msg += ` — R$ ${formatBRL(lineTotal)}\n`
      if (item.note) msg += `   Obs: ${item.note}\n`
    }

    msg += `----------------------------------------\n`
    msg += `*Total: R$ ${formatBRL(total)}*\n\n`
    msg += `*Pagamento:* ${PAYMENT_LABELS[paymentMethod as PaymentMethod]}\n`

    if (paymentMethod === 'pix') {
      if (pixTiming === 'agora') {
        msg += `Pagar agora via Pix\n`
        if (tenant.pixKey) msg += `Chave Pix: ${tenant.pixKey}\n`
        msg += `Envie o comprovante junto com o pedido\n`
      } else {
        msg += `Pagar na entrega/retirada\n`
        if (tenant.pixKey) msg += `Chave Pix: ${tenant.pixKey}\n`
      }
    }

    if (paymentMethod === 'dinheiro') {
      if (needChange && changeFor) {
        msg += `Precisa de troco para: R$ ${changeFor}\n`
      } else {
        msg += `Nao precisa de troco\n`
      }
    }

    msg += `\n*Nome:* ${name}\n`
    msg += `*Telefone:* ${phone}\n`

    return msg
  }

  function validate(): boolean {
    const newErrors: Record<string, string> = {}

    if (!name.trim()) newErrors.name = 'Informe seu nome'
    if (!phone.trim()) newErrors.phone = 'Informe seu telefone'
    else if (phone.replace(/\D/g, '').length < 10) newErrors.phone = 'Telefone incompleto'
    if (!paymentMethod) newErrors.payment = 'Selecione a forma de pagamento'
    if (paymentMethod === 'dinheiro' && needChange && !changeFor.trim()) {
      newErrors.changeFor = 'Informe o valor do troco'
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  async function handleSubmit() {
    if (!validate()) return
    setSubmitting(true)

    try {
      const message = buildWhatsAppMessage()
      const encoded = encodeURIComponent(message)
      const whatsappUrl = `https://wa.me/${tenant.whatsappNumber}?text=${encoded}`

      clearCart()
      window.open(whatsappUrl, '_blank', 'noopener')
      onOrderConfirmed()
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) return null

  return (
    <div
      className={`modal${open ? ' open' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Finalizar pedido"
    >
      <div className="modal-content" ref={modalRef}>
        <button className="close-button" onClick={onClose} aria-label="Fechar checkout">
          Fechar
        </button>
        <h2>Finalizar Pedido</h2>

        <label className="field-label" htmlFor="clienteNome">Nome</label>
        <input
          id="clienteNome"
          className={`input-field${errors.name ? ' is-invalid' : ''}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Seu nome"
          autoComplete="name"
        />
        {errors.name && <p className="field-error">{errors.name}</p>}

        <label className="field-label" htmlFor="clienteTelefone">Telefone</label>
        <input
          id="clienteTelefone"
          className={`input-field${errors.phone ? ' is-invalid' : ''}`}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(00) 00000-0000"
          inputMode="tel"
          autoComplete="tel"
        />
        {errors.phone && <p className="field-error">{errors.phone}</p>}

        <label className="field-label" htmlFor="formaPagamento">Forma de pagamento</label>
        <select
          id="formaPagamento"
          className={`input-field${errors.payment ? ' is-invalid' : ''}`}
          value={paymentMethod}
          onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod | '')}
        >
          <option value="" disabled>Selecione</option>
          <option value="pix">Pix</option>
          <option value="dinheiro">Dinheiro</option>
          <option value="credito">Cartao de Credito</option>
          <option value="debito">Cartao de Debito</option>
        </select>
        {errors.payment && <p className="field-error">{errors.payment}</p>}

        {paymentMethod === 'pix' && (
          <div className="payment-extra">
            <label className="field-label">Quando deseja pagar?</label>
            <div className="pix-timing-options">
              <button
                className={`option-choice-btn${pixTiming === 'agora' ? ' selected' : ''}`}
                onClick={() => setPixTiming('agora')}
              >
                Pagar agora
              </button>
              <button
                className={`option-choice-btn${pixTiming === 'entrega' ? ' selected' : ''}`}
                onClick={() => setPixTiming('entrega')}
              >
                Pagar na entrega
              </button>
            </div>
            {tenant.pixKey && (
              <p className="pix-info" style={{ marginTop: 8 }}>
                Chave Pix: <strong>{tenant.pixKey}</strong>
              </p>
            )}
          </div>
        )}

        {paymentMethod === 'dinheiro' && (
          <div className="payment-extra">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={needChange}
                onChange={(e) => {
                  setNeedChange(e.target.checked)
                  if (!e.target.checked) setChangeFor('')
                }}
              />
              Preciso de troco
            </label>
            {needChange && (
              <>
                <label className="field-label" htmlFor="trocoInput">Troco para quanto?</label>
                <input
                  id="trocoInput"
                  className={`input-field${errors.changeFor ? ' is-invalid' : ''}`}
                  value={changeFor}
                  onChange={(e) => setChangeFor(e.target.value)}
                  placeholder="Ex.: 50"
                  inputMode="decimal"
                />
                {errors.changeFor && <p className="field-error">{errors.changeFor}</p>}
              </>
            )}
          </div>
        )}

        <div className="cart-order-total">
          <div className="cart-total-summary">
            <div className="cart-total-main">
              <span className="cart-total-label">Total</span>
              <strong>R$ {formatBRL(total)}</strong>
            </div>
          </div>
        </div>

        <div className="checkout-actions" style={{ marginTop: 16 }}>
          <button className="secondary-btn" onClick={onBackToCart}>
            Voltar ao carrinho
          </button>
          <button
            className="finalize"
            onClick={handleSubmit}
            disabled={submitting || items.length === 0}
          >
            {submitting ? 'Enviando...' : 'Finalizar Pedido'}
          </button>
        </div>
      </div>
    </div>
  )
}
