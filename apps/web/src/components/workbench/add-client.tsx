'use client'

import { Plus } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { API } from '@/lib/api'

/** Portal: add a client, then go straight to uploading their files. */
export function AddClient() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" />
        Add client
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Add a client</DialogTitle>
          <DialogDescription>Create the client’s workspace, then upload the files they handed over.</DialogDescription>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!name.trim()) return
              setBusy(true)
              setError(null)
              const r = await fetch(`${API}/api/tenants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
              const j = await r.json()
              if (!r.ok) {
                setError(j.error ?? 'Could not create the client')
                setBusy(false)
                return
              }
              router.push(`/t/${j.slug}/upload`)
            }}
          >
            <Input autoFocus placeholder="Client name, e.g. Riverton Industrial" value={name} onChange={(e) => setName(e.target.value)} />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!name.trim() || busy}>
                {busy ? 'Creating…' : 'Create and upload files'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
