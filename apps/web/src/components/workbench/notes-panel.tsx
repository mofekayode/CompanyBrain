'use client'

import { Download, NotebookPen } from 'lucide-react'
import { useState } from 'react'
import { MessageResponse } from '@/components/ai-elements/message'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

export interface Note {
  id: string
  title: string
  body: string
  kind: string
  created_at: string
}

/** Internal FDE notes saved from the chat. */
export function NotesPanel({ notes }: { notes: Note[] }) {
  const [open, setOpen] = useState<Note | null>(null)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-4 py-3">
        <p className="text-[11px] text-muted-foreground">Internal FDE notes saved from the chat. Not for clients.</p>
      </div>
      <ol className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {notes.length === 0 && (
          <li className="px-3 py-8 text-center text-xs text-muted-foreground">
            No notes yet. Use <span className="font-medium text-foreground">Save to notes</span> under any agent reply.
          </li>
        )}
        {notes.map((n) => (
          <li key={n.id}>
            <button onClick={() => setOpen(n)} className="w-full rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-signal/40">
              <div className="flex items-start gap-2">
                <NotebookPen className="mt-0.5 size-3.5 shrink-0 text-signal" />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">{n.title}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {n.kind === 'discovery_summary' ? 'Discovery summary · ' : ''}
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
              </div>
            </button>
          </li>
        ))}
      </ol>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="flex h-[88vh] w-[min(92vw,60rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
          <div className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-3.5 pr-12">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-base font-semibold">{open?.title}</DialogTitle>
              <DialogDescription className="text-[11px]">Internal note · {open && new Date(open.created_at).toLocaleString()}</DialogDescription>
            </div>
            {open && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const url = URL.createObjectURL(new Blob([open.body], { type: 'text/markdown' }))
                  const a = Object.assign(document.createElement('a'), { href: url, download: `${open.title.replace(/[^\w.-]+/g, '-').slice(0, 80)}.md` })
                  a.click()
                  URL.revokeObjectURL(url)
                }}
              >
                <Download data-icon="inline-start" />
                .md
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">{open && <MessageResponse className="text-sm">{open.body}</MessageResponse>}</div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
