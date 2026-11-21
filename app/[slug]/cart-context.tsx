'use client'

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react'
import type { CartItem, Product, SelectedOption } from '@/lib/types'

interface CartContextValue {
  items: CartItem[]
  addItem: (product: Product, selectedOption?: SelectedOption) => void
  removeItem: (productId: number, selectedOption?: SelectedOption) => void
  updateQuantity: (productId: number, quantity: number, selectedOption?: SelectedOption) => void
  updateNote: (productId: number, selectedOption: SelectedOption | undefined, note: string) => void
  clearCart: () => void
  total: number
  itemCount: number
}

const CartContext = createContext<CartContextValue>({
  items: [],
  addItem: () => {},
  removeItem: () => {},
  updateQuantity: () => {},
  updateNote: () => {},
  clearCart: () => {},
  total: 0,
  itemCount: 0,
})

export function useCart() {
  return useContext(CartContext)
}

function cartItemKey(productId: number, selectedOption?: SelectedOption): string {
  if (!selectedOption) return String(productId)
  return `${productId}:${selectedOption.groupId}:${selectedOption.optionId}`
}

function findItemIndex(items: CartItem[], productId: number, selectedOption?: SelectedOption): number {
  const key = cartItemKey(productId, selectedOption)
  return items.findIndex((item) => cartItemKey(item.product.id, item.selectedOption) === key)
}

function getOptionPriceAdjustment(product: Product, selectedOption?: SelectedOption): number {
  if (!selectedOption || !product.options) return 0
  for (const group of product.options) {
    const opt = group.options.find((o) => o.id === selectedOption.optionId)
    if (opt?.priceAdjustment) return opt.priceAdjustment
  }
  return 0
}

export function getOptionLabel(product: Product, selectedOption?: SelectedOption): string | null {
  if (!selectedOption || !product.options) return null
  for (const group of product.options) {
    const opt = group.options.find((o) => o.id === selectedOption.optionId)
    if (opt) return `${group.name}: ${opt.label}`
  }
  return null
}

export function getItemUnitPrice(item: CartItem): number {
  return item.product.price + getOptionPriceAdjustment(item.product, item.selectedOption)
}

function isValidCartItem(item: unknown): item is CartItem {
  if (!item || typeof item !== 'object') return false
  const obj = item as Record<string, unknown>
  const product = obj.product as Record<string, unknown> | undefined
  if (!product || typeof product !== 'object') return false
  return (
    product.id != null &&
    typeof product.name === 'string' &&
    typeof product.price === 'number' &&
    typeof product.category === 'string' &&
    typeof obj.quantity === 'number' &&
    (obj.quantity as number) > 0
  )
}

function loadCartFromStorage(slug: string): CartItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(`wadelivery-cart-${slug}`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const valid = parsed.filter(isValidCartItem)
    return valid.length > 0 ? valid : []
  } catch {
    return []
  }
}

function saveCartToStorage(slug: string, items: CartItem[]) {
  if (typeof window === 'undefined') return
  try {
    if (items.length > 0) {
      localStorage.setItem(`wadelivery-cart-${slug}`, JSON.stringify(items))
    } else {
      localStorage.removeItem(`wadelivery-cart-${slug}`)
    }
  } catch {
    /* ignore */
  }
}

export function CartProvider({ children, slug }: { children: ReactNode; slug: string }) {
  const [items, setItems] = useState<CartItem[]>([])
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setItems(loadCartFromStorage(slug))
    setHydrated(true)
  }, [slug])

  useEffect(() => {
    if (!hydrated) return
    saveCartToStorage(slug, items)
  }, [items, slug, hydrated])

  const addItem = useCallback((product: Product, selectedOption?: SelectedOption) => {
    setItems((prev) => {
      const existingIndex = findItemIndex(prev, product.id, selectedOption)

      if (existingIndex >= 0) {
        const updated = [...prev]
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + 1,
        }
        return updated
      }

      return [...prev, { product, quantity: 1, selectedOption }]
    })
  }, [])

  const removeItem = useCallback((productId: number, selectedOption?: SelectedOption) => {
    setItems((prev) => prev.filter((item) => cartItemKey(item.product.id, item.selectedOption) !== cartItemKey(productId, selectedOption)))
  }, [])

  const updateQuantity = useCallback((productId: number, quantity: number, selectedOption?: SelectedOption) => {
    if (quantity <= 0) {
      setItems((prev) => prev.filter((item) => cartItemKey(item.product.id, item.selectedOption) !== cartItemKey(productId, selectedOption)))
      return
    }

    const key = cartItemKey(productId, selectedOption)
    setItems((prev) =>
      prev.map((item) =>
        cartItemKey(item.product.id, item.selectedOption) === key ? { ...item, quantity } : item
      )
    )
  }, [])

  const updateNote = useCallback((productId: number, selectedOption: SelectedOption | undefined, note: string) => {
    const key = cartItemKey(productId, selectedOption)
    setItems((prev) =>
      prev.map((item) =>
        cartItemKey(item.product.id, item.selectedOption) === key ? { ...item, note } : item
      )
    )
  }, [])

  const clearCart = useCallback(() => {
    setItems([])
  }, [])

  const total = items.reduce((sum, item) => sum + getItemUnitPrice(item) * item.quantity, 0)
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0)

  useEffect(() => {
    if (itemCount > 0) {
      document.body.classList.add('cart-bar-visible')
    } else {
      document.body.classList.remove('cart-bar-visible')
    }
  }, [itemCount])

  return (
    <CartContext.Provider
      value={{ items, addItem, removeItem, updateQuantity, updateNote, clearCart, total, itemCount }}
    >
      {children}
    </CartContext.Provider>
  )
}
