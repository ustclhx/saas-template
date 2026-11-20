import { allDocs, allGuides, allLegalPages, allPosts } from 'content-collections'
import { templateConfig } from '../../server/template-config.ts'
import { indexedPages, type SeoPage } from './metadata.ts'
import { type PageLinks, pageLinks } from './page-links.ts'
import { publicPages } from './pages.ts'

export function getPublicPages() {
  return publicPages({
    posts: allPosts,
    legal: allLegalPages,
    docs: allDocs,
    guides: allGuides,
  })
}

// 内链区块按请求计算：清单在同一分钟内复用，定时发布的文章最多延迟一分钟出现在区块中
let cached: { minute: number; pages: SeoPage[] } | null = null
function currentPages(): SeoPage[] {
  const minute = Math.floor(Date.now() / 60_000)
  if (cached?.minute !== minute) cached = { minute, pages: getPublicPages() }
  return cached.pages
}

/**
 * 页面的面包屑、系列、相关与同组链接（openspec seo-internal-linking 3.1–3.3），只在 server function 中调用，
 * 页面清单不进入客户端包。`fallbackParent` 用于清单之外仍可访问的页面（开发环境的草稿）。
 */
export function getPageLinks(path: string, locale: string, fallbackParent?: string): PageLinks {
  return pageLinks(currentPages(), path, locale, templateConfig.seo.linking, fallbackParent)
}

/** 公开页面清单中的一页（不带语言前缀的 path），用于由清单生成的页面（如 hub 分页）输出 head */
export function getPublicPage(path: string, locale: string): SeoPage | undefined {
  return currentPages().find((page) => page.path === path && page.locale === locale)
}

/**
 * 清单中存在该地址的可索引真实页面的语言（回退页除外），供由清单生成的 hub 页面（标签、分页）输出 hreflang：
 * `'hide'` 下各语言的标签与页数可能不同，hreflang 只能列出真实存在的版本。
 */
export function getPageLanguages(path: string): string[] {
  return indexedPages(currentPages())
    .filter((page) => page.path === path)
    .map((page) => page.locale)
}
