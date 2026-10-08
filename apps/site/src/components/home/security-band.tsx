import Link from 'next/link'
import { ArrowRight, Lock } from 'lucide-react'
import { Container, Eyebrow } from '@/components/site/section'

export const securityPoints = [
  { title: 'You own your information', body: 'Your data is yours. We never sell it or use it to serve anyone else.' },
  { title: 'Isolated per company', body: 'Every record and file is tied to its company, and the database enforces that separation.' },
  { title: 'Originals never change', body: 'Files are stored write-once, exactly as received, so every answer traces back to an untouched original.' },
  { title: 'Permissions are enforced', body: 'People see what their role allows. Sensitive files stay locked until an admin releases them.' },
  { title: 'Encrypted', body: 'Data is encrypted in transit and at rest.' },
  { title: 'Audited', body: 'Access grants, releases and changes are logged.' },
]

const log = [
  ['09:12', 'Admin released “Field operations” to 31 people'],
  ['09:40', 'Technician requested access to Rates 2026.xlsx'],
  ['09:41', 'Admin approved, this file only'],
  ['10:05', 'Payroll Q3.xlsx kept restricted, hidden from 84 people'],
]

export function SecurityBand() {
  return (
    <section className="border-t border-border py-24 sm:py-32">
      <Container className="grid grid-cols-1 gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-20">
        <div>
          <Eyebrow>Security</Eyebrow>
          <h2 className="mt-4 text-balance text-[34px] leading-[1.06] font-semibold tracking-[-0.035em] sm:text-[44px]">
            Your company data stays your company data.
          </h2>
          <p className="mt-5 max-w-md text-pretty text-[17px] leading-relaxed text-muted-foreground">
            You’re trusting us with the inside of a business you just paid for. We preserve existing permissions where
            they can be inherited, and administrators control access where they can’t.
          </p>
          <dl className="mt-10 divide-y divide-border border-y border-border">
            {securityPoints.map((p) => (
              <div key={p.title} className="grid gap-1 py-3.5 sm:grid-cols-[180px_1fr] sm:gap-6">
                <dt className="text-[14px] font-medium text-ink">{p.title}</dt>
                <dd className="text-[14px] leading-relaxed text-muted-foreground">{p.body}</dd>
              </div>
            ))}
          </dl>
          <Link href="/security" className="mt-8 inline-flex items-center gap-1.5 text-[15px] font-medium text-ink hover:text-cobalt">
            How we handle your data <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="space-y-4 lg:pt-14">
          <p className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">Same question, two people</p>
          <Asked
            who="Field technician"
            answer={
              <p className="flex items-start gap-2 text-[14px] text-ink/80">
                <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                Pay information isn’t available to your role. Nothing from those files was used to answer.
              </p>
            }
          />
          <Asked
            who="Owner"
            answer={
              <>
                <p className="text-[14px] font-medium text-ink">Total payroll is summarized in Payroll Q3.xlsx.</p>
                <p className="mt-2 inline-block rounded border border-border bg-paper px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  Payroll Q3.xlsx · Restricted · owners only
                </p>
              </>
            }
          />
          <div className="rounded-xl border border-border bg-white">
            <p className="border-b border-border px-4 py-2.5 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
              Access log
            </p>
            <ul className="divide-y divide-border">
              {log.map(([t, e]) => (
                <li key={t} className="flex gap-4 px-4 py-2.5 text-[13px]">
                  <span className="font-mono text-muted-foreground">{t}</span>
                  <span className="text-ink/85">{e}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Container>
    </section>
  )
}

function Asked({ who, answer }: { who: string; answer: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          <span className="font-medium text-ink">{who}</span> asks
        </p>
        <p className="truncate rounded-full bg-paper px-2.5 py-0.5 text-[12.5px] text-ink">“What does everyone get paid?”</p>
      </div>
      <div className="mt-3 border-t border-border pt-3">{answer}</div>
    </div>
  )
}
