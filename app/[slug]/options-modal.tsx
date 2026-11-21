'use client'

import { useState, useEffect, useRef } from 'react'
import { useCart } from './cart-context'
import type { Product, SelectedOption } from '@/lib/types'

interface OptionsModalProps {
  open: boolean
  product: Product | null
  onClose: () => void
}

export function OptionsModal({ open, product, onClose }: OptionsModalProps) {
  const { addItem } = useCart()
  const [selections, setSelections] = useState<Record<string, string>>({})
  const modalRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (open) {
      previousFocus.current = document.activeElement as HTMLElement
      document.body.classList.add('modal-open')
      if (product?.options) {
        const initial: Record<string, string> = {}
        for (const group of product.options) {
          if (group.options.length > 0) {
            initial[group.id] = group.options[0].id
          }
        }
        setSelections(initial)
      }
      setTimeout(() => modalRef.current?.focus(), 50)
    } else {
      document.body.classList.remove('modal-open')
      previousFocus.current?.focus()
    }
    return () => { document.body.classList.remove('modal-open') }
  }, [open, product])

  useEffect(() => {
    if (!open) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, onClose])

  if (!open || !product) return null

  const requiredGroups = product?.options?.filter((g) => g.required) ?? []

  function formatBRL(v: number) {
    return v.toFixed(2).replace('.', ',')
  }

  function getOptionPriceAdj(groupId: string, optionId: string): number {
    const group = product!.options?.find((g) => g.id === groupId)
    const opt = group?.options.find((o) => o.id === optionId)
    return opt?.priceAdjustment ?? 0
  }

  function getTotalAdjustment(): number {
    let total = 0
    for (const [groupId, optionId] of Object.entries(selections)) {
      total += getOptionPriceAdj(groupId, optionId)
    }
    return total
  }

  function handleAdd() {
    const selectedOptions: SelectedOption[] = Object.entries(selections).map(
      ([groupId, optionId]) => ({ groupId, optionId })
    )
    const primary = selectedOptions[0]
    addItem(product!, primary)
    onClose()
  }

  const totalAdj = getTotalAdjustment()
  const finalPrice = product.price + totalAdj

  return (
    <div
      className="modal open"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="dialog"
      aria-modal="true"
      aria-label={`Opções de ${product.name}`}
    >
      <div className="modal-content options-modal-content" ref={modalRef} tabIndex={-1}>
        <button className="close-button" onClick={onClose} aria-label="Fechar">
          Fechar
        </button>
        <h2 className="options-modal-title">{product.name}</h2>
        <p className="options-modal-desc">{product.description}</p>

        {requiredGroups.map((group) => (
          <div key={group.id} className="option-group">
            <h3 className="option-group-name">{group.name}</h3>
            <div className="option-choices">
              {group.options.map((opt) => {
                const isSelected = selections[group.id] === opt.id
                return (
                  <button
                    key={opt.id}
                    className={`option-choice-btn${isSelected ? ' selected' : ''}`}
                    onClick={() => setSelections((prev) => ({ ...prev, [group.id]: opt.id }))}
                  >
                    <span className="option-choice-label">{opt.label}</span>
                    {opt.priceAdjustment ? (
                      <span className="option-choice-price">
                        + R$ {formatBRL(opt.priceAdjustment)}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          </div>
        ))}

        <div className="options-modal-footer">
          <div className="options-modal-price">
            <span>Subtotal:</span>
            <strong>R$ {formatBRL(finalPrice)}</strong>
          </div>
          <button className="finalize" onClick={handleAdd}>
            Adicionar ao Carrinho
          </button>
        </div>
      </div>
    </div>
  )
}
