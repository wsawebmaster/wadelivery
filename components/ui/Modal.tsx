'use client'

import { type ReactNode, useEffect, useRef } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  children: ReactNode
  labelledBy?: string
}

export function Modal({ open, onClose, children, labelledBy }: ModalProps) {
  const lastFocusedRef = useRef<HTMLElement | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement
      document.body.style.overflow = 'hidden'

      const timer = setTimeout(() => {
        const firstInput = cardRef.current?.querySelector<HTMLInputElement>(
          'input:not([type="hidden"])'
        )
        firstInput?.focus()
      }, 120)

      return () => clearTimeout(timer)
    } else {
      document.body.style.overflow = ''
      lastFocusedRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && open) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="modal is-open" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <div className="modal-backdrop" onClick={onClose} />
      <div ref={cardRef} className="modal-card">
        {children}
      </div>
    </div>
  )
}
