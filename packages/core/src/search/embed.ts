// Local text embeddings (no API spend): BAAI bge-small-en-v1.5, 384 dimensions,
// int8-quantised ONNX run by Transformers.js on the CPU. ~10 ms per passage.
// Queries get bge's retrieval instruction prefix; passages are embedded as-is.

import { type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers'

export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5'
export const EMBEDDING_DIMS = 384
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '
/** The model reads ~512 tokens; longer text is cut (≈ 2,000 characters). */
const MAX_CHARS = 2000

let extractor: Promise<FeatureExtractionPipeline> | undefined
const model = () => (extractor ??= pipeline('feature-extraction', EMBEDDING_MODEL, { dtype: 'q8' }) as Promise<FeatureExtractionPipeline>)

export async function embedPassages(texts: string[], batch = 32): Promise<number[][]> {
  const m = await model()
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

export async function embedQuery(q: string): Promise<number[]> {
  const m = await model()
  const t = await m([QUERY_PREFIX + q.slice(0, MAX_CHARS)], { pooling: 'cls', normalize: true })
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
