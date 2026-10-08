// Video embeddings with Twelve Labs (Marengo): visual + audio vectors per clip
// and for the whole video, for semantic video search (indexed in the search
// phase). Adds to the video's existing extraction rather than replacing it.

import { TwelveLabs } from 'twelvelabs-js'
import { presignDownload } from '../aws'
import { readEnv } from '../env'

export const TWELVELABS_EMBEDDER = { name: 'twelvelabs-marengo', version: '1', model: 'marengo3.5' as const }

export function twelveLabsConfigured(): boolean {
  return !!readEnv(['TWELVE_LABS_API_KEY'] as const).TWELVE_LABS_API_KEY
}

export interface VideoEmbeddings {
  task_id: string
  model: string
  segments: { option: string | undefined; scope: string | undefined; start_sec: number | null; end_sec: number | null; vector: number[] }[]
  dimensions: number | null
}

export async function embedVideo(s3Key: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<VideoEmbeddings> {
  const apiKey = readEnv(['TWELVE_LABS_API_KEY'] as const).TWELVE_LABS_API_KEY
  if (!apiKey) throw new Error('TWELVE_LABS_API_KEY is not set')
  const client = new TwelveLabs({ apiKey })
  // Twelve Labs reads the file straight from S3 through a short-lived signed URL.
  const url = await presignDownload(s3Key, 6 * 3600)
  const task = await client.embed.v2.tasks.create({
    inputType: 'video',
    modelName: TWELVELABS_EMBEDDER.model,
    video: {
      mediaSource: { url },
      segmentation: { temporal: { strategy: 'dynamic', dynamic: { minDurationSec: 2 } } },
      embeddingOption: ['visual', 'audio'],
      embeddingScope: ['clip', 'asset'],
    },
  })
  const taskId = (task as { id?: string; taskId?: string }).id ?? (task as { taskId?: string }).taskId
  if (!taskId) throw new Error(`Twelve Labs did not return a task id: ${JSON.stringify(task).slice(0, 200)}`)

  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000)
  for (;;) {
    const r = await client.embed.v2.tasks.retrieve(taskId)
    if (r.status === 'ready') {
      const segments = (r.data ?? []).map((d) => ({
        option: d.embeddingOption,
        scope: d.embeddingScope,
        start_sec: d.startSec ?? null,
        end_sec: d.endSec ?? null,
        vector: d.embedding,
      }))
      return { task_id: taskId, model: TWELVELABS_EMBEDDER.model, segments, dimensions: segments[0]?.vector.length ?? null }
    }
    if (r.status === 'failed') throw new Error(`Twelve Labs embedding failed: ${r.error?.message ?? 'unknown error'}`)
    if (Date.now() > deadline) throw new Error(`Twelve Labs task ${taskId} did not finish in time`)
    await new Promise((res) => setTimeout(res, opts.pollMs ?? 5000))
  }
}
