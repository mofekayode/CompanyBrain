import { Files } from '@/components/pages/files'

export default async function Page({ searchParams }: { searchParams: Promise<{ open?: string }> }) {
  return <Files openId={(await searchParams).open} />
}
