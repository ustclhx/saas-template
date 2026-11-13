import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { createShareCardImageStore } from '@saas/storage'
import { getWebRuntime } from '../../server/runtime.ts'
import { isShareRevoked, precheckShare, remainingSeconds, resolveShare } from './lookup.ts'
// meta.server.ts 引入 index.ts，加载时登记项目类型。
import { shareLookupDeps } from './meta.server.ts'
import { shareCardImagePath } from './meta.ts'
import { renderShareCard } from './render.server.ts'
import { SHARE_CARD_BUSY } from './renderer.ts'

/** 浏览器缓存上限 1 天，边缘缓存上限 1 年；两者都不超过剩余有效期（design 第 3 条）。 */
export const SHARE_CARD_BROWSER_MAX_AGE = 86_400
export const SHARE_CARD_EDGE_MAX_AGE = 31_536_000
/** 卡片地址 `v` 参数的长度上限；超出时不读缓存与存储，由解析结果决定 302 或 404。 */
const MAX_VARIANT_LENGTH = 64
/** 渲染并发超限时建议的重试间隔（秒）。 */
const BUSY_RETRY_AFTER = 5

export function shareCardImageHeaders(expiresAt: Date | null, now = new Date()) {
  const remaining = remainingSeconds(expiresAt, now)
  const browser = Math.min(SHARE_CARD_BROWSER_MAX_AGE, remaining)
  const edge = Math.min(SHARE_CARD_EDGE_MAX_AGE, remaining)
  return {
    'content-type': 'image/png',
    'cache-control': `public, max-age=${browser}, s-maxage=${edge}${expiresAt === null ? ', immutable' : ''}`,
    'x-robots-tag': 'noindex',
    'x-content-type-options': 'nosniff',
  }
}

/** 404 / 429 / 503 / 500 不进入公共缓存，正文不含资源信息或错误详情。 */
function failure(status: 404 | 429 | 500 | 503, headers: Record<string, string> = {}) {
  const text = { 404: 'Not Found', 429: 'Too Many Requests', 500: 'Error', 503: 'Busy' }[status]
  return new Response(`${text}\n`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  })
}

function png(body: Uint8Array, expiresAt: Date | null, now: Date) {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: shareCardImageHeaders(expiresAt, now),
  })
}

/**
 * `GET /share-card/<type>/<token>.png?v=<version>-<digest8>`（design 第 3、9 条）：
 * 令牌格式（含长度上限）→ KV 撤销标记 → Cache API（自托管跳过）→ 对象存储图片（元数据到期则删除并 404）
 * → 限流 → resolve → 到期 → 摘要比对（不一致 302 到当前地址）→ 渲染 → 再查撤销标记 → 写对象存储
 * 图片与空间索引、Cache API。缓存命中时不调用项目解析，不查库。
 */
export async function handleShareCardImageRequest(
  request: Request,
  params: { type?: string | undefined; file?: string | undefined },
): Promise<Response> {
  const type = params.type ?? ''
  const file = params.file ?? ''
  if (!file.endsWith('.png')) return failure(404)
  const token = file.slice(0, -'.png'.length)
  const runtime = getWebRuntime()
  const deps = shareLookupDeps()
  const checked = await precheckShare(deps, { type, token, page: false })
  if (checked.status !== 'ok') return failure(404)

  const url = new URL(request.url)
  const variant = url.searchParams.get('v') ?? ''
  // 缓存键只保留 v，其余查询参数不能制造新的缓存条目。
  const cacheKey = `${url.origin}${url.pathname}?v=${encodeURIComponent(variant)}`
  const edge = runtime.shareCardCache?.available ? runtime.shareCardCache.value : undefined
  const objects = runtime.files?.available ? runtime.files.value.shareCards : undefined
  const images = objects ? createShareCardImageStore(objects) : undefined
  const cacheable = variant !== '' && variant.length <= MAX_VARIANT_LENGTH

  if (cacheable) {
    const cached = await edge?.match(cacheKey)
    if (cached) return cached
    if (images) {
      const now = new Date()
      const stored = await images.read({ type, token, variant }, now)
      if (stored.status === 'expired') return failure(404)
      if (stored.status === 'hit' && remainingSeconds(stored.expiresAt, now) >= 1) {
        const response = png(stored.body, stored.expiresAt, now)
        await edge?.put(cacheKey, response.clone())
        return response
      }
    }
  }

  const result = await resolveShare(deps, checked)
  if (result.status === 'rate-limited') return failure(429, { 'retry-after': '60' })
  if (result.status !== 'ok') return failure(404)
  const { card, resolution, expiresAt } = result
  const expected = `${card.version}-${card.digest(resolution.data).slice(0, 8)}`
  if (variant !== expected)
    return new Response(null, {
      status: 302,
      headers: {
        location: shareCardImagePath(card, token, resolution.data),
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    })

  let body: Uint8Array
  try {
    body = await renderShareCard(card, resolution.data)
  } catch (error) {
    if (error instanceof AppError && error.code === SHARE_CARD_BUSY)
      return failure(503, { 'retry-after': String(BUSY_RETRY_AFTER) })
    log.error('share-cards.render-failed', { type, error })
    return failure(500)
  }

  // 渲染期间项目可能已撤销并完成失效：写入前再查一次标记，避免留下孤儿卡片与索引。
  if (await isShareRevoked(deps, type, token)) return failure(404)
  const now = new Date()
  if (remainingSeconds(expiresAt, now) < 1) return failure(404)
  if (images) {
    const ref = { type, token, variant, workspaceId: resolution.workspaceId }
    try {
      await images.write(ref, body, expiresAt)
    } catch (error) {
      // 持久存储失败不影响本次返回；下次未命中时重新渲染。
      log.warn('share-cards.store-failed', { type, error })
    }
    // 写入与失效并发时（失效先列出前缀、本次后写入），撤回本次写入。
    if (await isShareRevoked(deps, type, token)) {
      await images.discard(ref).catch((error: unknown) => {
        // 撤回失败时空间索引仍在，删空间清理可以重试。
        log.warn('share-cards.discard-failed', { type, error })
      })
      return failure(404)
    }
  }
  const response = png(body, expiresAt, now)
  await edge?.put(cacheKey, response.clone())
  return response
}
