import { SearchPage } from '@/components/search/search-page'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <SearchPage slug={(await params).slug} />
}
