// Media extraction with the providers we already use:
//   speech → ElevenLabs Scribe (diarized, word timestamps; accepts audio and video files)
//   pictures → Claude vision (description, visible text, identifiers)
//   video → ffmpeg keyframes (scene changes + every N s) + both of the above, merged on the timeline

import Anthropic from '@anthropic-ai/sdk'
import { assertApiAllowed } from '../claude'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ffmpegPath from 'ffmpeg-static'
import { readEnv } from '../env'
import { type Artifact, type EvidenceUnit, type ExtractionResult, json, markdown } from './types'

const run = promisify(execFile)

export const AUDIO_EXTRACTOR = { name: 'elevenlabs-scribe', version: '1' }
export const IMAGE_EXTRACTOR = { name: 'claude-vision', version: '1' }
export const VIDEO_EXTRACTOR = { name: 'video-keyframes', version: '1' }

const VISION_MODEL = 'claude-opus-5-5'

// ---------------------------------------------------------------------------
// Speech (ElevenLabs)
// ---------------------------------------------------------------------------

interface ScribeWord {
  text: string
  type: 'word' | 'spacing' | 'audio_event'
  start: number | null
  end: number | null
  speaker_id?: string | null
}
interface ScribeResponse {
  language_code?: string
  text: string
  words: ScribeWord[]
  audio_duration_secs?: number
}

export async function transcribe(bytes: Uint8Array, filename: string, mimeType: string): Promise<ScribeResponse> {
  const key = readEnv(['ELEVENLABS_API_KEY'] as const).ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  const form = new FormData()
  form.append('model_id', 'scribe_v2')
  form.append('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename)
  form.append('diarize', 'true')
  form.append('timestamps_granularity', 'word')
  form.append('tag_audio_events', 'true')
  const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form })
  if (!r.ok) throw new Error(`ElevenLabs speech-to-text failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`)
  return (await r.json()) as ScribeResponse
}

export interface SpeechSegment {
  speaker: string
  startMs: number
  endMs: number
  text: string
}

/** Groups words into readable segments: new segment on speaker change, a long pause, or ~45 s. */
export function segmentWords(words: ScribeWord[]): SpeechSegment[] {
  const label = (id: string | null | undefined) => (id ? `Speaker ${Number(id.replace(/\D/g, '') || 0) + 1}` : 'Speaker')
  const segments: SpeechSegment[] = []
  let cur: SpeechSegment | null = null
  for (const w of words) {
    if (w.type === 'spacing' || w.start == null || w.end == null) {
      if (cur && w.type === 'spacing') cur.text += w.text
      continue
    }
    const speaker = label(w.speaker_id)
    const startMs = Math.round(w.start * 1000)
    const gap = cur ? startMs - cur.endMs : 0
    const long = cur ? startMs - cur.startMs > 45_000 && /[.!?]$/.test(cur.text.trim()) : false
    if (!cur || cur.speaker !== speaker || gap > 1500 || long) {
      if (cur) segments.push(cur)
      cur = { speaker, startMs, endMs: Math.round(w.end * 1000), text: '' }
    }
    cur.text += w.type === 'audio_event' ? `${w.text}` : w.text
    cur.endMs = Math.round(w.end * 1000)
  }
  if (cur) segments.push(cur)
  return segments.map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() })).filter((s) => s.text)
}

const ts = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export async function extractAudio(bytes: Uint8Array, filename: string, mimeType: string): Promise<ExtractionResult> {
  const t = await transcribe(bytes, filename, mimeType)
  const segments = segmentWords(t.words)
  return {
    extractor: AUDIO_EXTRACTOR.name,
    extractorVersion: AUDIO_EXTRACTOR.version,
    documentKind: 'transcript',
    title: filename,
    language: t.language_code ?? null,
    units: segments.map((s) => ({
      kind: 'transcript_segment',
      content: `[${ts(s.startMs)}] ${s.speaker}: ${s.text}`,
      startMs: s.startMs,
      endMs: s.endMs,
      speaker: s.speaker,
      locator: { start_ms: s.startMs, end_ms: s.endMs },
    })),
    artifacts: [
      json('transcript.json', t),
      markdown('transcript.md', segments.map((s) => `**${s.speaker}** [${ts(s.startMs)}–${ts(s.endMs)}]\n${s.text}`).join('\n\n')),
    ],
    metadata: { duration_seconds: t.audio_duration_secs ?? null, speakers: [...new Set(segments.map((s) => s.speaker))] },
  }
}

// ---------------------------------------------------------------------------
// Pictures (Claude vision)
// ---------------------------------------------------------------------------

export interface FrameReading {
  description: string
  visible_text: string
  identifiers: string[]
}

const READING_SCHEMA = {
  type: 'object',
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          description: { type: 'string', description: 'What is shown, factually: setting, equipment, documents, whiteboards, people (no names unless written)' },
          visible_text: { type: 'string', description: 'All legible text exactly as written (signs, labels, whiteboards, screens, documents). Empty if none.' },
          identifiers: { type: 'array', items: { type: 'string' }, description: 'Codes visible in the image: asset tags, serial/model numbers, part numbers, work-order or invoice numbers, plates' },
        },
        required: ['index', 'description', 'visible_text', 'identifiers'],
        additionalProperties: false,
      },
    },
  },
  required: ['frames'],
  additionalProperties: false,
} as const

let anthropicClient: Anthropic | undefined
function claude(): Anthropic {
  assertApiAllowed()
  const key = readEnv(['ANTHROPIC_API_KEY'] as const).ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
  anthropicClient ??= new Anthropic({ apiKey: key })
  return anthropicClient
}

/** Reads one or more images (JPEG bytes) in a single request; returns one reading per image. */
export async function readImages(images: { jpeg: Uint8Array; label: string }[], context: string): Promise<FrameReading[]> {
  const content: Anthropic.ContentBlockParam[] = []
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Image ${i}: ${img.label}` })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(img.jpeg).toString('base64') } })
  })
  content.push({
    type: 'text',
    text: `${context}\nFor each image (index 0..${images.length - 1}), describe what is shown, transcribe all legible text exactly, and list identifiers. Be literal; do not guess at what is not visible.`,
  })
  const response = await claude().messages.create({
    model: VISION_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: READING_SCHEMA } },
    messages: [{ role: 'user', content }],
  })
  if (response.stop_reason === 'refusal') throw new Error('vision request was declined')
  const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '{"frames":[]}'
  const parsed = JSON.parse(text) as { frames: (FrameReading & { index: number })[] }
  return images.map((_, i) => parsed.frames.find((f) => f.index === i) ?? { description: '', visible_text: '', identifiers: [] })
}

async function ffmpeg(args: string[]): Promise<string> {
  if (!ffmpegPath) throw new Error('ffmpeg binary not available')
  const { stderr } = await run(ffmpegPath as unknown as string, ['-hide_banner', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 })
  return stderr
}

/** Downscales any image to a JPEG ≤ 1568 px on the long edge (Claude's sweet spot; also normalizes PNG/HEIC). */
async function toJpeg(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-img-'))
  try {
    await writeFile(join(dir, `in.${ext}`), bytes)
    await ffmpeg(['-i', join(dir, `in.${ext}`), '-vf', "scale='if(gt(iw,ih),min(1568,iw),-2)':'if(gt(iw,ih),-2,min(1568,ih))'", '-q:v', '4', join(dir, 'out.jpg')])
    return new Uint8Array(await readFile(join(dir, 'out.jpg')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const readingText = (r: FrameReading) =>
  [r.description && `Shows: ${r.description}`, r.visible_text && `Visible text: ${r.visible_text}`, r.identifiers.length ? `Identifiers: ${r.identifiers.join(', ')}` : null].filter(Boolean).join('\n')

export async function extractImage(bytes: Uint8Array, filename: string, profile?: { media?: Record<string, unknown> }): Promise<ExtractionResult> {
  const jpeg = await toJpeg(bytes, filename.split('.').pop() ?? 'jpg')
  const [reading] = await readImages([{ jpeg, label: filename }], 'These are photos and images from a company handoff (field service business).')
  return {
    extractor: IMAGE_EXTRACTOR.name,
    extractorVersion: IMAGE_EXTRACTOR.version,
    documentKind: 'image',
    title: filename,
    units: [{ kind: 'image', content: readingText(reading) || '(nothing recognisable)', observedAt: profile?.media?.captured_at ? new Date(String(profile.media.captured_at)) : null, metadata: { identifiers: reading.identifiers, exif: profile?.media ?? null } }],
    artifacts: [json('vision.json', reading)],
  }
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

const MAX_FRAMES = 40

export async function extractVideo(bytes: Uint8Array, filename: string, mimeType: string): Promise<ExtractionResult> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-vid-'))
  try {
    const input = join(dir, `in.${filename.split('.').pop() ?? 'mp4'}`)
    await writeFile(input, bytes)

    // Keyframes: first frame, scene changes, and at least one every 15 s; showinfo gives each frame's time.
    const stderr = await ffmpeg([
      '-i', input,
      '-vf', "select='eq(n,0)+gt(scene,0.30)+gte(t-prev_selected_t,15)',showinfo,scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'",
      '-fps_mode', 'vfr', '-q:v', '4', '-frames:v', String(MAX_FRAMES), join(dir, 'frame_%04d.jpg'),
    ])
    const times = [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]))
    const durationMatch = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/)
    const durationMs = durationMatch ? Math.round((Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])) * 1000) : null
    const files = (await readdir(dir)).filter((f) => f.startsWith('frame_')).sort()
    const frames = await Promise.all(files.map(async (f, i) => ({ timeMs: Math.round((times[i] ?? 0) * 1000), jpeg: new Uint8Array(await readFile(join(dir, f))) })))

    // Speech (ElevenLabs accepts the video file directly) and vision, in parallel.
    const [speech, readings] = await Promise.all([
      transcribe(bytes, filename, mimeType).catch((e: Error) => ({ text: '', words: [], error: e.message }) as ScribeResponse & { error?: string }),
      (async () => {
        const out: FrameReading[] = []
        for (let i = 0; i < frames.length; i += 10) {
          const batch = frames.slice(i, i + 10)
          out.push(...(await readImages(batch.map((f) => ({ jpeg: f.jpeg, label: `frame at ${ts(f.timeMs)}` })), `These are keyframes from the video "${filename}" from a company handoff, in time order.`)))
        }
        return out
      })(),
    ])
    const speechSegments = segmentWords(speech.words ?? [])

    // One evidence unit per scene: from this keyframe to the next (or the end).
    const units: EvidenceUnit[] = frames.map((f, i) => {
      const startMs = f.timeMs
      const endMs = frames[i + 1]?.timeMs ?? durationMs ?? startMs
      const said = speechSegments.filter((s) => s.endMs > startMs && s.startMs < Math.max(endMs, startMs + 1))
      const r = readings[i]
      const content = [`[${ts(startMs)}–${ts(endMs)}]`, readingText(r), said.length ? `Speech: ${said.map((s) => `${s.speaker}: ${s.text}`).join(' ')}` : null].filter(Boolean).join('\n')
      return {
        kind: 'video_segment',
        content,
        startMs,
        endMs,
        locator: { start_ms: startMs, end_ms: endMs, keyframe: `keyframes/${String(i + 1).padStart(4, '0')}.jpg` },
        metadata: { identifiers: r.identifiers, has_speech: said.length > 0 },
      }
    })
    if (units.length === 0 && speechSegments.length) {
      for (const s of speechSegments) units.push({ kind: 'video_segment', content: `[${ts(s.startMs)}] ${s.speaker}: ${s.text}`, startMs: s.startMs, endMs: s.endMs, speaker: s.speaker })
    }

    const artifacts: Artifact[] = [
      json('frames.json', frames.map((f, i) => ({ time_ms: f.timeMs, keyframe: `keyframes/${String(i + 1).padStart(4, '0')}.jpg`, ...readings[i] }))),
      json('transcript.json', speech),
      ...frames.map((f, i) => ({ zone: 'derived' as const, name: `keyframes/${String(i + 1).padStart(4, '0')}.jpg`, body: f.jpeg, contentType: 'image/jpeg' })),
    ]
    return {
      extractor: VIDEO_EXTRACTOR.name,
      extractorVersion: VIDEO_EXTRACTOR.version,
      documentKind: 'video',
      title: filename,
      language: speech.language_code ?? null,
      units,
      artifacts,
      metadata: { duration_ms: durationMs, keyframes: frames.length, speech_segments: speechSegments.length, speech_error: (speech as { error?: string }).error ?? null },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
