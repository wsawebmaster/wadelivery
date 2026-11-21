import type { Metadata } from 'next'
import { StoreSignupForm } from '@/components/sections/StoreSignupForm'

export const metadata: Metadata = {
  title: 'Criar loja grátis | WaDelivery',
  description: 'Configure e publique o cardápio digital da sua loja.',
}

export default function CreateStorePage() {
  return <StoreSignupForm />
}
