'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { useCart } from './cart-context'
import { OptionsModal } from './options-modal'
import type { Tenant, Category, Product } from '@/lib/types'

function getStoredTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'dark'
  const stored = localStorage.getItem('wadelivery-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

interface MenuPageProps {
  tenant: Tenant
  categories: Category[]
  products: Product[]
  onOpenCart: () => void
}

export function MenuPage({ tenant, categories, products, onOpenCart }: MenuPageProps) {
  const { addItem, removeItem, updateQuantity, items, itemCount, total } = useCart()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [activeCategory, setActiveCategory] = useState(categories[0]?.id ?? '')
  const [stuck, setStuck] = useState(false)
  const [showPrev, setShowPrev] = useState(false)
  const [showNext, setShowNext] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>('dark')
  const prevCatCount = useRef<number>(categories.length)

  useEffect(() => {
    setTheme(getStoredTheme())
  }, [])
  const [optionsProduct, setOptionsProduct] = useState<Product | null>(null)

  function toggleTheme() {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('wadelivery-theme', next)
  }

  const scrollToCategory = useCallback((id: string) => {
    const menu = scrollRef.current
    if (!menu) return
    const target = menu.querySelector<HTMLElement>(`[data-category="${id}"]`)
    if (target) {
      menu.scrollTo({ left: target.offsetLeft, behavior: 'smooth' })
    }
  }, [])

  const updateArrows = useCallback(() => {
    const menu = scrollRef.current
    if (!menu) return
    const maxScroll = menu.scrollWidth - menu.clientWidth
    setShowPrev(menu.scrollLeft > 10)
    setShowNext(menu.scrollLeft < maxScroll - 10)
  }, [])

  useEffect(() => {
    const menu = scrollRef.current
    if (!menu) return

    let ticking = false
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        ticking = false
        const pages = menu.querySelectorAll<HTMLElement>('.category-page')
        const scrollLeft = menu.scrollLeft
        let best = ''
        let bestDist = Infinity
        pages.forEach((p) => {
          const dist = Math.abs(p.offsetLeft - scrollLeft)
          if (dist < bestDist) {
            bestDist = dist
            best = p.dataset.category ?? ''
          }
        })
        if (best) setActiveCategory(best)
        updateArrows()
      })
    }

    menu.addEventListener('scroll', onScroll, { passive: true })
    updateArrows()
    return () => menu.removeEventListener('scroll', onScroll)
  }, [updateArrows])

  useEffect(() => {
    const wrapper = document.querySelector('.categories-wrapper')
    if (!wrapper) return
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      { threshold: [1], rootMargin: '-1px 0px 0px 0px' }
    )
    observer.observe(wrapper)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (categories.length > prevCatCount.current) {
      const newCat = categories[categories.length - 1]
      setActiveCategory(newCat.id)
      scrollToCategory(newCat.id)
    }
    prevCatCount.current = categories.length
  }, [categories, scrollToCategory])

  const hasItems = itemCount > 0

  const getQty = (productId: number) =>
    items.find((i) => i.product.id === productId)?.quantity ?? 0

  const currentIndex = categories.findIndex((c) => c.id === activeCategory)

  function navigatePrev() {
    if (currentIndex > 0) {
      const prev = categories[currentIndex - 1]
      setActiveCategory(prev.id)
      scrollToCategory(prev.id)
    }
  }

  function navigateNext() {
    if (currentIndex < categories.length - 1) {
      const next = categories[currentIndex + 1]
      setActiveCategory(next.id)
      scrollToCategory(next.id)
    }
  }

  return (
    <>
      <header className="menu-header">
        <h3 className="menu-header-name">{tenant.name}</h3>
        <button
          className="theme-toggle"
          onClick={toggleTheme}
          aria-label={theme === 'light' ? 'Mudar para tema escuro' : 'Mudar para tema claro'}
          title={theme === 'light' ? 'Tema escuro' : 'Tema claro'}
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
      </header>

      <nav
        className={`categories-wrapper${stuck ? ' is-stuck' : ''}`}
        style={{ top: 'var(--header-height, 54px)' }}
      >
        <div className="categories">
          {categories.map((cat, i) => (
            <button
              key={cat.id}
              className={`category-btn${activeCategory === cat.id ? ' active' : ''}`}
              style={{ ['--i' as string]: i }}
              onClick={() => {
                setActiveCategory(cat.id)
                scrollToCategory(cat.id)
              }}
            >
              {cat.icon} {cat.name}
            </button>
          ))}
        </div>
      </nav>

      <main>
        <div className="menu-pager">
          <button
            className="menu-nav-arrow menu-nav-prev"
            aria-label="Categoria anterior"
            type="button"
            aria-hidden={!showPrev}
            onClick={navigatePrev}
          >
            &#8249;
          </button>
          <div
            id="menu"
            ref={scrollRef}
            aria-live="polite"
            tabIndex={0}
          >
            {categories.map((cat) => {
              const catProducts = products.filter((p) => p.category === cat.id)
              return (
                <div
                  key={cat.id}
                  className="category-page"
                  data-category={cat.id}
                >
                  {catProducts.map((p, i) => {
                    const qty = getQty(p.id)
                    return (
                      <div
                        key={p.id}
                        className={`menu-item${qty > 0 ? ' added' : ''}`}
                        style={{ ['--i' as string]: i }}
                      >
                        {qty > 0 && <span className="added-badge">{qty}</span>}
                        {p.image ? (
                          <img
                            className="item-image"
                            src={p.image}
                            alt={p.name}
                            loading="lazy"
                          />
                        ) : (
                          <div className="item-image-placeholder">
                            {cat.icon}
                          </div>
                        )}
                        <div className="item-body">
                          <span className="item-name">{p.name}</span>
                          <p className="item-description">{p.description}</p>
                          <span className="item-price">
                            R$ {p.price.toFixed(2).replace('.', ',')}
                          </span>
                        </div>
                        {qty === 0 ? (
                          <button
                            className="quantity-controls"
                            onClick={() => {
                              if (p.options && p.options.length > 0) {
                                setOptionsProduct(p)
                              } else {
                                addItem(p)
                              }
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                            }}
                            aria-label={`Adicionar ${p.name}`}
                          >
                            <span className="plus">+</span>
                          </button>
                        ) : (
                          <div className="quantity-controls">
                            <button
                              className="minus"
                              onClick={() => updateQuantity(p.id, qty - 1)}
                              aria-label={`Remover 1 ${p.name}`}
                            >
                              &minus;
                            </button>
                            <span className="zero">{qty}</span>
                            <button
                              className="plus"
                              onClick={() => {
                                if (p.options && p.options.length > 0) {
                                  setOptionsProduct(p)
                                } else {
                                  addItem(p)
                                }
                              }}
                              aria-label={`Adicionar mais 1 ${p.name}`}
                            >
                              +
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {catProducts.length === 0 && (
                    <div className="menu-empty">
                      <div className="menu-empty-icon">🍽️</div>
                      <p className="menu-empty-text">Nenhum item disponível nesta categoria</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <button
            className="menu-nav-arrow menu-nav-next"
            aria-label="Próxima categoria"
            type="button"
            aria-hidden={!showNext}
            onClick={navigateNext}
          >
            &#8250;
          </button>
        </div>
      </main>

      <div className={`bottom-menu${hasItems ? ' show' : ''}`}>
        <div>
          <span className="total-value">
            Subtotal: R$ {total.toFixed(2).replace('.', ',')}
          </span>
        </div>
        <div className="cart-count">
          {itemCount} {itemCount === 1 ? 'item' : 'itens'}
        </div>
        <button
          className={`cart-button${hasItems ? ' show' : ''}`}
          onClick={onOpenCart}
        >
          Carrinho
        </button>
      </div>

      <OptionsModal
        open={optionsProduct !== null}
        product={optionsProduct}
        onClose={() => setOptionsProduct(null)}
      />
    </>
  )
}
