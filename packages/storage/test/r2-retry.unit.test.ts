import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareObjectDeleter, createCloudflareStorage } from '../src/cloudflare/index.ts'
import { createCloudflareMediaCopier } from '../src/cloudflare/media.ts'
import { classifyR2Error, withR2Retry } from '../src/cloudflare/retry.ts'
import { createCloudflareShareCardObjects } from '../src/cloudflare/share-cards.ts'

/** 与 workerd 绑定一致：普通 Error，错误码在 message 末尾。 */
const r2Error = (code: number, text = 'R2 failure') => new Error(`put: ${text} (${code})`)

describe('classifyR2Error', () => {
  it.each([
    [10001, 'transient'],
    [10043, 'transient'],
    [10054, 'transient'],
    [10058, 'sameKeyRateLimit'],
    [10007, 'fatal'], // NoSuchKey
    [10031, 'fatal'], // PreconditionFailed
    [100100, 'fatal'], // EntityTooLarge
    [10012, 'fatal'], // 元数据过大
    [10002, 'fatal'], // Unauthorized
    [10006, 'fatal'], // NoSuchBucket
  ])('classifies code %i in the message as %s', (code, category) => {
    expect(classifyR2Error(r2Error(code))).toEqual({ category, code: String(code) })
  })

  it('recognizes numeric and named code properties', () => {
    expect(classifyR2Error(Object.assign(new Error('x'), { code: 10043 }))).toEqual({
      category: 'transient',
      code: '10043',
    })
    expect(classifyR2Error(Object.assign(new Error('x'), { code: 'TooManyRequests' }))).toEqual({
      category: 'sameKeyRateLimit',
      code: 'TooManyRequests',
    })
    const named = new Error('x')
    named.name = 'ServiceUnavailable'
    expect(classifyR2Error(named)).toEqual({ category: 'transient', code: 'ServiceUnavailable' })
  })

  it('retries Workers network loss and opaque internal errors only', () => {
    expect(classifyR2Error(new Error('Network connection lost.'))).toEqual({
      category: 'transient',
      code: 'network',
    })
    expect(classifyR2Error(new Error('internal error; reference = abc'))).toMatchObject({
      category: 'transient',
    })
    expect(classifyR2Error(new TypeError('Invalid key'))).toEqual({ category: 'fatal' })
    expect(classifyR2Error('boom')).toEqual({ category: 'fatal' })
    // 码不在末尾时不当作错误码。
    expect(classifyR2Error(new Error('put: (10001) moved'))).toEqual({ category: 'fatal' })
  })
})

describe('R2 adapters retry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function failing(errors: unknown[]) {
    return vi.fn(async () => {
      const error = errors.shift()
      if (error) throw error
    })
  }

  it('retries an internal error once and succeeds', async () => {
    const put = failing([r2Error(10001)])
    const objects = createCloudflareShareCardObjects({ put } as unknown as R2Bucket)
    const pending = objects.put('share-cards/img/a', new Uint8Array([1]))
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBeUndefined()
    expect(put).toHaveBeenCalledTimes(2)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })

  it('waits about one second before retrying a same-key rate limit', async () => {
    const del = failing([r2Error(10058)])
    const storage = createCloudflareStorage({ FILES: { delete: del } } as never)
    const pending = storage.delete('ws/key')
    await vi.advanceTimersByTimeAsync(999)
    expect(del).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(251)
    await expect(pending).resolves.toBeUndefined()
    expect(del).toHaveBeenCalledTimes(2)
  })

  it('stops after two same-key retries with STORAGE_UNAVAILABLE and no transient budget used', async () => {
    const put = failing(Array.from({ length: 10 }, () => r2Error(10058)))
    const objects = createCloudflareShareCardObjects({ put } as unknown as R2Bucket)
    const pending = objects.put('k', new Uint8Array()).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 })
    expect(put).toHaveBeenCalledTimes(3)
    const logged = String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])
    expect(logged).toContain('storage.r2.same_key_rate_limited')
    expect(logged).toContain('"transientRetries":0')
    expect(logged).not.toContain('"k"')
  })

  it('retries the jobs-only object deleter like Storage.delete', async () => {
    const del = failing([new Error('Network connection lost.')])
    const pending = createCloudflareObjectDeleter({ delete: del } as never).delete('ws/k')
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toBeUndefined()
    expect(del).toHaveBeenCalledTimes(2)
  })

  it('stops after three transient retries', async () => {
    const run = failing(Array.from({ length: 10 }, () => r2Error(10043)))
    const pending = withR2Retry('delete', run).catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await pending).toMatchObject({ code: 'STORAGE_UNAVAILABLE', status: 503 })
    expect(run).toHaveBeenCalledTimes(4)
  })

  it('does not retry non-retryable errors', async () => {
    for (const code of [100100, 10002]) {
      const put = failing([r2Error(code)])
      const objects = createCloudflareShareCardObjects({ put } as unknown as R2Bucket)
      await expect(objects.put('k', new Uint8Array())).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
      })
      expect(put).toHaveBeenCalledTimes(1)
    }
  })

  const limits = {
    allowedMimeTypes: ['image/png'],
    allowedHosts: ['media.example.com'],
    maxFileBytes: 1024,
    storageBytes: 1024 * 1024,
  }

  it('retries in-memory media bytes', async () => {
    const put = failing([r2Error(10001)])
    const copy = createCloudflareMediaCopier({ put } as never)
    const pending = copy('ws/k', { body: new Uint8Array([1, 2]), mime: 'image/png' }, limits)
    await vi.runAllTimersAsync()
    await expect(pending).resolves.toEqual({ mime: 'image/png', size: 2 })
    expect(put).toHaveBeenCalledTimes(2)
  })

  it('leaves streamed media writes to the outer workflow retry', async () => {
    // 流管道依赖真实的宏任务调度。
    vi.useRealTimers()
    const error = r2Error(10043)
    const put = vi.fn(async (_key: string, body: ReadableStream) => {
      await new Response(body).arrayBuffer()
      throw error
    })
    const copy = createCloudflareMediaCopier({ put } as never, {
      fetch: async () =>
        new Response(new Uint8Array([1, 2]), {
          headers: { 'Content-Type': 'image/png', 'Content-Length': '2' },
        }),
      fixedLengthStream: () => new TransformStream(),
    })
    await expect(
      copy('ws/k', { url: 'https://media.example.com/a.png', mime: 'image/png' }, limits),
    ).rejects.toBe(error)
    expect(put).toHaveBeenCalledTimes(1)
  })
})
