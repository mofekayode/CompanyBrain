/** Base URL of the Company Brain API (apps/api). The client app is UI only. */
export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4318'

export const tenantApi = (slug: string) => `${API}/api/t/${slug}`

export async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `${r.status}`)
  return r.json() as Promise<T>
}

export async function postJSON<T>(url: string, body: unknown, method = 'POST'): Promise<T> {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new Error(j?.error ?? `${r.status}`)
  return j as T
}

export const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`
