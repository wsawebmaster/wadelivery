'use client'

import { useState, useEffect, useRef, type ReactNode } from 'react'
import type { OrderStatus, CartItem } from '@/lib/types'
import { getItemUnitPrice, getOptionLabel } from './cart-context'

interface OrderTrackProps {
  visible: boolean
  onClose: () => void
  items: CartItem[]
  total: number
}

const STEPS: { key: OrderStatus; label: string; icon: ReactNode }[] = [
  {
    key: 'recebido',
    label: 'Recebido',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8.6-8.6 1.4 1.4z" />
      </svg>
    ),
  },
  {
    key: 'preparando',
    label: 'Preparando',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 4h2v7a3 3 0 0 0 3 3v6h2v-6a3 3 0 0 0 3-3V4h2v7a5 5 0 0 1-4 4.9V22H8v-6.1A5 5 0 0 1 4 11V4zm14 0h2v10h-2c-1.7 0-3-1.3-3-3V7c0-1.7 1.3-3 3-3z" />
      </svg>
    ),
  },
  {
    key: 'saiu',
    label: 'A Caminho',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M3 7h11v8H3V7zm12 2h3.2l2.3 3H15V9zm0 5h6v2h-1.1a2.5 2.5 0 0 1-4.8 0H15v-2zM6.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 11h7V9H5v2z" />
      </svg>
    ),
  },
  {
    key: 'entregue',
    label: 'Entregue',
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M6 8V6a6 6 0 0 1 12 0v2h2v13H4V8h2zm2 0h8V6a4 4 0 0 0-8 0v2zm1 4v2h2v-2H9zm4 0v2h2v-2h-2z" />
      </svg>
    ),
  },
]

function getStatusLabel(status: OrderStatus): string {
  const step = STEPS.find((s) => s.key === status)
  return step?.label ?? status
}

function getEta(status: OrderStatus): string {
  switch (status) {
    case 'recebido': return '15–25 minutos'
    case 'preparando': return '10–20 minutos'
    case 'saiu': return '5–10 minutos'
    case 'entregue': return 'Pedido entregue!'
  }
}

export function OrderTrack({ visible, onClose, items, total }: OrderTrackProps) {
  const [showFab, setShowFab] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [status, setStatus] = useState<OrderStatus>('recebido')
  const [orderId, setOrderId] = useState('')
  const modalRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Generate order ID client-side only to avoid hydration mismatch
  useEffect(() => {
    if (visible && !orderId) {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      let id = ''
      for (let i = 0; i < 6; i++) {
        id += chars.charAt(Math.floor(Math.random() * chars.length))
      }
      setOrderId(id)
    }
  }, [visible, orderId])

  // Show FAB after a delay (simulating order confirmation)
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => setShowFab(true), 1500)
      return () => clearTimeout(t)
    } else {
      setShowFab(false)
      setModalOpen(false)
      setStatus('recebido')
    }
  }, [visible])

  // Auto-advance status
  useEffect(() => {
    if (!visible) return

    const intervals: Record<OrderStatus, number> = {
      recebido: 5000,
      preparando: 8000,
      saiu: 6000,
      entregue: 0,
    }

    const advanceStatus = () => {
      setStatus((prev) => {
        const next: Record<OrderStatus, OrderStatus> = {
          recebido: 'preparando',
          preparando: 'saiu',
          saiu: 'entregue',
          entregue: 'entregue',
        }
        return next[prev]
      })
    }

    timerRef.current = setTimeout(() => {
      advanceStatus()
    }, intervals[status])

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [visible, status])

  // Keyboard support for modal
  useEffect(() => {
    if (!modalOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [modalOpen])

  // Body scroll lock
  useEffect(() => {
    if (modalOpen) {
      document.body.classList.add('modal-open')
    } else {
      document.body.classList.remove('modal-open')
    }
    return () => {
      document.body.classList.remove('modal-open')
    }
  }, [modalOpen])

  const currentStepIndex = STEPS.findIndex((s) => s.key === status)

  return (
    <>
      {/* FAB */}
      <button
        className="order-track-fab"
        hidden={!showFab}
        onClick={() => setModalOpen(true)}
        aria-label="Ver acompanhamento do pedido"
      >
        <span className="order-track-fab-label">Pedido</span>
        <span className="order-track-fab-status">{getStatusLabel(status)}</span>
      </button>

      {/* Full-screen Modal */}
      {modalOpen && (
        <div
          id="orderTrackModal"
          className="modal open"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false)
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Acompanhar pedido"
        >
          <div className="order-track-modal-content" ref={modalRef}>
            <div className="ot-modal-head">
              <div className="ot-modal-head-text">
                <h2>Seu pedido</h2>
                <p className="order-id-line">Número: <strong>{orderId}</strong></p>
              </div>
              <button
                className="close-button ot-close-btn"
                onClick={() => setModalOpen(false)}
                aria-label="Fechar acompanhamento"
              >
                Fechar
              </button>
            </div>

            <div className="ot-modal-body">
              {/* Stepper */}
              <div className="ot-stepper">
                {STEPS.map((step, i) => {
                  let stepClass = 'ot-step'
                  if (i < currentStepIndex) stepClass += ' is-done'
                  else if (i === currentStepIndex) stepClass += ' is-current'

                  return (
                    <div key={step.key} className={stepClass}>
                      <div className="ot-step-icon">{step.icon}</div>
                      <div className="ot-step-label">{step.label}</div>
                    </div>
                  )
                })}
              </div>

              {/* ETA */}
              <div className="ot-eta">
                <span className="ot-eta-label">Previsão de entrega:</span>{' '}
                <strong className="ot-eta-range">{getEta(status)}</strong>
              </div>

              {/* Order Details */}
              {items.length > 0 && (
                <div className="order-track-details">
                  {items.map((item, idx) => {
                    const unitPrice = getItemUnitPrice(item)
                    const optLabel = getOptionLabel(item.product, item.selectedOption)
                    return (
                      <div key={`${item.product.id}:${item.selectedOption?.groupId ?? ''}:${item.selectedOption?.optionId ?? ''}:${idx}`} className="ot-row">
                        <div>
                          <span>{item.quantity}x {item.product.name}</span>
                          {optLabel && <span className="cart-line-option"> ({optLabel})</span>}
                          {item.note && <span className="cart-line-option"> — {item.note}</span>}
                        </div>
                        <span>R$ {(unitPrice * item.quantity).toFixed(2).replace('.', ',')}</span>
                      </div>
                    )
                  })}
                  <div className="ot-row ot-total">
                    <span>Total</span>
                    <span>R$ {total.toFixed(2).replace('.', ',')}</span>
                  </div>
                </div>
              )}
            </div>

            <div className="ot-modal-actions">
              <div className="ot-share-row">
                <button className="secondary-btn" onClick={() => setModalOpen(false)}>Compartilhar link</button>
                <button className="secondary-btn" onClick={() => setModalOpen(false)}>Reenviar WhatsApp</button>
              </div>
              <button className="secondary-btn" onClick={() => setModalOpen(false)}>Fechar</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
