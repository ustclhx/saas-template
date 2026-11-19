import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { allDocs, allGuides, allLegalPages, allPosts } from 'content-collections'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import { contentParents } from '../seo/content-parents.ts'
import { hubPagePath } from '../seo/page-links.ts'
import { getPageLinks, getPublicPage } from '../seo/pages.server.ts'
import {
  findLocalized,
  findPost,
  hubPageCount,
  hubSlice,
  isPublished,
  listPosts,
  listTags,
  loadDocsPage,
  localizedEntries,
  translationLocales,
} from './content.ts'

/**
 * 博客、法律页与文档的数据（tasks.md 3.3、3.4）。内容在构建期生成，不访问数据库；
 * 页面经预渲染输出静态 HTML，客户端路由跳转时才调用这些 server function。
 *
 * 语言由调用方传入：server function 的请求地址不带语言前缀，服务端无法从 URL 得到页面语言。
 * 详情数据附带 `translations`（真实存在译文的语言），条目自身的 `locale` 是内容的真实语言，
 * 页面据此输出回退页的 canonical 与 hreflang（openspec seo-internal-linking 2.2）。
 * `links` 是面包屑与内链区块（seo-internal-linking 3.1–3.3），由公开页面清单在服务端计算。
 */

const { locales, defaultLocale } = templateConfig.i18n
const locale = z
  .string()
  .transform((value) => ((locales as readonly string[]).includes(value) ? value : defaultLocale))
const slug = z.string().min(1).max(200)

function requireBlog() {
  if (!templateConfig.features.blog) throw notFound()
}

/** 博客列表与标签页（hub）：超过 `seo.linking.hubPageSize` 时分页，`page` 超出范围时 404 */
export const getBlogIndex = createServerFn({ method: 'GET' })
  .inputValidator(
    z.object({
      locale,
      tag: z.string().max(64).optional(),
      page: z.number().int().min(1).max(10_000).default(1),
    }),
  )
  .handler(({ data }) => {
    requireBlog()
    const now = new Date()
    const options = { locale: data.locale, defaultLocale, now }
    const all = listPosts(allPosts, { ...options, tag: data.tag }).map(
      ({ html, ...summary }) => summary,
    )
    if (data.tag !== undefined && all.length === 0) throw notFound()
    const { hubPageSize } = templateConfig.seo.linking
    const posts = hubSlice(all, data.page, hubPageSize)
    if (!posts) throw notFound()
    const hub = data.tag === undefined ? '/blog' : `/blog/tags/${encodeURIComponent(data.tag)}`
    const path = hubPagePath(hub, data.page)
    return {
      posts,
      total: all.length,
      page: data.page,
      pageCount: hubPageCount(all.length, hubPageSize),
      tags: listTags(listPosts(allPosts, options)),
      breadcrumb: getPageLinks(path, data.locale).breadcrumb,
      // 第 2 页起的标题、描述与主词来自公开页面清单（与站点地图一致）
      seo: data.page > 1 ? (getPublicPage(path, data.locale) ?? null) : null,
    }
  })

export const getBlogPost = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    requireBlog()
    const now = new Date()
    const post = findPost(allPosts, { ...data, defaultLocale, now })
    if (!post) throw notFound()
    const published = allPosts.filter((entry) => isPublished(entry, now))
    return {
      ...post,
      translations: translationLocales(published, post.slug),
      links: getPageLinks(
        `/blog/${encodeURIComponent(post.slug)}`,
        data.locale,
        post.parent ?? contentParents.posts,
      ),
    }
  })

export const getLegalPage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    const page = findLocalized(allLegalPages, data.slug, data.locale, defaultLocale)
    if (!page) throw notFound()
    return {
      ...page,
      translations: translationLocales(allLegalPages, page.slug),
      links: getPageLinks(`/legal/${encodeURIComponent(page.slug)}`, data.locale, page.parent),
    }
  })

export const getDocsPage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug: slug.optional() }))
  .handler(({ data }) => {
    const result = loadDocsPage(allDocs, {
      enabled: templateConfig.features.docs,
      slug: data.slug,
      locale: data.locale,
      defaultLocale,
    })
    if (!result) throw notFound()
    // 文档首页（/docs）显示第一篇的正文，面包屑与区块按 /docs 本身计算
    const path = data.slug === undefined ? '/docs' : `/docs/${encodeURIComponent(result.page.slug)}`
    return {
      ...result,
      translations: translationLocales(allDocs, result.page.slug),
      links: getPageLinks(path, data.locale, data.slug === undefined ? '/' : result.page.parent),
    }
  })

function requireGuides() {
  if (!templateConfig.features.guides) throw notFound()
}

export const getGuideIndex = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale }))
  .handler(({ data }) => {
    requireGuides()
    return {
      guides: localizedEntries(allGuides, data.locale, defaultLocale).map(
        ({ html, faq, ...summary }) => summary,
      ),
      breadcrumb: getPageLinks('/guides', data.locale).breadcrumb,
    }
  })

export const getGuide = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    requireGuides()
    const guide = findLocalized(allGuides, data.slug, data.locale, defaultLocale)
    if (!guide) throw notFound()
    return {
      ...guide,
      translations: translationLocales(allGuides, guide.slug),
      links: getPageLinks(`/guides/${encodeURIComponent(guide.slug)}`, data.locale, guide.parent),
    }
  })
