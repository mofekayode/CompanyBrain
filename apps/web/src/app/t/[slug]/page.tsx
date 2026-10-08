import { Workbench } from '@/components/workbench/workbench'

export default async function TenantPage({ params }: { params: Promise<{ slug: string }> }) {
  return <Workbench slug={(await params).slug} />
}
