import { store } from '@companybrain/core/workbench/server'

// Serving raw files to the browser. Audio and video need HTTP range requests to seek: without
// `206 Partial Content` the browser can only play from the start. Recently opened files stay in a
// small memory cache, so each seek doesn't re-download the object from S3.

const MAX_CACHE = 400 * 1024 * 1024
const cache = new Map<string, Uint8Array>()
let cached = 0

async function bytesFor(key: string): Promise<Uint8Array | null> {
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit) // most recent last
    return hit
  }
  const bytes = await (await store()).get(key)
  if (!bytes) return null
  if (bytes.byteLength < MAX_CACHE / 4) {
    cache.set(key, bytes)
    cached += bytes.byteLength
    for (const [k, v] of cache) {
      if (cached <= MAX_CACHE) break
      cache.delete(k)
      cached -= v.byteLength
    }
  }
  return bytes
}

export async function serveRaw(req: Request, file: { s3_key: string; mime_type: string | null; original_filename: string }, opts: { download?: boolean } = {}): Promise<Response> {
  const bytes = await bytesFor(file.s3_key)
  if (!bytes) return new Response('raw object missing', { status: 404 })
  // Browsers play H.264 QuickTime fine but refuse the video/quicktime type inline.
  const type = !opts.download && file.mime_type === 'video/quicktime' ? 'video/mp4' : (file.mime_type ?? 'application/octet-stream')
  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-disposition': `${opts.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.original_filename)}`,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
  }
  const size = bytes.byteLength
  const range = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/)
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    if (!range[1]) end = size - 1
    start = Math.max(0, start)
    end = Math.min(end, size - 1)
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
    const part = bytes.subarray(start, end + 1)
    return new Response(part as BodyInit, { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(part.byteLength) } })
  }
  return new Response(req.method === 'HEAD' ? null : (bytes as BodyInit), { headers: { ...headers, 'content-length': String(size) } })
}
