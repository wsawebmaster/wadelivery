'use client'

import { useEffect } from 'react'

const MAX_TILT_DEG = 5

/**
 * Efeitos de ponteiro nos cards da landing: luz que acompanha o cursor (--mx/--my) e leve
 * inclinação 3D (--rx/--ry). Só em dispositivos com mouse e sem preferência por menos
 * movimento; um único listener delegado, atualizado por requestAnimationFrame.
 */
export function LandingEffects() {
  useEffect(() => {
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (!finePointer.matches || reduced.matches) return

    let active: HTMLElement | null = null
    let frame = 0
    let last: PointerEvent | null = null

    const reset = (card: HTMLElement) => {
      card.style.removeProperty('--rx')
      card.style.removeProperty('--ry')
      card.classList.remove('is-pointer')
    }

    const apply = () => {
      frame = 0
      if (!active || !last) return
      const rect = active.getBoundingClientRect()
      const x = last.clientX - rect.left
      const y = last.clientY - rect.top
      active.style.setProperty('--mx', `${x}px`)
      active.style.setProperty('--my', `${y}px`)
      const px = x / rect.width - 0.5
      const py = y / rect.height - 0.5
      active.style.setProperty('--rx', `${(-py * MAX_TILT_DEG).toFixed(2)}deg`)
      active.style.setProperty('--ry', `${(px * MAX_TILT_DEG).toFixed(2)}deg`)
    }

    const onMove = (e: PointerEvent) => {
      const card = (e.target as Element | null)?.closest?.('.card') as HTMLElement | null
      if (card !== active) {
        if (active) reset(active)
        active = card
        active?.classList.add('is-pointer')
      }
      last = e
      if (active && !frame) frame = requestAnimationFrame(apply)
    }

    const onLeave = () => {
      if (active) reset(active)
      active = null
    }

    document.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('pointerleave', onLeave)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      if (active) reset(active)
    }
  }, [])

  return null
}
