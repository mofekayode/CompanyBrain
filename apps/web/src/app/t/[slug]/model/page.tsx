import { ModelPage } from '@/components/model/model-page'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ModelPage slug={(await params).slug} />
}
