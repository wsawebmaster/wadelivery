import StoreDetailClient from '@/components/admin/StoreDetailClient'

export default async function AdminLojaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <StoreDetailClient id={id} />
}
