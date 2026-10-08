import { SkillsPage } from '@/components/skills/skills-page'

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <SkillsPage slug={(await params).slug} />
}
