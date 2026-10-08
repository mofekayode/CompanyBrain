import { notFound } from 'next/navigation'
import { Uploader } from '@/components/workbench/uploader'
import { apiGet } from '@/lib/api'

export const dynamic = 'force-dynamic'

export default async function UploadPage({ params }: { params: Promise<{ slug: string }> }) {
  const tenant = await apiGet<{ slug: string; name: string }>(`/api/tenants/${encodeURIComponent((await params).slug)}`)
  if (!tenant) notFound()
  return <Uploader slug={tenant.slug} clientName={tenant.name} />
}
