import { AppError } from '@saas/shared'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
// index.ts 在加载时登记项目类型；首页与其他页面不加载本模块。
import './index.ts'
import { lookupShare, type ShareLookupDeps } from './lookup.ts'
import { buildShareCardMeta, type ShareCardMeta } from './meta.ts'

/** 从当前请求运行时取查找依赖：业务库、KV 撤销标记、限流与可信来源 IP。 */
export function shareLookupDeps(): ShareLookupDeps {
  const runtime = getWebRuntime()
  return {
    db: runtime.db,
    cache: runtime.cache,
    rateLimiter: runtime.rateLimiter,
    clientIp: runtime.requestMeta.clientIp,
  }
}

/**
 * 自建分享页使用的元数据工具（design 第 8 条）：执行与通用分享页相同的撤销、格式、限流、
 * 解析与到期检查，返回指向分享卡片的 og / twitter 元数据。无效、撤销或到期时返回 null，
 * 由调用方渲染 404；超过限流时抛出 429。
 */
export async function shareCardMeta(
  type: string,
  token: string,
  options: { pageUrl?: string } = {},
): Promise<ShareCardMeta | null> {
  const result = await lookupShare(shareLookupDeps(), { type, token, page: false })
  if (result.status === 'rate-limited')
    throw new AppError('RATE_LIMITED', 'Too many share requests', { status: 429 })
  if (result.status !== 'ok') return null
  return buildShareCardMeta({
    card: result.card,
    token: result.token,
    data: result.resolution.data,
    appUrl: getWebRuntime().config.APP_URL,
    pageUrl: options.pageUrl,
    siteName: templateConfig.app.name,
  })
}
