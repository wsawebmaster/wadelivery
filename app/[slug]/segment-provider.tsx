'use client'

import { useEffect, type ReactNode } from 'react'
import type { Segment } from '@/lib/types'

export function SegmentProvider({ segment, children }: { segment: Segment; children: ReactNode }) {
  useEffect(() => {
    document.documentElement.setAttribute('data-segment', segment)
    document.documentElement.classList.add('menu-root')
  }, [segment])

  return <>{children}</>
}
