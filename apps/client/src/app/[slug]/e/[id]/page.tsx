import { EntityPage } from '@/components/pages/entity'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <EntityPage id={(await params).id} />
}
