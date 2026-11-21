'use client'

import { useEffect, useRef } from 'react'
import { useCart } from './cart-context'
import { getOptionLabel, getItemUnitPrice } from './cart-context'

interface CartModalProps {
  open: boolean
  onClose: () => void
  onCheckout: () => void
}

export function CartModal({ open, onClose, onCheckout }: CartModalProps) {
  const { items, removeItem, updateQuantity, updateNote, total, itemCount } = useCart()
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement
      document.body.classList.add('modal-open')
      setTimeout(() => {
        const closeBtn = modalRef.current?.querySelector<HTMLButtonElement>('.close-button')
        closeBtn?.focus()
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

  if (!open) return null

  return (
    <div
      className={`modal${open ? ' open' : ''}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Carrinho"
    >
      <div className="modal-content" ref={modalRef}>
        <button className="close-button" onClick={onClose} aria-label="Fechar carrinho">
          Fechar
        </button>
        <h2>Seu Carrinho</h2>

        {items.length === 0 ? (
          <p className="cart-empty">Seu carrinho esta vazia.</p>
        ) : (
          <>
            <ul className="cart-items">
              {items.map((item, idx) => {
                const unitPrice = getItemUnitPrice(item)
                const optLabel = getOptionLabel(item.product, item.selectedOption)
                return (
                  <li
                    key={`${item.product.id}:${item.selectedOption?.groupId ?? ''}:${item.selectedOption?.optionId ?? ''}:${idx}`}
                    className="cart-line"
                  >
                    <div className="cart-line-info">
                      <div>
                        <strong>{item.product.name}</strong>
                        {optLabel && (
                          <div className="cart-line-option">{optLabel}</div>
                        )}
                      </div>
                      <span className="cart-line-total">
                        R$ {(unitPrice * item.quantity).toFixed(2).replace('.', ',')}
                      </span>
                    </div>
                    <div className="cart-line-controls">
                      <button
                        className="cart-qty-btn remove"
                        onClick={() => removeItem(item.product.id, item.selectedOption)}
                        aria-label={`Remover ${item.product.name}`}
                      >
                        ✕
                      </button>
                      <button
                        className="cart-qty-btn"
                        onClick={() => updateQuantity(item.product.id, item.quantity - 1, item.selectedOption)}
                        aria-label={`Diminuir ${item.product.name}`}
                      >
                        &minus;
                      </button>
                      <span className="cart-qty">{item.quantity}</span>
                      <button
                        className="cart-qty-btn"
                        onClick={() => updateQuantity(item.product.id, item.quantity + 1, item.selectedOption)}
                        aria-label={`Aumentar ${item.product.name}`}
                      >
                        +
                      </button>
                    </div>
                    <div className="cart-line-note">
                      <input
                        type="text"
                        className="cart-note-input"
                        placeholder="Observação (ex: sem cebola)"
                        value={item.note ?? ''}
                        maxLength={100}
                        onChange={(e) => updateNote(item.product.id, item.selectedOption, e.target.value)}
                        aria-label={`Observação para ${item.product.name}`}
                      />
                    </div>
                  </li>
                )
              })}
            </ul>

            <div className="cart-order-total">
              <div className="cart-total-summary">
                <div className="cart-total-main">
                  <span className="cart-total-label">Total</span>
                  <strong>R$ {total.toFixed(2).replace('.', ',')}</strong>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <button
                className="secondary-btn"
                onClick={onClose}
              >
                Continuar Comprando
              </button>
            </div>

            <div className="checkout-after-cep" style={{ borderTop: '1px solid #eee', paddingTop: 8 }}>
              <div className="cart-checkout-actions">
                <button
                  className="finalize"
                  onClick={onCheckout}
                >
                  Finalizar Pedido
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
