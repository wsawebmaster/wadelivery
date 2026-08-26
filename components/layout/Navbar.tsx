'use client'

import { useEffect, useState } from 'react'
import { useTheme } from '@/lib/theme-context'

interface NavbarProps {
  onOpenLead: () => void
}

export function Navbar({ onOpenLead }: NavbarProps) {
  const [scrolled, setScrolled] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 10)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <header className={`nav ${scrolled ? 'scrolled' : ''}`}>
      <div className="container nav-inner">
        <a href="#inicio" className="brand" aria-label="WaDelivery — início">
          <span className="brand-mark">&#x1F6D2;</span>
          <span className="brand-name">
            Wa<strong>Delivery</strong>
          </span>
        </a>

        <nav
          className={`nav-links ${menuOpen ? 'open' : ''}`}
          id="navLinks"
          aria-label="Navegação principal"
        >
          <a href="#automacao" onClick={closeMenu}>Automação</a>
          <a href="#problemas" onClick={closeMenu}>Problemas</a>
          <a href="#solucoes" onClick={closeMenu}>Soluções</a>
          <a href="#comparativo" onClick={closeMenu}>Comparativo</a>
          <a href="#como-funciona" onClick={closeMenu}>Como funciona</a>
          <a href="#faq" onClick={closeMenu}>FAQ</a>
        </nav>

        <div className="nav-actions">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
          >
            {theme === 'dark' ? '\u2600' : '\u263E'}
          </button>

          <button
            type="button"
            className="nav-cta btn btn-primary btn-sm"
            onClick={onOpenLead}
          >
            Experimentar grátis
          </button>
        </div>

        <button
          type="button"
          className={`nav-toggle ${menuOpen ? 'open' : ''}`}
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label={menuOpen ? 'Fechar menu' : 'Abrir menu'}
          aria-expanded={menuOpen}
          aria-controls="navLinks"
        >
          <span /><span /><span />
        </button>
      </div>
    </header>
  )
}
