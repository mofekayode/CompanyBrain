import { redirect } from 'next/navigation'

// Files moved to Sources (email, recordings and system exports are sources too).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  redirect(`/${(await params).slug}/sources`)
}
