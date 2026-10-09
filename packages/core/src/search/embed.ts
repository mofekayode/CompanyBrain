// Local text embeddings (no API spend), int8-quantised ONNX run by Transformers.js on the CPU.
// Each search index version is built with one embedding model; questions must be embedded with the
// same model as the index they search (search asks which version the alias points to).
// BGE models: queries get the retrieval instruction prefix; passages are embedded as-is.

import { type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers'

/** Index version → the embedding model its vectors come from. */
export const EMBEDDINGS: Record<number, { model: string; dims: number; queryPrefix: string }> = {
  1: { model: 'Xenova/bge-small-en-v1.5', dims: 384, queryPrefix: 'Represent this sentence for searching relevant passages: ' },
  // bge-base: on the phrasing-robustness set, meaning search finds the right file in the top 10 for 104/120
  // phrasings (bge-small: 96) and 18/24 situation-style questions (bge-small: 13), at ~7 ms per question.
  2: { model: 'Xenova/bge-base-en-v1.5', dims: 768, queryPrefix: 'Represent this sentence for searching relevant passages: ' },
}
/** The version new indexes are built with, and the default for callers outside search. */
export const DEFAULT_EMBEDDING_VERSION = 1
export const EMBEDDING_MODEL = EMBEDDINGS[DEFAULT_EMBEDDING_VERSION].model
export const EMBEDDING_DIMS = EMBEDDINGS[DEFAULT_EMBEDDING_VERSION].dims
/** The model reads ~512 tokens; longer text is cut (≈ 2,000 characters). */
const MAX_CHARS = 2000

const extractors = new Map<string, Promise<FeatureExtractionPipeline>>()
const model = (version = DEFAULT_EMBEDDING_VERSION) => {
  const name = EMBEDDINGS[version].model
  if (!extractors.has(name)) extractors.set(name, pipeline('feature-extraction', name, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>)
  return extractors.get(name)!
}

export async function embedPassages(texts: string[], batch = 32, version = DEFAULT_EMBEDDING_VERSION): Promise<number[][]> {
  const m = await model(version)
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batch) {
    const t = await m(
      texts.slice(i, i + batch).map((x) => x.slice(0, MAX_CHARS)),
      { pooling: 'cls', normalize: true },
    )
    out.push(...(t.tolist() as number[][]))
  }
  return out
}

export async function embedQuery(q: string, version = DEFAULT_EMBEDDING_VERSION): Promise<number[]> {
  const m = await model(version)
  const t = await m([EMBEDDINGS[version].queryPrefix + q.slice(0, MAX_CHARS)], { pooling: 'cls', normalize: true })
  return (t.tolist() as number[][])[0]
}

let reranker: Promise<{ tokenizer: any; model: any }> | undefined
/** Cross-encoder reranker (ms-marco MiniLM, local): scores (query, passage) pairs jointly. */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers')
  reranker ??= (async () => ({
    tokenizer: await AutoTokenizer.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2'),
    model: await AutoModelForSequenceClassification.from_pretrained('Xenova/ms-marco-MiniLM-L-6-v2', { dtype: 'q8' }),
  }))()
  const { tokenizer, model: m } = await reranker
  if (!passages.length) return []
  const inputs = tokenizer(new Array(passages.length).fill(query), { text_pair: passages.map((p) => p.slice(0, 1500)), padding: true, truncation: true })
  const { logits } = await m(inputs)
  return (logits.tolist() as number[][]).map((r) => r[0])
}
