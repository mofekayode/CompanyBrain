import type { Metadata } from 'next'
import { Clock, MessagesSquare, ShieldCheck } from 'lucide-react'
import { Container, Eyebrow } from '@/components/site/section'
import { ContactForm } from './contact-form'

export const metadata: Metadata = {
  title: 'Talk about your transition',
  description: 'Tell us about the company you bought and where the transition stands.',
}

const expect = [
  { icon: MessagesSquare, text: 'A 30-minute call about the business, the seller and your timeline.' },
  { icon: Clock, text: 'Where knowledge is most at risk, and what we’d capture first.' },
  { icon: ShieldCheck, text: 'No data shared until you’re ready. Happy to sign an NDA first.' },
]

export default function ContactPage() {
  return (
    <section className="py-16 sm:py-24">
      <Container className="grid gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
        <div>
          <Eyebrow>Contact</Eyebrow>
          <h1 className="mt-4 text-balance text-[40px] leading-[1.04] font-semibold tracking-[-0.04em] sm:text-[52px]">
            Talk about your transition.
          </h1>
          <p className="mt-5 text-pretty text-[17px] leading-relaxed text-muted-foreground">
            Under LOI, just closed or months into the handoff: tell us where things stand and we’ll get back to you
            within one business day.
          </p>
          <ul className="mt-10 space-y-4">
            {expect.map(({ icon: Icon, text }) => (
              <li key={text} className="flex gap-3 text-[15px]">
                <Icon className="mt-0.5 size-4.5 shrink-0 text-cobalt" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <ContactForm />
      </Container>
    </section>
  )
}
