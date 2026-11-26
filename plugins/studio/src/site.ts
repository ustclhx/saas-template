export const DEFAULT_STUDIO_SITE = 'default'

export type StudioSiteOrigins = Readonly<Record<string, string>>

export function resolveStudioSite(
  requestOrigin: string,
  appUrl: string,
  sites?: StudioSiteOrigins,
): { key: string; origin: string } | null {
  const match = Object.entries(sites ?? {}).find(([, origin]) => requestOrigin === origin)
  if (match) return { key: match[0], origin: match[1] }
  const origin = studioSiteOrigin(DEFAULT_STUDIO_SITE, appUrl, sites)
  return origin && (!sites || requestOrigin === origin)
    ? { key: DEFAULT_STUDIO_SITE, origin }
    : null
}

export function studioSiteOrigin(
  key: string,
  appUrl: string,
  sites?: StudioSiteOrigins,
): string | undefined {
  if (sites && Object.hasOwn(sites, key)) return sites[key]
  if (key !== DEFAULT_STUDIO_SITE) return undefined
  const origin = new URL(appUrl).origin
  // 显式将 APP_URL 分配给其他站点时，默认站点不能共用该缓存地址。
  return Object.values(sites ?? {}).includes(origin) ? undefined : origin
}
