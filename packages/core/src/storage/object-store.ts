import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'

export interface PutOptions {
  sha256Hex: string
  contentType?: string
  metadata?: Record<string, string>
}

export interface StoredObject {
  sha256Hex: string | undefined
  size: number
  metadata: Record<string, string>
}

/**
 * The storage operations the platform needs. `putIfAbsent` is the only way raw
 * evidence is written: it never overwrites (S3 conditional write), and the
 * bucket policy rejects any raw write that does not use it.
 */
export interface ObjectStore {
  readonly bucket: string
  putIfAbsent(key: string, body: Uint8Array, options: PutOptions): Promise<'created' | 'exists'>
  /** Overwriting put, for processed/ and derived/ artifacts only (raw/ is write-once by bucket policy). */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  head(key: string): Promise<StoredObject | null>
  get(key: string): Promise<Uint8Array | null>
}

const SHA256_META = 'sha256'

export class S3ObjectStore implements ObjectStore {
  constructor(
    readonly bucket: string,
    private readonly client = new S3Client({}),
  ) {}

  async putIfAbsent(key: string, body: Uint8Array, options: PutOptions): Promise<'created' | 'exists'> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          IfNoneMatch: '*',
          ContentType: options.contentType,
          ChecksumSHA256: Buffer.from(options.sha256Hex, 'hex').toString('base64'), // S3 verifies the bytes on arrival
          Metadata: { ...options.metadata, [SHA256_META]: options.sha256Hex },
        }),
      )
      return 'created'
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) return 'exists'
      throw error
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    if (/^[^/]+\/raw\//.test(key)) throw new Error('raw/ objects are write-once; use putIfAbsent')
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }))
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return { sha256Hex: r.Metadata?.[SHA256_META], size: r.ContentLength ?? 0, metadata: r.Metadata ?? {} }
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null
      throw error
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return (await r.Body?.transformToByteArray()) ?? null
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null
      throw error
    }
  }
}

/** In-memory store with the same write-once semantics, for tests and local tooling. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; sha256Hex: string; metadata: Record<string, string> }>()

  constructor(readonly bucket = 'memory') {}

  async putIfAbsent(key: string, body: Uint8Array, options: PutOptions): Promise<'created' | 'exists'> {
    if (this.objects.has(key)) return 'exists'
    this.objects.set(key, { body, sha256Hex: options.sha256Hex, metadata: { ...options.metadata } })
    return 'created'
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    if (/^[^/]+\/raw\//.test(key)) throw new Error('raw/ objects are write-once; use putIfAbsent')
    this.objects.set(key, { body, sha256Hex: '', metadata: { 'content-type': contentType } })
  }

  async head(key: string): Promise<StoredObject | null> {
    const o = this.objects.get(key)
    return o ? { sha256Hex: o.sha256Hex, size: o.body.byteLength, metadata: o.metadata } : null
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.body ?? null
  }
}
