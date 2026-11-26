import { getWebRuntime } from '@web/server/runtime.ts'
import { templateConfig } from '@web/server/template-config.ts'
import { resolveStudioSite, type StudioSiteOrigins, studioSiteOrigin } from '../../site.ts'

const studio = templateConfig.plugins.studio as { sites?: StudioSiteOrigins } | undefined

/** 请求所在的作品站点（与公开媒体路由同一规则，`plugins.studio.sites`）；不属于任何站点时为 null */
export function studioPublicSite(url: string | URL) {
  return resolveStudioSite(new URL(url).origin, getWebRuntime().config.APP_URL, studio?.sites)
}

/** 站点的公开地址（站点地图与缓存键使用） */
export function studioPublicOrigin(site: string) {
  return studioSiteOrigin(site, getWebRuntime().config.APP_URL, studio?.sites)
}
