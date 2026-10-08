import { KnowledgeReview } from '@/components/knowledge/knowledge-review'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <KnowledgeReview slug={(await params).slug} />
}
