/** 浏览器可见的 Plausible 配置：按环境取值，staging 与生产使用各自的 site（docs/analytics.md）。 */
export interface PlausibleSite {
  /** Plausible 的 site_id（data-domain） */
  readonly domain: string
  readonly origin: string
  readonly scriptUrl: string
  readonly eventUrl: string
}

/** manual 版脚本：页面事件由 trackEvent 发送，才能脱敏 URL 并携带统一属性。 */
const SCRIPT_PATH = '/js/script.manual.js'

/** 模板关闭、未配置或地址非法时返回 null，调用方不注入脚本也不发送事件。 */
export function plausibleSite(
  analytics: 'plausible' | 'posthog' | false,
  env: { PLAUSIBLE_DOMAIN?: string | undefined; PLAUSIBLE_HOST?: string | undefined },
): PlausibleSite | null {
  const domain = env.PLAUSIBLE_DOMAIN?.trim()
  const host = env.PLAUSIBLE_HOST?.trim()
  if (analytics !== 'plausible' || !domain || !host || !URL.canParse(host)) return null
  const { origin, protocol } = new URL(host)
  if (protocol !== 'https:' && protocol !== 'http:') return null
  return { domain, origin, scriptUrl: `${origin}${SCRIPT_PATH}`, eventUrl: `${origin}/api/event` }
}
