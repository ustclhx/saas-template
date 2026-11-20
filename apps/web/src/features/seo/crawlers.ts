import { templateConfig } from '../../server/template-config.ts'
import { localePrefix } from '../i18n/locale-url.ts'
import type { SeoPage } from './metadata.ts'
import {
  absoluteUrl,
  alternateLinks,
  indexedPages,
  localizedPath,
  pageAlternates,
} from './metadata.ts'

export function escapeXml(text: string): string {
  return text.replace(
    /[<>&"']/g,
    (char) =>
      ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char] ?? char,
  )
}

/** 分享页与分享卡片只供社交平台抓取（noindex），不进站点地图与 llms.txt。 */
export function isSharePath(path: string): boolean {
  return /^\/(?:s|share-card)(?:\/|$)/.test(path)
}

/** 站点地图与 llms.txt 只列可索引的真实页面：排除分享页、`indexable: false` 与缺少译文的回退页 */
const indexable = (pages: readonly SeoPage[]) =>
  indexedPages(pages).filter((page) => !isSharePath(page.path))

export function sitemap(pages: readonly SeoPage[], appUrl: string): string {
  const listed = indexable(pages)
  const urls = listed
    .map((page) => {
      // hreflang 只关联真实存在译文的语言；声明了 alternates 的页面用声明的各语言地址
      const languages = listed
        .filter((other) => other.path === page.path)
        .map((other) => other.locale)
      const links = alternateLinks(appUrl, page.path, languages, pageAlternates(page), page.locale)
        .map(
          (link) =>
            `<xhtml:link rel="alternate" hreflang="${escapeXml(link.hrefLang)}" href="${escapeXml(link.href)}"/>`,
        )
        .join('')
      return `<url><loc>${escapeXml(absoluteUrl(appUrl, localizedPath(page.path, page.locale)))}</loc>${links}</url>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls}</urlset>`
}

/** 给 AI 助手读的站点索引（llmstxt.org 约定）；只用默认语言，避免同一内容重复列出。 */
export function llmsTxt(pages: readonly SeoPage[], appUrl: string): string {
  const { defaultLocale } = templateConfig.i18n
  const links = indexable(pages)
    .filter((page) => page.locale === defaultLocale)
    .map(
      (page) =>
        `- [${page.title}](${absoluteUrl(appUrl, localizedPath(page.path, page.locale))}): ${page.description}`,
    )
  return [`# ${templateConfig.app.name}`, '', '## Pages', '', ...links, ''].join('\n')
}

export function robots(appUrl: string): string {
  const prefixes = [
    '',
    ...(templateConfig.i18n.enabled
      ? templateConfig.i18n.locales.map((locale) => `/${localePrefix(locale)}`)
      : []),
  ]
  return [
    'User-agent: *',
    ...prefixes.flatMap((prefix) =>
      ['/app', '/account', '/admin', '/api'].map((path) => `Disallow: ${prefix}${path}`),
    ),
    // 社交平台抓取器需要读取分享页与卡片图片；是否收录由响应的 noindex 决定。
    'Allow: /share-card/',
    ...prefixes.map((prefix) => `Allow: ${prefix}/s/`),
    `Sitemap: ${absoluteUrl(appUrl, '/sitemap.xml')}`,
    '',
  ].join('\n')
}
