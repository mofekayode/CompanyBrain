import type { ReactNode } from 'react'
import { Film, ImageIcon, Clapperboard } from 'lucide-react'
import type { MediaSlot as Slot } from '@/lib/media'
import { cn } from '@/lib/utils'

const icons = { video: Film, image: ImageIcon, gif: Clapperboard }

/**
 * Renders the media file once `src` is set in lib/media.ts.
 * Until then: `fallback` if given (e.g. a coded product mock), else a labelled placeholder.
 */
export function MediaSlot({ slot, fallback, className }: { slot: Slot; fallback?: ReactNode; className?: string }) {
  const style = { aspectRatio: slot.aspect.replace('/', ' / ') }

  if (slot.src && slot.kind === 'video') {
    return (
      <video
        className={cn('w-full rounded-xl bg-ink object-cover', className)}
        style={style}
        src={slot.src}
        poster={slot.poster}
        controls
        playsInline
        preload="metadata"
        aria-label={slot.alt}
      />
    )
  }
  if (slot.src) {
    // eslint-disable-next-line @next/next/no-img-element -- GIFs must not be optimised into stills
    return <img className={cn('w-full rounded-xl object-cover', className)} style={style} src={slot.src} alt={slot.alt} />
  }
  if (fallback) return <>{fallback}</>

  const Icon = icons[slot.kind]
  return (
    <div
      className={cn(
        'bg-grid relative flex w-full flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed border-ink/15 bg-white/60 p-6 text-center',
        className,
      )}
      style={style}
      role="img"
      aria-label={slot.alt}
    >
      <span className="grid size-10 place-items-center rounded-full border border-border bg-white text-muted-foreground">
        <Icon className="size-4.5" />
      </span>
      <p className="font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground uppercase">
        {slot.kind} · {slot.aspect.replace('/', ':')}
      </p>
      <p className="max-w-xs text-sm text-ink/70">{slot.brief}</p>
    </div>
  )
}
