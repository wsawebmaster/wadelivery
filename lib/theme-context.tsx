'use client'

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react'

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
  const stored = localStorage.getItem('wadelivery-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return null
}

function getClientTheme(): Theme {
  return getStoredTheme() || getSystemTheme()
}

let onThemeChange: (() => void) | null = null

function subscribe(callback: () => void) {
  onThemeChange = callback
  return () => { onThemeChange = null }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getClientTheme, () => 'dark' as Theme)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: light)')
    function onSystemChange() {
      if (!localStorage.getItem('wadelivery-theme')) {
        onThemeChange?.()
      }
    }
    function onStorageChange(e: StorageEvent) {
      if (e.key === 'wadelivery-theme') {
        onThemeChange?.()
      }
    }
    mql.addEventListener('change', onSystemChange)
    window.addEventListener('storage', onStorageChange)
    return () => {
      mql.removeEventListener('change', onSystemChange)
      window.removeEventListener('storage', onStorageChange)
    }
  }, [])

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark'
    localStorage.setItem('wadelivery-theme', next)
    document.documentElement.setAttribute('data-theme', next)
    onThemeChange?.()
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}
