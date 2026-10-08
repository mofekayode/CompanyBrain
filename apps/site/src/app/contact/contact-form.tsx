'use client'

import { useState, type FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { site } from '@/lib/site'
import { cn } from '@/lib/utils'

const stages = ['Under LOI', 'Just closed', 'In transition', 'Other']

/** No backend yet: submitting opens a pre-filled email to site.contactEmail. */
export function ContactForm() {
  const [stage, setStage] = useState(stages[1])

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const body = [
      `Name: ${f.get('name')}`,
      `Email: ${f.get('email')}`,
      `Company: ${f.get('company') || '-'}`,
      `Stage: ${stage}`,
      '',
      String(f.get('message') ?? ''),
    ].join('\n')
    window.location.href = `mailto:${site.contactEmail}?subject=${encodeURIComponent('Transition: ' + (f.get('company') || f.get('name')))}&body=${encodeURIComponent(body)}`
  }

  const label = 'mb-1.5 block text-[13px] font-medium text-ink'
  const field = 'h-11 bg-white px-3.5 text-[15px]'

  return (
    <form onSubmit={onSubmit} className="space-y-5 rounded-2xl border border-border bg-white p-6 shadow-xl shadow-navy/5 sm:p-8">
      <div className="grid gap-5 sm:grid-cols-2">
        <label>
          <span className={label}>Name</span>
          <Input name="name" required autoComplete="name" className={field} />
        </label>
        <label>
          <span className={label}>Work email</span>
          <Input name="email" type="email" required autoComplete="email" className={field} />
        </label>
      </div>
      <label className="block">
        <span className={label}>Company</span>
        <Input name="company" placeholder="Optional" className={field} />
      </label>
      <fieldset>
        <legend className={label}>Where is the transition?</legend>
        <div className="flex flex-wrap gap-2">
          {stages.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={stage === s}
              onClick={() => setStage(s)}
              className={cn(
                'rounded-full border px-3.5 py-1.5 text-[14px] transition-colors',
                stage === s ? 'border-ink bg-ink text-white' : 'border-border bg-white hover:border-ink/30',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className={label}>What should we know?</span>
        <Textarea
          name="message"
          rows={5}
          placeholder="Industry, size, how long the seller is staying, systems you know about…"
          className="bg-white px-3.5 py-3 text-[15px]"
        />
      </label>
      <Button type="submit" size="cta" className="w-full">
        Send
        <ArrowRight data-icon="inline-end" />
      </Button>
    </form>
  )
}
