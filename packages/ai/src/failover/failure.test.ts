import { AppError } from '@saas/shared'
import { describe, expect, it } from 'vitest'
import { canFailover, failureKindFromStatus, failureKindOf, ProviderFailure } from './failure.ts'

describe('服务商失败分类', () => {
  it('只有服务商侧原因可以切换', () => {
    expect(canFailover('unavailable')).toBe(true)
    expect(canFailover('rate_limited')).toBe(true)
    expect(canFailover('provider_error')).toBe(true)
    expect(canFailover('auth')).toBe(true)
    expect(canFailover('rejected_input')).toBe(false)
    expect(canFailover('content_policy')).toBe(false)
    expect(canFailover('ambiguous')).toBe(false)
  })

  it('按 HTTP 状态给出默认分类', () => {
    expect(failureKindFromStatus(429)).toBe('rate_limited')
    expect(failureKindFromStatus(401)).toBe('auth')
    expect(failureKindFromStatus(403)).toBe('auth')
    expect(failureKindFromStatus(503)).toBe('provider_error')
    expect(failureKindFromStatus(422)).toBe('rejected_input')
    expect(failureKindFromStatus(undefined)).toBe('provider_error')
  })

  it('从异常推导分类', () => {
    expect(failureKindOf(new ProviderFailure('content_policy', 'X', 'x'))).toBe('content_policy')
    expect(failureKindOf(new AppError('AI_PROVIDER_NOT_CONFIGURED', 'x', { status: 503 }))).toBe(
      'unavailable',
    )
    expect(failureKindOf(new AppError('BAD', 'x', { status: 400 }))).toBe('rejected_input')
    expect(failureKindOf(new AppError('UPSTREAM', 'x', { status: 502 }))).toBe('provider_error')
    expect(failureKindOf(new TypeError('fetch failed'))).toBe('provider_error')
  })
})
