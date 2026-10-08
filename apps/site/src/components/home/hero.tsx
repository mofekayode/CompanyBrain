import { ArrowRight, Play } from 'lucide-react'
import { LinkButton } from '@/components/site/link-button'
import { MediaSlot } from '@/components/site/media-slot'
import { Container } from '@/components/site/section'
import { media } from '@/lib/media'
import { site } from '@/lib/site'
import { ProductDemo } from './product-demo'

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden pt-16 sm:pt-24">
      <div className="bg-grid mask-fade-y absolute inset-x-0 top-0 -z-10 h-[720px]" aria-hidden />
      <Container className="text-center">
        <p className="flex items-center justify-center gap-4 font-serif text-[17px] whitespace-nowrap text-muted-foreground italic">
          <span className="h-px w-8 shrink-0 bg-ink/20 sm:w-12" aria-hidden />
          <span className="sm:hidden">For buyers, after an acquisition</span>
          <span className="hidden sm:inline">For buyers, in the first months after an acquisition</span>
          <span className="h-px w-8 shrink-0 bg-ink/20 sm:w-12" aria-hidden />
        </p>
        <h1 className="mx-auto mt-7 max-w-6xl text-balance text-[42px] leading-[1.02] font-semibold tracking-[-0.045em] text-ink sm:text-[64px] lg:text-[76px]">
          You bought the company.
          <span className="block text-ink/70 lg:whitespace-nowrap">
            Now learn how it{' '}
            <span className="font-serif text-[1em] font-semibold tracking-[-0.035em] text-ink italic">actually</span> works.
          </span>
        </h1>
        <p className="mx-auto mt-7 max-w-2xl text-pretty text-[17px] leading-relaxed text-muted-foreground sm:text-[19px]">
          We work with you during the seller transition to capture what the owner and team know, connect the systems and
          documents the business already runs on, and build a secure Company Brain that stays current after the handoff.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <LinkButton href={site.cta.href} size="cta" className="w-full sm:w-auto">
            {site.cta.label}
            <ArrowRight data-icon="inline-end" />
          </LinkButton>
          <LinkButton href="/demo" size="cta" variant="outline" className="w-full bg-white sm:w-auto">
            <Play data-icon="inline-start" className="fill-current" />
            Watch the demo
          </LinkButton>
        </div>
      </Container>

      <Container className="mt-20 sm:mt-24">
        <div className="relative">
          <div
            className="absolute -inset-x-6 -top-6 -bottom-10 -z-10 rounded-[28px] bg-gradient-to-b from-cobalt-soft/80 via-cobalt-soft/30 to-transparent"
            aria-hidden
          />
          {!media.heroDemo.src && <TryItNote />}
          <MediaSlot slot={media.heroDemo} fallback={<ProductDemo />} className="shadow-2xl shadow-navy/10" />
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Sample data from our demo company, a fictional industrial services business.
          </p>
        </div>
      </Container>
    </section>
  )
}

/** Margin annotation pointing at the clickable sidebar. */
function TryItNote() {
  return (
    <div className="pointer-events-none absolute -top-12 left-2 hidden items-end gap-1.5 text-cobalt md:flex" aria-hidden>
      <span className="font-serif text-[17px] italic">try it, click around</span>
      <svg viewBox="0 0 40 32" className="mb-[-18px] h-8 w-10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M2 6 C 18 4, 30 10, 32 26" />
        <path d="M26 21 L 32 27 L 36 20" />
      </svg>
    </div>
  )
}
