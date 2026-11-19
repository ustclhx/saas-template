import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { allDocs, allGuides, allLegalPages, allPosts } from 'content-collections'
import { z } from 'zod'
import { templateConfig } from '../../server/template-config.ts'
import {
  findLocalized,
  findPost,
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
 */

const { locales, defaultLocale } = templateConfig.i18n
const locale = z
  .string()
  .transform((value) => ((locales as readonly string[]).includes(value) ? value : defaultLocale))
const slug = z.string().min(1).max(200)

function requireBlog() {
  if (!templateConfig.features.blog) throw notFound()
}

export const getBlogIndex = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, tag: z.string().max(64).optional() }))
  .handler(({ data }) => {
    requireBlog()
    const now = new Date()
    const options = { locale: data.locale, defaultLocale, now }
    const posts = listPosts(allPosts, { ...options, tag: data.tag }).map(
      ({ html, ...summary }) => summary,
    )
    if (data.tag !== undefined && posts.length === 0) throw notFound()
    return { posts, tags: listTags(listPosts(allPosts, options)) }
  })

export const getBlogPost = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    requireBlog()
    const now = new Date()
    const post = findPost(allPosts, { ...data, defaultLocale, now })
    if (!post) throw notFound()
    const published = allPosts.filter((entry) => isPublished(entry, now))
    return { ...post, translations: translationLocales(published, post.slug) }
  })

export const getLegalPage = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    const page = findLocalized(allLegalPages, data.slug, data.locale, defaultLocale)
    if (!page) throw notFound()
    return { ...page, translations: translationLocales(allLegalPages, page.slug) }
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
    return { ...result, translations: translationLocales(allDocs, result.page.slug) }
  })

function requireGuides() {
  if (!templateConfig.features.guides) throw notFound()
}

export const getGuideIndex = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale }))
  .handler(({ data }) => {
    requireGuides()
    return localizedEntries(allGuides, data.locale, defaultLocale).map(
      ({ html, faq, ...summary }) => summary,
    )
  })

export const getGuide = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ locale, slug }))
  .handler(({ data }) => {
    requireGuides()
    const guide = findLocalized(allGuides, data.slug, data.locale, defaultLocale)
    if (!guide) throw notFound()
    return { ...guide, translations: translationLocales(allGuides, guide.slug) }
  })
