import { SearchPage } from '@/components/pages/search'

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  return <SearchPage initial={(await searchParams).q} />
}
