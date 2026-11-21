export type Segment = 'lanchonete' | 'hamburgueria' | 'pizzaria' | 'marmitaria'

export interface Tenant {
  slug: string
  name: string
  segment: Segment
  primaryColor: string
  headerImage?: string | null
  whatsappNumber: string
  pixKey?: string
  address?: string
}

export interface Category {
  id: string
  name: string
  icon: string
}

export interface ProductOption {
  id: string
  label: string
  priceAdjustment?: number
}

export interface OptionGroup {
  id: string
  name: string
  required: boolean
  options: ProductOption[]
}

export interface Product {
  id: number
  name: string
  description: string
  price: number
  category: string
  image?: string
  options?: OptionGroup[]
}

export interface SelectedOption {
  groupId: string
  optionId: string
}

export interface CartItem {
  product: Product
  quantity: number
  selectedOption?: SelectedOption
  note?: string
}

export type PaymentMethod = 'pix' | 'dinheiro' | 'credito' | 'debito'

export type OrderStatus = 'recebido' | 'preparando' | 'saiu' | 'entregue'

export interface Order {
  id: string
  items: CartItem[]
  total: number
  status: OrderStatus
  paymentMethod: PaymentMethod
  createdAt: string
}
