// 分享卡片的站点解析：一次部署服务多个品牌域名时，按请求 host（构建期为页面 locale / pathname）
// 决定卡片的主题、品牌行、域名与默认分享图副标题。项目在自有文件 share-cards.theme.ts 中可选导出
// resolveProjectShareCardSite；未导出或返回 undefined 时与单站点行为完全相同。
import { templateConfig } from '../../server/template-config.ts'
import { fnv1a } from './hash.ts'
// 命名空间导入：项目文件由项目维护，旧项目没有该导出，不能用具名导入。
import * as projectThemeModule from './share-cards.theme.ts'
import { resolveShareCardTheme, type ShareCardThemeMode } from './theme.ts'
import type { ShareCardTheme } from './types.ts'

/** 与 html-attributes 的上下文对应；运行时卡片只有 host，构建期默认分享图另有 locale 与 pathname。 */
export interface ShareCardSiteContext {
  /** 请求 URL 的 host（含非默认端口），不是转发头。 */
  readonly host?: string | undefined
  readonly locale?: string | undefined
  /** 不含语言前缀的页面路径。 */
  readonly pathname?: string | undefined
}

export interface ShareCardBrand {
  readonly name: string
  /** 品牌方块中的字，默认取 name 的首字大写。 */
  readonly initial?: string | undefined
}

/** 项目解析函数的返回值；省略的字段沿用单站点默认值。 */
export interface ProjectShareCardSite {
  readonly theme?: Partial<ShareCardTheme> | undefined
  readonly brand?: ShareCardBrand | undefined
  /** 卡片右下角显示的域名。 */
  readonly host?: string | undefined
  /** 构建期默认分享图的副标题（品牌名之后），默认取首页 SEO 标题。 */
  readonly tagline?: string | undefined
}

export type ProjectShareCardSiteResolver = (
  context: ShareCardSiteContext,
) => ProjectShareCardSite | undefined

export interface ShareCardSite {
  readonly brand: ShareCardBrand
  readonly host: string
  readonly locale?: string | undefined
  readonly tagline?: string | undefined
  /** 项目站点覆盖的指纹，进入卡片地址；没有覆盖时为空串，地址与单站点相同。 */
  readonly fingerprint: string
}

function appHost(): string {
  try {
    return new URL(templateConfig.app.url).host
  } catch {
    return templateConfig.app.url
  }
}

/** 单站点默认值：模板配置的应用名与 app.url 的域名。 */
export function defaultShareCardSite(locale?: string): ShareCardSite {
  return { brand: { name: templateConfig.app.name }, host: appHost(), locale, fingerprint: '' }
}

function projectResolver(): ProjectShareCardSiteResolver | undefined {
  // 遍历导出而不是直接取属性：项目未导出时打包器不会对缺失的具名导出告警。
  const value = Object.entries(projectThemeModule).find(
    ([name]) => name === 'resolveProjectShareCardSite',
  )?.[1]
  return typeof value === 'function' ? (value as ProjectShareCardSiteResolver) : undefined
}

/**
 * 按请求解析站点（卡片路由、分享页与 shareCardMeta 共用）。有站点覆盖时，分享页与卡片的绝对地址
 * 使用当前请求的域名（协议沿用 APP_URL），卡片请求才会落到同一站点；没有覆盖时仍用 APP_URL。
 */
export function resolveRequestShareCardSite(
  requestUrl: string,
  appUrl: string,
  mode: ShareCardThemeMode = 'light',
  resolver: ProjectShareCardSiteResolver | undefined = projectResolver(),
): { site: ShareCardSite; theme: ShareCardTheme; origin: string } {
  const { host } = new URL(requestUrl)
  const resolved = resolveShareCardSite({ host }, mode, resolver)
  const origin = resolved.site.fingerprint ? `${new URL(appUrl).protocol}//${host}` : appUrl
  return { ...resolved, origin }
}

/** 模板基线叠加项目品牌覆盖与站点覆盖。 */
export function resolveShareCardSite(
  context: ShareCardSiteContext = {},
  mode: ShareCardThemeMode = 'light',
  resolver: ProjectShareCardSiteResolver | undefined = projectResolver(),
): { site: ShareCardSite; theme: ShareCardTheme } {
  const base = resolveShareCardTheme(mode)
  const fallback = defaultShareCardSite(context.locale)
  const override = resolver?.(context)
  if (!override) return { site: fallback, theme: base }
  const site: ShareCardSite = {
    brand: override.brand ?? fallback.brand,
    host: override.host ?? fallback.host,
    locale: context.locale,
    tagline: override.tagline,
    // 只对覆盖内容取指纹：同一站点得到同一地址，不同站点的卡片缓存互不混用。
    fingerprint: fnv1a(
      JSON.stringify([
        override.theme ?? null,
        override.brand ?? null,
        override.host ?? null,
        override.tagline ?? null,
      ]),
    ),
  }
  return { site, theme: { ...base, ...override.theme } }
}
