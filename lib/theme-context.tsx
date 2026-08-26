'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'dark' | 'light'

interface ThemeContextValue {
  theme: Theme
  toggleTheme: () => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  toggleTheme: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function getStoredTheme(): Theme | null {
  if (typeof window === 'undefined') return null
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark') return stored
  return null
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    const stored = getStoredTheme()
    const initial = stored || getSystemTheme()
    setTheme(initial)
    document.documentElement.setAttribute('data-theme', initial)

    const mql = window.matchMedia('(prefers-color-scheme: light)')
    function onSystemChange(e: MediaQueryListEvent) {
      if (!localStorage.getItem('theme')) {
        const next = e.matches ? 'light' : 'dark'
        setTheme(next)
        document.documentElement.setAttribute('data-theme', next)
      }
    }
    mql.addEventListener('change', onSystemChange)
    return () => mql.removeEventListener('change', onSystemChange)
  }, [])

  function toggleTheme() {
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', next)
      document.documentElement.setAttribute('data-theme', next)
      return next
    })
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
