import { cn } from '@/lib/utils'

/** Mark: scattered sources resolving into one connected node (same as the site). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('size-6', className)}>
      <rect width="24" height="24" rx="6" fill="var(--ink)" />
      <path d="M6.5 7.5 12 12M6.5 16.5 12 12M17.5 7 12 12" stroke="#fff" strokeOpacity=".55" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="6.5" cy="7.5" r="1.6" fill="#fff" />
      <circle cx="6.5" cy="16.5" r="1.6" fill="#fff" />
      <circle cx="17.5" cy="7" r="1.6" fill="#fff" />
      <circle cx="12" cy="12" r="2.6" fill="var(--cobalt)" stroke="#fff" strokeWidth="1.2" />
    </svg>
  )
}
