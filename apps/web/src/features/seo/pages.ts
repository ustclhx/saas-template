import { templateConfig } from '../../server/template-config.ts'
import { listPosts, listTags, localizedEntries } from '../marketing/content.ts'
import { contentParents } from './content-parents.ts'
import type { SeoPage } from './metadata.ts'
import { localizedPath, staticPage } from './metadata.ts'
import { projectPages } from './pages.project.ts'

/** 内容集合 frontmatter 中的内链字段（content-collections.ts 已按集合补上默认 parent） */
interface Linking {
  parent?: string | undefined
  anchor_short?: string | undefined
  related?: readonly string[] | undefined
}
interface Post extends Linking {
  slug: string
  locale: string
  title: string
  summary: string
  date: string
  tags: string[]
  draft: boolean
  cover?: string | undefined
}
interface Page extends Linking {
  slug: string
  locale: string
  title: string
  description: string
}
interface Guide extends Linking {
  slug: string
  locale: string
  title: string
  answer_summary: string
  draft: boolean
}

/** 内容条目的公共字段：主词默认取标题；条目语言与当前语言不同即为回退页 */
function contentPage(
  entry: Linking & { locale: string; title: string },
  locale: string,
  path: string,
  defaultParent: string,
): Omit<SeoPage, 'description'> {
  return {
    path,
    locale,
    title: entry.title,
    titleMain: entry.title,
    parent: entry.parent ?? defaultParent,
    sourceLocale: entry.locale,
    ...(entry.anchor_short !== undefined && { anchorShort: entry.anchor_short }),
    ...(entry.related?.length ? { related: entry.related } : {}),
  }
}

/** 地图与 OG 共用公开页面清单，始终排除草稿、未来文章和关闭的功能。 */
export function publicPages(
  content: {
    posts: readonly Post[]
    legal: readonly Page[]
    docs: readonly Page[]
    guides?: readonly Guide[]
  },
  now = new Date(),
  config = templateConfig,
): SeoPage[] {
  if (!config.marketing.enabled) return []
  const locales = config.i18n.enabled ? config.i18n.locales : [config.i18n.defaultLocale]
  return locales.flatMap((locale) => {
    const { defaultLocale } = config.i18n
    const pages = ['/', ...(config.billing.enabled ? ['/pricing'] : [])].map((path) =>
      staticPage(path, locale),
    )
    if (config.features.newsletter) pages.push(staticPage('/newsletter', locale))
    if (config.features.waitlist) pages.push(staticPage('/waitlist', locale))
    if (config.features.blog) {
      pages.push(staticPage('/blog', locale))
      const posts = listPosts(
        content.posts.filter((post) => !post.draft),
        { locale, defaultLocale, now },
      )
      pages.push(
        ...posts.map((post) => ({
          ...contentPage(
            post,
            locale,
            `/blog/${encodeURIComponent(post.slug)}`,
            contentParents.posts,
          ),
          description: post.summary,
          date: post.date,
          cover: post.cover,
        })),
      )
      // 标签页按当前语言生成（含回退文章），各语言都是真实页面
      pages.push(
        ...listTags(posts).map((tag) => ({
          path: `/blog/tags/${encodeURIComponent(tag)}`,
          locale,
          title: locale === 'zh' ? `标签“${tag}”下的文章` : `Posts tagged “${tag}”`,
          titleMain: locale === 'zh' ? `标签：${tag}` : `Tag: ${tag}`,
          anchorShort: tag,
          parent: '/blog',
          description: `${staticPage('/blog', locale).description} · ${tag}`,
        })),
      )
    }
    pages.push(
      ...localizedEntries(content.legal, locale, defaultLocale).map((page) => ({
        ...contentPage(
          page,
          locale,
          `/legal/${encodeURIComponent(page.slug)}`,
          contentParents.legal,
        ),
        description: page.description,
      })),
    )
    if (config.features.guides) {
      pages.push(staticPage('/guides', locale))
      pages.push(
        ...localizedEntries(
          (content.guides ?? []).filter((guide) => !guide.draft),
          locale,
          defaultLocale,
        ).map((guide) => ({
          ...contentPage(
            guide,
            locale,
            `/guides/${encodeURIComponent(guide.slug)}`,
            contentParents.guides,
          ),
          description: guide.answer_summary,
        })),
      )
    }
    if (config.features.docs) {
      pages.push(staticPage('/docs', locale))
      pages.push(
        ...localizedEntries(content.docs, locale, defaultLocale).map((page) => ({
          ...contentPage(
            page,
            locale,
            `/docs/${encodeURIComponent(page.slug)}`,
            contentParents.docs,
          ),
          description: page.description,
        })),
      )
    }
    // 项目自有页面（pages.project.ts）与模板清单合并
    pages.push(...projectPages({ locale, defaultLocale, now, config }))
    return pages
  })
}

export function findPublicPage(pages: readonly SeoPage[], path: string): SeoPage | undefined {
  return pages.find((page) => localizedPath(page.path, page.locale) === path)
}
