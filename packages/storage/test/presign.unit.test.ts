import { describe, expect, it } from 'vitest'
import { presignDownload, presignUpload, type StorageEnv } from '../src/index.ts'

const env = {
  FILES: {} as R2Bucket,
  R2_ACCOUNT_ID: '00000000000000000000000000000000',
  R2_FILES_BUCKET: 'files-staging',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
} satisfies StorageEnv
const key = 'ws/019a03ac-9283-73a8-bca7-4dfbf04e6680/image.png'

describe('FILES presigned URLs', () => {
  it('signs Content-Type and the write-once condition for a ten-minute PUT', async () => {
    const result = await presignUpload(env, key, 'image/png')
    const url = new URL(result.uploadUrl)
    expect(url.host).toBe(`${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`)
    expect(url.pathname).toBe(`/files-staging/${key}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host;if-none-match')
    expect(result.headers).toEqual({ 'Content-Type': 'image/png', 'If-None-Match': '*' })
    const different = new URL((await presignUpload(env, key, 'image/jpeg')).uploadUrl)
    expect(different.searchParams.get('X-Amz-Signature')).not.toBe(
      url.searchParams.get('X-Amz-Signature'),
    )
  })

  it('signs a five-minute GET without allowing other buckets or traversal', async () => {
    const url = new URL(await presignDownload(env, key))
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    await expect(
      presignDownload({ ...env, R2_FILES_BUCKET: 'backups' }, key),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
    await expect(presignDownload(env, `${key}/../../backups`)).rejects.toMatchObject({
      code: 'INVALID_FILE_KEY',
    })
  })
})
