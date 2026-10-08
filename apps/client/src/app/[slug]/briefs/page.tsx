import { Briefs } from '@/components/pages/briefs'

export default async function Page({ searchParams }: { searchParams: Promise<{ skill?: string; input?: string }> }) {
  return <Briefs initial={await searchParams} />
}
