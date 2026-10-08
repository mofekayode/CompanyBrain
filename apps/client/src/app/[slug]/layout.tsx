import { AppShell } from '@/components/shell/app-shell'
import { SessionProvider } from '@/components/shell/session'

export default async function TenantLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return (
    <SessionProvider slug={slug}>
      <AppShell>{children}</AppShell>
    </SessionProvider>
  )
}
