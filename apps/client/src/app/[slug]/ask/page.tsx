import { Conversation } from '@/components/pages/conversation'

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams
  return <Conversation key={q ?? ''} initial={q} />
}
