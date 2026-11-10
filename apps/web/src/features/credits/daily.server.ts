import { type DailyCreditsResult, grantDailyCredits } from '@saas/credits'
import type { Database } from '@saas/db'
import type { KeyValueStore } from '@saas/platform'
import { log } from '@saas/shared/log'

export type DailyCreditsCheck = DailyCreditsResult | { status: 'cached' }

/** KV 只避免近期重复检查，领取资格与额度始终由积分事务决定。 */
export async function checkDailyCredits({
  db,
  cache,
  user,
  session,
  enabled,
  now = new Date(),
}: {
  db: Database
  cache: KeyValueStore
  user: { id: string; emailVerified: boolean }
  session: { impersonatedBy?: string | null }
  enabled: boolean
  now?: Date
}): Promise<DailyCreditsCheck | null> {
  if (!enabled || session.impersonatedBy) return { status: 'disabled' }
  const key = `daily-credits:${user.id}:${now.toISOString().slice(0, 10)}:${user.emailVerified}`
  try {
    const cached = await cache.get(key)
    if (cached === 'unverified') return { status: 'unverified' }
    if (cached === 'checked') return { status: 'cached' }
  } catch {
    log.warn('credits.daily.cache_read_failed', { userId: user.id })
  }

  let result: DailyCreditsResult
  try {
    result = await grantDailyCredits({ db, userId: user.id, enabled: true, now })
  } catch {
    // 赠送失败不能阻断 App，也不缓存失败，以便下一次真实访问重试。
    log.warn('credits.daily.check_failed', { userId: user.id })
    return null
  }
  try {
    await cache.put(key, result.status === 'unverified' ? 'unverified' : 'checked', {
      expirationTtl: 300,
    })
  } catch {
    log.warn('credits.daily.cache_write_failed', { userId: user.id })
  }
  return result
}
