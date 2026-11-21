import type { Tenant, Category, Product } from './types'

export const mockTenants: Record<string, Tenant> = {
  fabin: {
    slug: 'fabin',
    name: 'Fabin Lanches',
    segment: 'lanchonete',
    primaryColor: '#1f6feb',
    headerImage: null,
    whatsappNumber: '5516999999999',
    pixKey: '(16) 99999-9999',
    address: 'Rua Exemplo, 123 — Centro, Ribeirão Preto/SP',
  },
  'gota-acai': {
    slug: 'gota-acai',
    name: 'Gota Açaí',
    segment: 'lanchonete',
    primaryColor: '#7b2d8b',
    headerImage: null,
    whatsappNumber: '5516999999999',
    pixKey: '(16) 99999-9999',
    address: 'Av. das Palmeiras, 456 — Jardim, Ribeirão Preto/SP',
  },
}

/**
 * Categorias e produtos por-tenant.
 *
 * Um tenant "segmentado" pode oferecer um cardápio próprio (ex.: açaí em vez de
 * hambúrguer). O storefront resolve por slug: `getCategoriesForSlug` /
 * `getProductsForSlug`. Sem entrada → cai no cardápio padrão (lanchonete).
 */

export const mockCategories: Category[] = [
  { id: 'hamburguers', name: 'Hambúrgueres', icon: '\uD83C\uDF54' },
  { id: 'hot-dogs', name: 'Hot Dogs', icon: '\uD83C\uDF2D' },
  { id: 'porcoes', name: 'Porções', icon: '\uD83E\uDD58' },
  { id: 'bebidas', name: 'Bebidas', icon: '\uD83E\uDD64' },
]

const gotaAcaiCategories: Category[] = [
  { id: 'acais', name: 'Açaís', icon: '\uD83C\uDF51' },
  { id: 'combos', name: 'Combos & Tigelas', icon: '\uD83C\uDF76' },
  { id: 'sorvetes', name: 'Sorvetes & Picolés', icon: '\uD83C\uDF6A' },
  { id: 'bebidas', name: 'Bebidas', icon: '\uD83E\uDD64' },
]

const gotaAcaiProducts: Product[] = [
  {
    id: 101,
    name: 'Açaí 300ml',
    description: 'Copo de açaí 300ml com granola e calda de banana',
    price: 12.9,
    category: 'acais',
  },
  {
    id: 102,
    name: 'Açaí 500ml',
    description: 'Copo de açaí 500ml com granola, banana e leite condensado',
    price: 18.9,
    category: 'acais',
  },
  {
    id: 103,
    name: 'Açaí 700ml',
    description: 'Copo de açaí 700ml com frutas, granola e mel',
    price: 24.9,
    category: 'acais',
  },
  {
    id: 104,
    name: 'Açaí 1 Litro',
    description: 'Copo de açaí 1L para compartilhar, com acompanhamentos',
    price: 34.9,
    category: 'acais',
  },
  {
    id: 111,
    name: 'Tigela de Açaí',
    description: 'Tigela com açaí batido, granola, banana e morango',
    price: 21.9,
    category: 'combos',
    options: [
      {
        id: 'tamanho',
        name: 'Tamanho',
        required: true,
        options: [
          { id: 'media', label: 'Média' },
          { id: 'grande', label: 'Grande', priceAdjustment: 5 },
        ],
      },
    ],
  },
  {
    id: 112,
    name: 'Combo Açaí + Casquinha',
    description: 'Açaí 300ml mais uma casquinha de sorvete',
    price: 16.9,
    category: 'combos',
  },
  {
    id: 121,
    name: 'Casquinha de Sorvete',
    description: 'Casquinha tradicional de sorvete',
    price: 6.9,
    category: 'sorvetes',
  },
  {
    id: 122,
    name: 'Picolé de Açaí',
    description: 'Picolé de açaí puro, sem açúcar',
    price: 5.9,
    category: 'sorvetes',
  },
  {
    id: 131,
    name: 'Coca-Cola Lata',
    description: 'Coca-Cola 350ml gelada',
    price: 6.9,
    category: 'bebidas',
  },
  {
    id: 132,
    name: 'Água Mineral',
    description: 'Água mineral sem gás 500ml',
    price: 4.9,
    category: 'bebidas',
  },
]

/** Cardápios por-tenant (slug → dados). Sem entrada → null */
export const tenantMenuOverrides: Record<
  string,
  { categories: Category[]; products: Product[] }
> = {
  'gota-acai': {
    categories: gotaAcaiCategories,
    products: gotaAcaiProducts,
  },
}

export function getCategoriesForSlug(slug: string): Category[] {
  return tenantMenuOverrides[slug]?.categories ?? mockCategories
}

export function getProductsForSlug(slug: string): Product[] {
  return tenantMenuOverrides[slug]?.products ?? mockProducts
}

/** Converte um hex (#rrggbb) em tupla rgb "r, g, b" para --seg-primary-rgb */
export function hexToRgbTuple(hex: string): string {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const num = Number.parseInt(full, 16)
  // eslint-disable-next-line no-bitwise
  const r = (num >> 16) & 255
  // eslint-disable-next-line no-bitwise
  const g = (num >> 8) & 255
  // eslint-disable-next-line no-bitwise
  const b = num & 255
  return `${r}, ${g}, ${b}`
}

/**
 * Escurece um hex (#rrggbb) por um fator (0..1) → variante `-dark`.
 * Ex.: #7b2d8b com 0.85 → #692a78 (tema escuro do header/btn).
 */
export function darkenHex(hex: string, factor = 0.8): string {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  const num = Number.parseInt(full, 16)
  // eslint-disable-next-line no-bitwise
  const r = Math.round(((num >> 16) & 255) * factor)
  // eslint-disable-next-line no-bitwise
  const g = Math.round(((num >> 8) & 255) * factor)
  // eslint-disable-next-line no-bitwise
  const b = Math.round((num & 255) * factor)
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

export const mockProducts: Product[] = [
  {
    id: 1,
    name: 'X-Burger Clássico',
    description: 'Hambúrguer artesanal com queijo cheddar, alface, tomate e molho especial',
    price: 22.9,
    category: 'hamburguers',
  },
  {
    id: 2,
    name: 'X-Bacon',
    description: 'Hambúrguer com bacon crocante, queijo cheddar, cebola crispy e molho barbecue',
    price: 26.9,
    category: 'hamburguers',
  },
  {
    id: 3,
    name: 'X-Tudo',
    description: 'Completo: hambúrguer, ovo, bacon, queijo, presunto, alface, tomate e milho',
    price: 29.9,
    category: 'hamburguers',
  },
  {
    id: 4,
    name: 'Baby Burger',
    description: 'Hambúrguer pequeno com queijo e ketchup. Perfeito para as crianças!',
    price: 14.9,
    category: 'hamburguers',
  },
  {
    id: 5,
    name: 'Hot Dog Especial',
    description: 'Salsicha com purê de batata, milho, ervilha, cebola crispy e molho da casa',
    price: 18.9,
    category: 'hot-dogs',
    options: [
      {
        id: 'pao',
        name: 'Tipo de Pão',
        required: true,
        options: [
          { id: 'normal', label: 'Normal' },
          { id: 'prensado', label: 'Prensado', priceAdjustment: 2 },
        ],
      },
    ],
  },
  {
    id: 6,
    name: 'Hot Dog Simples',
    description: 'Salsicha com ketchup, mostarda e maionese',
    price: 12.9,
    category: 'hot-dogs',
  },
  {
    id: 7,
    name: 'Porção de Batata Frita',
    description: 'Batata frita crocante porção generosa para dividir',
    price: 24.9,
    category: 'porcoes',
    options: [
      {
        id: 'tamanho',
        name: 'Tamanho',
        required: true,
        options: [
          { id: 'media', label: 'Média' },
          { id: 'grande', label: 'Grande', priceAdjustment: 8 },
        ],
      },
    ],
  },
  {
    id: 8,
    name: 'Porção de Onion Rings',
    description: 'Anéis de cebola empanados e fritos. Porção para compartilhar.',
    price: 26.9,
    category: 'porcoes',
  },
  {
    id: 9,
    name: 'Coca-Cola Lata',
    description: 'Coca-Cola 350ml gelada',
    price: 6.9,
    category: 'bebidas',
  },
  {
    id: 10,
    name: 'Guaraná Antarctica Lata',
    description: 'Guaraná Antarctica 350ml gelado',
    price: 6.9,
    category: 'bebidas',
  },
  {
    id: 11,
    name: 'Suco Natural',
    description: 'Suco de laranja, limão ou maracujá. 400ml.',
    price: 8.9,
    category: 'bebidas',
    options: [
      {
        id: 'sabor',
        name: 'Sabor',
        required: true,
        options: [
          { id: 'laranja', label: 'Laranja' },
          { id: 'limao', label: 'Limão' },
          { id: 'maracuja', label: 'Maracujá' },
        ],
      },
    ],
  },
  {
    id: 12,
    name: 'Água Mineral',
    description: 'Água mineral sem gás 500ml',
    price: 4.9,
    category: 'bebidas',
  },
]

export function getTenantBySlug(slug: string): Tenant | null {
  return mockTenants[slug] ?? null
}
