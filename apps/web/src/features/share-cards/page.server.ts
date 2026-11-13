import { setResponseHeader, setResponseStatus } from '@tanstack/react-start/server'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { absoluteUrl } from '../seo/metadata.ts'
import { lookupShare } from './lookup.ts'
import { shareLookupDeps } from './meta.server.ts'
import { buildShareCardMeta } from './meta.ts'
import { type SharePageView, sharePageView } from './page.ts'

/**
 * 每次访问都会调用项目的 resolve（会查库），访问来自真实访客与平台抓取器；边缘缓存 5 分钟，
 * 撤销最迟 5 分钟后生效，失效函数写入的 KV 标记先于 resolve 检查。所有结果都带 noindex。
 */
export async function loadSharePage(input: {
  type: string
  token: string
}): Promise<SharePageView> {
  setResponseHeader('x-robots-tag', 'noindex')
  const result = await lookupShare(shareLookupDeps(), { ...input, page: true })
  if (result.status === 'rate-limited') {
    setResponseStatus(429)
    setResponseHeader('cache-control', 'no-store')
    setResponseHeader('retry-after', '60')
    return { status: 'rate-limited' }
  }
  setResponseHeader('cache-control', 'public, s-maxage=300')
  if (result.status !== 'ok') return { status: result.status }
  const appUrl = getWebRuntime().config.APP_URL
  const path = `/s/${encodeURIComponent(input.type)}/${encodeURIComponent(input.token)}`
  return sharePageView(
    result,
    buildShareCardMeta({
      card: result.card,
      token: result.token,
      data: result.resolution.data,
      appUrl,
      pageUrl: absoluteUrl(appUrl, path),
      siteName: templateConfig.app.name,
    }),
  )
}
