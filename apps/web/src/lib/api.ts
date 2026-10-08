/** Base URL of the Company Brain API (apps/api). The portal is UI only and calls it over HTTP. */
export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4318'

/** Server-side fetch from the API (server components). Throws on non-2xx except 404, which returns null. */
export async function apiGet<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API}${path}`, { cache: 'no-store' })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
