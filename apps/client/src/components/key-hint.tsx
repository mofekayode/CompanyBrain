'use client'

// Keyboard help that teaches, then gets out of the way: shown on the first few visits to a page,
// then hidden for good. One grammar everywhere: ⌘K anywhere · / focus · ↵ submit · ⇧↵ new line ·
// ↑↓ pick · esc back out.

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

const SHOW_TIMES = 5

export function KeyHint({ id, children, className }: { id: string; children: React.ReactNode; className?: string }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    try {
      const k = `cb.hint.${id}`
      const n = Number(localStorage.getItem(k) ?? 0)
      if (n < SHOW_TIMES) {
        setShow(true)
        localStorage.setItem(k, String(n + 1))
      }
    } catch {
      setShow(true)
    }
  }, [id])
  if (!show) return null
  // Keyboard help means nothing on a phone or tablet.
  return <p className={cn('hidden font-mono [@media(hover:hover)_and_(pointer:fine)]:block text-[10.5px] text-muted-foreground', className)}>{children}</p>
}
