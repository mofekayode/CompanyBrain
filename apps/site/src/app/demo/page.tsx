import type { Metadata } from 'next'
import { ArrowRight } from 'lucide-react'
import { Container, Eyebrow } from '@/components/site/section'
import { MediaSlot } from '@/components/site/media-slot'
import { LinkButton } from '@/components/site/link-button'
import { media } from '@/lib/media'
import { site } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Demo',
  description: 'Watch Company Brain learn how a messy, recently acquired company actually works.',
}

const chapters = [
  { title: 'The handoff, as found', body: 'Thousands of files, a mailbox export, old system dumps, scans, interview recordings and shop-floor video.' },
  { title: 'What are Blue Ridge’s actual payment terms?', body: 'The contract and the books disagree. See which one wins, and why.' },
  { title: 'Which customers get fees waived, and why?', body: 'An answer that only exists in a billing screen recording and one person’s memory.' },
  { title: 'Where does training contradict current policy?', body: 'A safety video teaching a procedure that changed last year.' },
  { title: 'What knowledge leaves when a key person does?', body: 'The people the business can’t afford to lose, and what only they know.' },
  { title: 'Who can see what', body: 'The same question asked by a technician and by an owner, with different answers.' },
]

export default function DemoPage() {
  return (
    <section className="py-16 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <Eyebrow>Demo</Eyebrow>
          <h1 className="mt-4 text-balance text-[40px] leading-[1.04] font-semibold tracking-[-0.04em] sm:text-[56px]">
            A messy company, from handoff to answers.
          </h1>
          <p className="mt-5 text-pretty text-[17px] leading-relaxed text-muted-foreground">
            We built a realistic acquired business, a fictional industrial services company with twenty years of
            files, email, systems and tribal knowledge, and ran it through Company Brain. No real customer data.
          </p>
        </div>

        <div className="mt-12">
          <MediaSlot slot={media.demoWalkthrough} className="shadow-2xl shadow-navy/10" />
        </div>

        <div className="mt-20 grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <h2 className="text-[28px] leading-tight font-semibold tracking-[-0.03em]">What you’ll see</h2>
            <p className="mt-3 text-[16px] text-muted-foreground">Every answer opens the exact source: the page, the row, the email or the moment in a video.</p>
            <div className="mt-8">
              <MediaSlot slot={media.videoTimestamp} />
            </div>
          </div>
          <ol className="divide-y divide-border border-y border-border">
            {chapters.map((c, i) => (
              <li key={c.title} className="flex gap-5 py-5">
                <span className="font-mono text-[13px] text-cobalt">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <p className="text-[16px] font-semibold tracking-[-0.01em]">{c.title}</p>
                  <p className="mt-1 text-[14.5px] text-muted-foreground">{c.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-20 flex flex-col items-start justify-between gap-6 rounded-2xl border border-border bg-white p-8 sm:flex-row sm:items-center">
          <div>
            <p className="text-[20px] font-semibold tracking-[-0.02em]">Want to see it on a business like yours?</p>
            <p className="mt-1 text-[15px] text-muted-foreground">We’ll walk you through it live and talk about your transition.</p>
          </div>
          <LinkButton href={site.cta.href} size="cta">
            {site.cta.label}
            <ArrowRight data-icon="inline-end" />
          </LinkButton>
        </div>
      </Container>
    </section>
  )
}
