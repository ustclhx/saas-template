import { describe, expect, it, vi } from 'vitest'
import {
  type RetryCategory,
  RetryGiveUpError,
  retryTransient,
  SAME_KEY_RETRY_DELAYS_MS,
  TRANSIENT_RETRY_DELAYS_MS,
} from './retry.ts'

/** 按脚本依次失败；元素为类别时抛出对应错误，'ok' 时成功。 */
function scripted(steps: readonly (RetryCategory | 'ok')[]) {
  let index = 0
  const operation = vi.fn(async () => {
    const step = steps[index++] ?? 'ok'
    if (step === 'ok') return 'done'
    throw new Error(step)
  })
  return operation
}

function run(steps: readonly (RetryCategory | 'ok')[], random = () => 0.5) {
  const operation = scripted(steps)
  const sleeps: number[] = []
  const promise = retryTransient(operation, {
    classify: (error) => ({ category: (error as Error).message as RetryCategory, code: 'X' }),
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random,
  })
  return { operation, sleeps, promise }
}

describe('retryTransient', () => {
  it('returns the first success without waiting', async () => {
    const { operation, sleeps, promise } = run(['ok'])
    await expect(promise).resolves.toBe('done')
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('retries transient errors with 100/300/900 ms backoff and ±50% jitter', async () => {
    const { operation, sleeps, promise } = run(['transient', 'transient', 'transient', 'ok'])
    await expect(promise).resolves.toBe('done')
    expect(operation).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([...TRANSIENT_RETRY_DELAYS_MS])
    const low = run(['transient', 'ok'], () => 0)
    await low.promise
    const high = run(['transient', 'ok'], () => 0.999_999)
    await high.promise
    expect(low.sleeps).toEqual([50])
    expect(high.sleeps).toEqual([150])
  })

  it('retries same-key rate limits from 1 s with 0–250 ms jitter', async () => {
    const { operation, sleeps, promise } = run(
      ['sameKeyRateLimit', 'sameKeyRateLimit', 'ok'],
      () => 0,
    )
    await expect(promise).resolves.toBe('done')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([...SAME_KEY_RETRY_DELAYS_MS])
    const high = run(['sameKeyRateLimit', 'ok'], () => 0.999_999)
    await high.promise
    expect(high.sleeps).toEqual([1250])
  })

  it('fails immediately on non-retryable errors', async () => {
    const { operation, sleeps, promise } = run(['fatal'])
    const error = await promise.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RetryGiveUpError)
    expect(error).toMatchObject({
      reason: 'non_retryable',
      category: 'fatal',
      code: 'X',
      retries: { transient: 0, sameKeyRateLimit: 0 },
    })
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(operation).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('gives up after 3 transient retries', async () => {
    const { operation, promise } = run(Array(10).fill('transient'))
    await expect(promise).rejects.toMatchObject({
      reason: 'exhausted',
      category: 'transient',
      retries: { transient: 3, sameKeyRateLimit: 0 },
    })
    expect(operation).toHaveBeenCalledTimes(4)
  })

  it('gives up after 2 same-key retries', async () => {
    const { operation, promise } = run(Array(10).fill('sameKeyRateLimit'))
    await expect(promise).rejects.toMatchObject({
      reason: 'exhausted',
      category: 'sameKeyRateLimit',
      retries: { transient: 0, sameKeyRateLimit: 2 },
    })
    expect(operation).toHaveBeenCalledTimes(3)
  })

  it('counts the two categories separately when they alternate', async () => {
    const steps: (RetryCategory | 'ok')[] = [
      'transient',
      'sameKeyRateLimit',
      'transient',
      'sameKeyRateLimit',
      'transient',
      'ok',
    ]
    const ok = run(steps)
    await expect(ok.promise).resolves.toBe('done')
    expect(ok.operation).toHaveBeenCalledTimes(6)
    expect(ok.sleeps).toEqual([100, 1125, 300, 2125, 900])

    const exhausted = run([
      'sameKeyRateLimit',
      'transient',
      'sameKeyRateLimit',
      'transient',
      'transient',
      'sameKeyRateLimit',
    ])
    await expect(exhausted.promise).rejects.toMatchObject({
      reason: 'exhausted',
      category: 'sameKeyRateLimit',
      retries: { transient: 3, sameKeyRateLimit: 2 },
    })
    expect(exhausted.operation).toHaveBeenCalledTimes(6)
  })

  it('reports each retry with its category and running counts', async () => {
    const onRetry = vi.fn()
    let calls = 0
    await retryTransient(
      async () => {
        if (calls++ === 0) throw new Error('boom')
        return 1
      },
      {
        classify: () => ({ category: 'transient', code: '10001' }),
        sleep: async () => {},
        random: () => 0.5,
        onRetry,
      },
    )
    expect(onRetry).toHaveBeenCalledWith({
      category: 'transient',
      code: '10001',
      delayMs: 100,
      transient: 1,
      sameKeyRateLimit: 0,
    })
  })
})
