import type { Metadata } from 'next'
import AdminTheme from '@/components/admin/AdminTheme'
import '@/styles/admin.css'

export const metadata: Metadata = {
  title: 'WaDelivery · Painel da plataforma',
  description: 'Gestão das lojas e da operação da plataforma WaDelivery.',
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <AdminTheme>{children}</AdminTheme>
}
