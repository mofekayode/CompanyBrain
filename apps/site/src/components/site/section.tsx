import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-4 sm:px-6', className)}>{children}</div>
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('font-mono text-[11.5px] font-medium tracking-[0.1em] text-cobalt uppercase', className)}>{children}</p>
  )
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  className,
  align = 'left',
}: {
  eyebrow?: ReactNode
  title: ReactNode
  lede?: ReactNode
  className?: string
  align?: 'left' | 'center'
}) {
  return (
    <div className={cn('max-w-2xl', align === 'center' && 'mx-auto text-center', className)}>
      {eyebrow && <Eyebrow className="mb-4">{eyebrow}</Eyebrow>}
      <h2 className="text-balance text-[34px] leading-[1.06] font-semibold tracking-[-0.035em] text-ink sm:text-[44px]">
        {title}
      </h2>
      {lede && <p className="mt-5 text-pretty text-[17px] leading-relaxed text-muted-foreground">{lede}</p>}
    </div>
  )
}
