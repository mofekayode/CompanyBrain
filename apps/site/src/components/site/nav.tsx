'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { site } from '@/lib/site'
import { cn } from '@/lib/utils'
import { Logo } from './logo'
import { LinkButton } from './link-button'

export function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header
      className={cn(
        'sticky top-0 z-50 border-b transition-colors',
        scrolled || open ? 'border-border bg-paper/85 backdrop-blur-md' : 'border-transparent bg-transparent',
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav className="hidden items-center gap-8 md:flex">
          {site.nav.map((item) => (
            <Link key={item.href} href={item.href} className="text-[14px] text-muted-foreground transition-colors hover:text-ink">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="hidden md:block">
          <LinkButton href={site.cta.href} size="lg" className="px-3.5">
            {site.cta.label}
          </LinkButton>
        </div>
        <button
          type="button"
          className="-mr-2 grid size-10 place-items-center rounded-lg text-ink md:hidden"
          aria-label={open ? 'Close menu' : 'Open menu'}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-border px-4 pt-2 pb-5 md:hidden">
          <nav className="flex flex-col">
            {site.nav.map((item) => (
              <Link key={item.href} href={item.href} onClick={() => setOpen(false)} className="py-3 text-[15px] text-ink">
                {item.label}
              </Link>
            ))}
          </nav>
          <LinkButton href={site.cta.href} size="cta" className="mt-3 w-full" onClick={() => setOpen(false)}>
            {site.cta.label}
          </LinkButton>
        </div>
      )}
    </header>
  )
}
