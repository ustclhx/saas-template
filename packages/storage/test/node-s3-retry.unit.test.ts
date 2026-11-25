import { afterEach, expect, it, vi } from 'vitest'
import { createS3Client } from '../src/node/client.ts'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('pins the S3 SDK to standard retries with 3 total attempts regardless of host env', async () => {
  vi.stubEnv('AWS_MAX_ATTEMPTS', '10')
  vi.stubEnv('AWS_RETRY_MODE', 'adaptive')
  const client = createS3Client({
    endpoint: 'http://127.0.0.1:9',
    region: 'auto',
    bucket: 'files',
    accessKeyId: 'test',
    secretAccessKey: 'test',
  })
  try {
    expect(await client.config.maxAttempts()).toBe(3)
    // StandardRetryStrategy 带 mode 字段；类型上是 RetryStrategy | RetryStrategyV2 联合。
    expect(await client.config.retryStrategy()).toMatchObject({ mode: 'standard' })
  } finally {
    client.destroy()
  }
})
