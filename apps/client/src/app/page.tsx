import Link from 'next/link'
import { LogoMark } from '@/components/shell/logo'
import { API } from '@/lib/api'

export default async function Home() {
  const tenants: { slug: string; name: string }[] = await fetch(`${API}/api/tenants`, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => [])
  return (
    <div className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 font-semibold tracking-[-0.02em]">
          <LogoMark /> Company Brain
        </div>
        <h1 className="mt-6 text-[26px] font-semibold tracking-[-0.02em]">Choose your company</h1>
        <ul className="mt-4 space-y-2">
          {(Array.isArray(tenants) ? tenants : []).map((t) => (
            <li key={t.slug}>
              <Link href={`/${t.slug}`} className="block rounded-lg border border-border bg-white px-4 py-3 text-[14px] font-medium hover:border-cobalt">
                {t.name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
