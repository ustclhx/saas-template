import { grantDailyCredits } from '@saas/credits'
import type { Database } from '@saas/db'
import type { KeyValueStore } from '@saas/platform'
import { log } from '@saas/shared/log'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDailyCredits } from './daily.server.ts'

vi.mock('@saas/credits', () => ({ grantDailyCredits: vi.fn() }))
vi.mock('@saas/shared/log', () => ({ log: { warn: vi.fn() } }))

const db = {} as Database
const user = { id: 'user', emailVerified: false }
const now = new Date('2026-11-10T08:00:00.000Z')
const granted = {
  status: 'granted' as const,
  grantId: 'grant',
  credits: 10,
  daysThisMonth: 1,
  maxDaysPerMonth: 10,
  expiresAt: '2026-11-17T08:00:00.000Z',
  day: '2026-11-10',
}

function fixture() {
  const values = new Map<string, string>()
  const cache = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    delete: vi.fn(),
  }
  const input = { db, cache: cache as KeyValueStore, user, session: {}, enabled: true, now }
  return { cache, input }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(grantDailyCredits).mockResolvedValue(granted)
})

describe('daily App checks', () => {
  it('skips all daily database and cache work when disabled or impersonating', async () => {
    const { cache, input } = fixture()
    expect(await checkDailyCredits({ ...input, enabled: false })).toEqual({ status: 'disabled' })
    expect(await checkDailyCredits({ ...input, session: { impersonatedBy: 'admin' } })).toEqual({
      status: 'disabled',
    })
    expect(cache.get).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
    expect(grantDailyCredits).not.toHaveBeenCalled()
  })

  it('caches a successful check for five minutes without replaying the grant notice', async () => {
    const { cache, input } = fixture()
    expect(await checkDailyCredits(input)).toEqual(granted)
    expect(await checkDailyCredits(input)).toEqual({ status: 'cached' })
    expect(grantDailyCredits).toHaveBeenCalledTimes(1)
    expect(cache.put).toHaveBeenCalledWith('daily-credits:user:2026-11-10:false', 'checked', {
      expirationTtl: 300,
    })
  })

  it('retains the verification entry on cache hits and retries immediately after verification', async () => {
    const { input } = fixture()
    vi.mocked(grantDailyCredits).mockResolvedValueOnce({ status: 'unverified' })
    expect(await checkDailyCredits(input)).toEqual({ status: 'unverified' })
    expect(await checkDailyCredits(input)).toEqual({ status: 'unverified' })
    expect(grantDailyCredits).toHaveBeenCalledTimes(1)
    expect(await checkDailyCredits({ ...input, user: { ...user, emailVerified: true } })).toEqual(
      granted,
    )
    expect(grantDailyCredits).toHaveBeenCalledTimes(2)
  })

  it('isolates cache entries by user and UTC day', async () => {
    const { input } = fixture()
    await checkDailyCredits(input)
    await checkDailyCredits({ ...input, user: { ...user, id: 'other' } })
    await checkDailyCredits({ ...input, now: new Date('2026-11-11T00:00:00Z') })
    expect(grantDailyCredits).toHaveBeenCalledTimes(3)
  })

  it('continues through the database when KV is unavailable', async () => {
    const { cache, input } = fixture()
    cache.get.mockRejectedValueOnce(new Error('KV unavailable'))
    cache.put.mockRejectedValueOnce(new Error('KV unavailable'))
    expect(await checkDailyCredits(input)).toEqual(granted)
    expect(log.warn).toHaveBeenCalledWith('credits.daily.cache_read_failed', { userId: user.id })
    expect(log.warn).toHaveBeenCalledWith('credits.daily.cache_write_failed', { userId: user.id })
  })

  it('isolates database failures from App loading and leaves the next visit able to retry', async () => {
    const { cache, input } = fixture()
    vi.mocked(grantDailyCredits).mockRejectedValueOnce(new Error('DB unavailable'))
    expect(await checkDailyCredits(input)).toBeNull()
    expect(cache.put).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith('credits.daily.check_failed', { userId: user.id })
    expect(await checkDailyCredits(input)).toEqual(granted)
  })
})
