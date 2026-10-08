import Link from 'next/link'
import { site } from '@/lib/site'
import { Logo } from './logo'

const columns = [
  {
    title: 'Product',
    links: [
      { href: '/#how-it-works', label: 'How it works' },
      { href: '/#what-you-get', label: 'What you get' },
      { href: '/demo', label: 'Demo' },
    ],
  },
  {
    title: 'Company',
    links: [
      { href: '/security', label: 'Security' },
      { href: '/contact', label: 'Contact' },
    ],
  },
]

export function Footer() {
  return (
    <footer className="border-t border-border">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
            Helping buyers learn how the company they acquired actually works, before the seller transition ends.
          </p>
        </div>
        {columns.map((col) => (
          <div key={col.title}>
            <p className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{col.title}</p>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="text-sm text-ink/80 hover:text-ink">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="mx-auto flex max-w-6xl flex-col gap-2 border-t border-border px-4 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
        <p>© {new Date().getFullYear()} {site.name}</p>
        <a href={`mailto:${site.contactEmail}`} className="hover:text-ink">
          {site.contactEmail}
        </a>
      </div>
    </footer>
  )
}
