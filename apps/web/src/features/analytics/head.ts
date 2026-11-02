import type { TemplateConfig } from '@saas/config'
import { isAppAreaPath } from '../i18n/app-area.ts'

const NOT_TRACKED = /^\/(?:admin|api)(?:\/|$)/

/**
 * 无 Cookie 的流量统计只放在公开页面；未配置公开 token 时不输出脚本。
 * Plausible 负责产品漏斗，应用区也要加载，但不进入后台与接口路径。
 */
export function analyticsHeadScripts(
  pathname: string,
  config: TemplateConfig,
  plausible?: { domain: string; scriptUrl: string } | null,
) {
  return [
    ...(plausible && !NOT_TRACKED.test(pathname)
      ? [{ src: plausible.scriptUrl, defer: true, 'data-domain': plausible.domain }]
      : []),
    ...(isAppAreaPath(pathname) || !config.analytics.cloudflareToken.trim()
      ? []
      : [
          {
            src: 'https://static.cloudflareinsights.com/beacon.min.js',
            defer: true,
            // 自动 SPA 监听会跨到后台路径；这里只统计公开页面的文档加载。
            'data-cf-beacon': JSON.stringify({
              token: config.analytics.cloudflareToken,
              spa: false,
            }),
          },
        ]),
  ]
}
