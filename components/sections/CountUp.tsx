'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'

interface CountUpProps {
  target: number
  duration?: number
  className?: string
  suffix?: string
}

export function CountUp({ target, duration = 900, className = '', suffix }: CountUpProps) {
  const [value, setValue] = useState(0)
  const ref = useRef<HTMLSpanElement>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || doneRef.current) return
          doneRef.current = true

          const start = performance.now()

          function tick(now: number) {
            const progress = Math.min((now - start) / duration, 1)
            const eased = 1 - Math.pow(1 - progress, 3)
            setValue(Math.round(eased * target))
            if (progress < 1) requestAnimationFrame(tick)
          }

          requestAnimationFrame(tick)
          observer.disconnect()
        })
      },
      { threshold: 0.4 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [target, duration])

  return (
    <>
      <span ref={ref} className={`trust-num ${className}`}>
        {value}
      </span>
      {suffix && <span className="trust-unit">{suffix}</span>}
    </>
  )
}
