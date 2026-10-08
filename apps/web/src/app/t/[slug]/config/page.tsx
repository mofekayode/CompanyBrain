import { ConfigPage } from '@/components/config/config-page'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ConfigPage slug={(await params).slug} />
}
