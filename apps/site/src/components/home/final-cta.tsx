import { ArrowRight, Play } from 'lucide-react'
import { LinkButton } from '@/components/site/link-button'
import { Container } from '@/components/site/section'
import { site } from '@/lib/site'

export function FinalCta() {
  return (
    <section className="relative isolate overflow-hidden py-28 sm:py-36">
      <div className="bg-grid mask-fade-y absolute inset-0 -z-10" aria-hidden />
      <Container className="text-center">
        <h2 className="mx-auto max-w-3xl text-balance text-[38px] leading-[1.04] font-semibold tracking-[-0.04em] sm:text-[56px]">
          In the middle of a seller transition?
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-pretty text-[18px] leading-relaxed text-muted-foreground">
          Let’s figure out what the business knows before the handoff ends.
        </p>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
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
    </section>
  )
}
