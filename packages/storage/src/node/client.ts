import { S3Client } from '@aws-sdk/client-s3'
import { AppError } from '@saas/shared'

/** 由 composition 校验部署环境后显式传入；不读取环境或 metadata 凭据。 */
export interface S3StorageConfig {
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly forcePathStyle?: boolean
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export function createS3Client(config: S3StorageConfig) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? true,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // 存储临时错误只由 SDK 重试一层（不叠加 retryTransient，避免 3×3 放大）。显式固定为官方默认的
    // standard 模式与 3 次总尝试（含首次），不受主机 AWS_MAX_ATTEMPTS / AWS_RETRY_MODE 影响。
    // 出处：https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html （2026-11-25）；
    // 已安装 @smithy/core 3.35 的 DEFAULT_MAX_ATTEMPTS=3、DEFAULT_RETRY_MODE=standard 与之一致。
    maxAttempts: 3,
    retryMode: 'standard',
    // 避免 SDK 自动附加浏览器未知的 checksum 头及兼容端点不支持的 trailer。
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}

export function validateKey(key: string) {
  // 与既有 CF 签名入口一致，普通上传和确定性媒体 key 都保留租户前缀。
  if (
    !/^ws\/[0-9a-f-]{36}\/.+/.test(key) ||
    key.split('/').some((part) => part === '..' || part === '.')
  )
    throw new AppError('INVALID_FILE_KEY', 'Invalid file key')
}

export function storageError(code: string) {
  // SDK 错误可含签名 URL、凭据和请求正文，禁止携带原文或 cause。
  return new AppError(code, 'Object storage operation failed', { status: 502 })
}

export function isMissing(error: unknown) {
  if (typeof error !== 'object' || error === null) return false
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } }
  return value.$metadata?.httpStatusCode === 404 || value.name === 'NoSuchKey'
}
