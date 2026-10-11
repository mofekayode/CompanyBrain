// Helpers for dev checks: run questions several at a time, and take a fixed, spread-out sample.

/** Runs fn over items, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/** Every k-th item, so the sample spreads over the whole set (the same sample every run). */
export const sampleOf = <T>(items: T[], n: number | null): T[] => (!n || n >= items.length ? items : items.filter((_, i) => i % Math.ceil(items.length / n) === 0).slice(0, n))

/** "--sample 40 --concurrency 6" → { sample: 40, concurrency: 6 } (defaults: all, one at a time). */
export function runFlags(args: string[]) {
  const num = (k: string) => (args.includes(k) ? Number(args[args.indexOf(k) + 1]) : null)
  return { sample: num('--sample'), concurrency: num('--concurrency') ?? 1 }
}
