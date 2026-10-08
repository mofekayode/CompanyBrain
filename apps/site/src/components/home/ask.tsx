'use client'

import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Container, SectionHeading } from '@/components/site/section'
import { answers, type Answer } from '@/lib/answers'
import { cn } from '@/lib/utils'
import { AnswerCard } from './answer-card'

const groups: { key: Answer['group']; title: string }[] = [
  { key: 'now', title: 'Answers you need now' },
  { key: 'unknown', title: 'Questions you didn’t know to ask' },
]

export function Ask() {
  const [activeId, setActiveId] = useState(answers[1].id)
  const active = answers.find((a) => a.id === activeId) ?? answers[0]

  return (
    <section id="what-you-get" className="scroll-mt-16 border-y border-cobalt/10 bg-cobalt-soft/50 py-24 sm:py-32">
      <Container>
        <SectionHeading
          eyebrow="What you get"
          title="Ask the company."
          lede="Plain questions, answered from the company’s own evidence. Every answer shows where it came from, what’s current and what’s out of date."
        />
        <div className="mt-14 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:gap-10">
          <div className="space-y-8">
            {groups.map((g) => (
              <div key={g.key}>
                <p className="mb-3 font-mono text-[11px] tracking-[0.08em] text-muted-foreground uppercase">{g.title}</p>
                <ul className="space-y-1.5" role="tablist" aria-label={g.title}>
                  {answers
                    .filter((a) => a.group === g.key)
                    .map((a) => {
                      const selected = a.id === active.id
                      return (
                        <li key={a.id}>
                          <button
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            aria-controls="answer-panel"
                            onClick={() => setActiveId(a.id)}
                            className={cn(
                              'group flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-3.5 text-left text-[15px] transition-colors',
                              selected
                                ? 'border-ink bg-ink text-white'
                                : 'border-border bg-white text-ink hover:border-ink/25',
                            )}
                          >
                            {a.question}
                            <ChevronRight
                              className={cn('size-4 shrink-0', selected ? 'text-white/70' : 'text-muted-foreground')}
                            />
                          </button>
                        </li>
                      )
                    })}
                </ul>
              </div>
            ))}
          </div>

          <div
            id="answer-panel"
            role="tabpanel"
            className="rounded-2xl border border-border bg-white p-5 shadow-xl shadow-navy/5 sm:p-7 lg:sticky lg:top-24 lg:self-start"
          >
            <AnswerCard key={active.id} answer={active} className="animate-in fade-in duration-300" />
            <p className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
              Illustrative answers from our demo company.
            </p>
          </div>
        </div>
      </Container>
    </section>
  )
}
