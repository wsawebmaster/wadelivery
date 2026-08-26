'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

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

  return (
    <AnimatePresence>
      {open && (
        <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={onClose}
          />
          <motion.div
            ref={cardRef}
            className="modal-card"
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={{ duration: 0.35, ease: [0.2, 0.9, 0.3, 1.2] }}
          >
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
