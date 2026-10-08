import { ChecksPage } from '@/components/checks/checks-page'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ChecksPage slug={(await params).slug} />
}
