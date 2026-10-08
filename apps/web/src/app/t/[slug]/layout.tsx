import { ClientShell } from '@/components/shell/client-shell'

export default async function ClientLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  return <ClientShell slug={(await params).slug}>{children}</ClientShell>
}
