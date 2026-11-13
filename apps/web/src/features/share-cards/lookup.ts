import type { Database } from '@saas/db'
import type { KeyValueStore, RateLimiter } from '@saas/platform'
import { shareCardRevokedKey } from '@saas/storage'
import { isShareCardExpired, shareCardExpiresAt } from './expiry.ts'
import { getShareCard } from './registry.ts'
import type { RegisteredShareCard, ShareResolution } from './types.ts'

export interface ShareLookupDeps {
  readonly db: Database
  readonly cache: Pick<KeyValueStore, 'get'>
  readonly rateLimiter: RateLimiter
  /** 目标入口给出的可信来源 IP；缺失时共用一个限流桶。 */
  readonly clientIp: string | null
  readonly now?: Date
}

export type ShareLookup =
  | {
      readonly status: 'ok'
      readonly card: RegisteredShareCard<unknown>
      readonly token: string
      readonly resolution: ShareResolution<unknown>
      readonly expiresAt: Date | null
    }
  | { readonly status: 'not-found' | 'expired' | 'rate-limited' }

/**
 * 分享页与元数据共用的查找顺序（design 第 8、9 条）：注册表（内存）→ KV 撤销标记 → 令牌格式
 * → 限流 → resolve → 到期。撤销与格式不符都不调用 resolve，也不消耗限流配额。
 * `page` 为 true 时同时遵守类型的 `sharePage: false`；项目自建页面取元数据时不受该开关影响。
 */
export async function lookupShare(
  deps: ShareLookupDeps,
  input: { type: string; token: string; page: boolean },
): Promise<ShareLookup> {
  const card = getShareCard(input.type)
  if (!card || (input.page && !card.sharePage)) return { status: 'not-found' }
  let revokedKey: string
  try {
    revokedKey = shareCardRevokedKey(input.type, input.token)
  } catch {
    // 含路径分隔或控制字符的令牌不可能是有效分享，与格式不符同样处理。
    return { status: 'not-found' }
  }
  if ((await deps.cache.get(revokedKey)) !== null) return { status: 'not-found' }
  // 项目自定义的正则可能带 g / y 标志，复位后再匹配，避免 lastIndex 残留导致结果交替。
  card.tokenPattern.lastIndex = 0
  if (!card.tokenPattern.test(input.token)) return { status: 'not-found' }
  const limited = await deps.rateLimiter.limit(
    'shareCard',
    `share:ip:${deps.clientIp ?? 'unknown'}`,
  )
  if (!limited.success) return { status: 'rate-limited' }
  const resolution = await card.resolve(input.token, { db: deps.db })
  if (!resolution) return { status: 'not-found' }
  const expiresAt = shareCardExpiresAt(resolution, card.ttlDays)
  if (isShareCardExpired(expiresAt, deps.now)) return { status: 'expired' }
  return { status: 'ok', card, token: input.token, resolution, expiresAt }
}
