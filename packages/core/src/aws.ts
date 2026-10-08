import { S3Client } from '@aws-sdk/client-s3'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { S3ObjectStore } from './storage/object-store'

// Company Brain lives only in this account. The machine's default AWS profile
// belongs to an unrelated organization and must never be used.
export const AWS_ACCOUNT = '787137578043'
// Locally: the named profile. Deployed on AWS: set COMPANY_BRAIN_AWS_PROFILE="" to use the
// task/instance role. Either way the account is verified before any S3 access.
export const AWS_PROFILE = process.env.COMPANY_BRAIN_AWS_PROFILE ?? 'companybrain'
export const AWS_REGION = 'us-east-1'
export const BUCKET = `company-brain-${AWS_ACCOUNT}`

function awsCredentials() {
  return AWS_PROFILE ? fromIni({ profile: AWS_PROFILE }) : fromNodeProviderChain()
}

/** S3 store for the Company Brain bucket, after proving the credentials belong to our account. */
export async function companyBrainStore(): Promise<S3ObjectStore> {
  const credentials = awsCredentials()
  const identity = await new STSClient({ region: AWS_REGION, credentials }).send(new GetCallerIdentityCommand({}))
  if (identity.Account !== AWS_ACCOUNT) {
    throw new Error(`AWS credentials (${AWS_PROFILE ? `profile "${AWS_PROFILE}"` : 'default chain'}) are account ${identity.Account}, expected ${AWS_ACCOUNT}; refusing to continue`)
  }
  return new S3ObjectStore(BUCKET, new S3Client({ region: AWS_REGION, credentials }))
}

/**
 * Pre-signed, write-once upload URL for a raw object (browser → S3 directly).
 * The browser must send the returned headers: If-None-Match (never overwrite,
 * also required by the bucket policy for raw/) and the SHA-256 checksum, which
 * S3 verifies against the bytes it receives.
 */
export async function presignRawUpload(
  key: string,
  p: { sha256Hex: string; contentType: string; metadata: Record<string, string>; expiresInSeconds?: number },
): Promise<{ url: string; headers: Record<string, string> }> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3')
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
  presigner ??= (async () => {
    await companyBrainStore() // account check
    // WHEN_REQUIRED: we supply the SHA-256 ourselves; don't let the SDK add a checksum of an empty body.
    return new S3Client({ region: AWS_REGION, credentials: awsCredentials(), requestChecksumCalculation: 'WHEN_REQUIRED' })
  })()
  const checksum = Buffer.from(p.sha256Hex, 'hex').toString('base64')
  const url = await getSignedUrl(
    await presigner,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: p.contentType,
      ChecksumSHA256: checksum,
      IfNoneMatch: '*',
      Metadata: { ...p.metadata, sha256: p.sha256Hex },
    }),
    {
      expiresIn: p.expiresInSeconds ?? 900,
      signableHeaders: new Set(['content-type', 'if-none-match', 'x-amz-checksum-sha256']),
      unhoistableHeaders: new Set(['if-none-match', 'x-amz-checksum-sha256']),
    },
  )
  return { url, headers: { 'Content-Type': p.contentType, 'If-None-Match': '*', 'x-amz-checksum-sha256': checksum } }
}

let presigner: Promise<S3Client> | undefined

/** Short-lived signed GET URL, so an external service (e.g. Twelve Labs) can read one object directly from S3. */
export async function presignDownload(key: string, expiresInSeconds = 3600): Promise<string> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3')
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
  presigner ??= (async () => {
    await companyBrainStore()
    return new S3Client({ region: AWS_REGION, credentials: awsCredentials(), requestChecksumCalculation: 'WHEN_REQUIRED' })
  })()
  return getSignedUrl(await presigner, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: expiresInSeconds })
}
