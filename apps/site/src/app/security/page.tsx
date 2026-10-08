import type { Metadata } from 'next'
import { Container, Eyebrow } from '@/components/site/section'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { securityPoints } from '@/components/home/security-band'
import { site } from '@/lib/site'

export const metadata: Metadata = {
  title: 'Security',
  description: 'How Company Brain handles your company’s data.',
}

const flow = [
  { title: 'Connect', body: 'We ask for read-only access wherever a system allows it, and only to the systems you agree to.' },
  { title: 'Preserve', body: 'Originals are stored write-once, exactly as received: storage refuses to overwrite or delete them. Each has a checksum and a record of where it came from.' },
  { title: 'Process', body: 'Text, tables, audio and video are extracted into evidence that always points back to its original.' },
  { title: 'Scope', body: 'Existing permissions are carried over where they can be. Everything else starts locked until your admin releases it.' },
  { title: 'Answer', body: 'Search and answers only draw on what the person asking is allowed to see.' },
]

const faqs = [
  {
    q: 'Who at your company can see our data?',
    a: 'Only the engineers working on your engagement, and only for the work you’ve asked us to do.',
  },
  {
    q: 'Do you train AI models on our data?',
    a: 'No. We don’t use your data to train models, and we only use AI providers whose terms don’t allow training on it.',
  },
  {
    q: 'Can employees see things they shouldn’t, like payroll?',
    a: 'No. Access is set per file. We carry over existing permissions where they can be inherited, and your administrators decide the rest. Answers only use what the person asking can see, and restricted files aren’t even listed for people outside them.',
  },
  {
    q: 'What happens to our data when the engagement ends?',
    a: 'You decide. We agree retention, return and deletion terms in writing before we start.',
  },
  {
    q: 'Do you have a SOC 2 report?',
    a: 'Not yet. We don’t have a SOC 2 Type II report today. We’re happy to walk through our current controls, architecture and data handling, and complete your security questionnaire, before any access is granted.',
  },
]

export default function SecurityPage() {
  return (
    <section className="py-16 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <Eyebrow>Security</Eyebrow>
          <h1 className="mt-4 text-balance text-[40px] leading-[1.04] font-semibold tracking-[-0.04em] sm:text-[56px]">
            Your company data stays your company data.
          </h1>
          <p className="mt-5 text-pretty text-[17px] leading-relaxed text-muted-foreground">
            You’re trusting us with the inside of a business you just paid for. Here’s how we handle it, in plain
            language.
          </p>
        </div>

        <dl className="mt-16 divide-y divide-border border-y border-border">
          {securityPoints.map(({ title, body }) => (
            <div key={title} className="grid gap-1 py-5 sm:grid-cols-[260px_1fr] sm:gap-10">
              <dt className="text-[16px] font-medium">{title}</dt>
              <dd className="text-[15px] leading-relaxed text-muted-foreground">{body}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-24">
          <h2 className="text-[28px] font-semibold tracking-[-0.03em]">How your data moves</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-5">
            {flow.map((s, i) => (
              <li key={s.title} className="rounded-xl border border-border bg-white p-5">
                <p className="font-mono text-[12px] text-cobalt">{String(i + 1).padStart(2, '0')}</p>
                <p className="mt-3 text-[15px] font-semibold">{s.title}</p>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-24 grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <h2 className="text-[28px] font-semibold tracking-[-0.03em]">Questions</h2>
            <p className="mt-3 text-[15px] text-muted-foreground">
              Something else? Email{' '}
              <a href={`mailto:${site.contactEmail}`} className="text-ink underline underline-offset-4">
                {site.contactEmail}
              </a>
              .
            </p>
          </div>
          <Accordion className="border-y border-border">
            {faqs.map((f) => (
              <AccordionItem key={f.q} value={f.q} className="border-border">
                <AccordionTrigger className="py-5 text-[16px] hover:no-underline">{f.q}</AccordionTrigger>
                <AccordionContent className="pb-5 text-[15px] leading-relaxed text-muted-foreground">{f.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </Container>
    </section>
  )
}
