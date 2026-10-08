import { AccessPage } from '@/components/access/access-page'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <AccessPage slug={(await params).slug} />
}
