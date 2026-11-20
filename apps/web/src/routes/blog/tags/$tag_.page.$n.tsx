import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import { BlogHub } from '../../../features/marketing/blog/blog-hub.tsx'
import { getBlogIndex } from '../../../features/marketing/content.functions.ts'
import { originFromMatches, pageHead } from '../../../features/seo/metadata.ts'
import { parseHubPage } from '../../../features/seo/page-links.ts'
import { breadcrumbListData } from '../../../features/seo/structured-data.ts'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'

// 标签 hub 的分页（openspec seo-internal-linking 3.2）：/blog/tags/<tag>/page/<n>，第 1 页即标签页
export const Route = createFileRoute('/blog/tags/$tag_/page/$n')({
  beforeLoad: ({ params }) => {
    const page = parseHubPage(params.n)
    if (page === null) throw notFound()
    if (page === 1)
      throw redirect({ to: '/blog/tags/$tag', params: { tag: params.tag }, statusCode: 301 })
  },
  loader: ({ params }) =>
    getBlogIndex({
      data: { locale: getLocale(), tag: params.tag, page: parseHubPage(params.n) ?? 1 },
    }),
  head: ({ params, matches, loaderData }) => {
    const page = loaderData?.seo
    if (!loaderData || !page) return {}
    const appUrl = originFromMatches(matches)
    // 与页面上的面包屑当前项（H1）一致
    const current = m.marketing_linking_page_title({
      title: m.marketing_blog_tag_title({ tag: params.tag }),
      page: loaderData.page,
    })
    return pageHead(page, appUrl, [
      breadcrumbListData(loaderData.breadcrumb, current, appUrl, page.locale),
    ])
  },
  component: BlogTagPaginatedPage,
})

function BlogTagPaginatedPage() {
  const { tag } = Route.useParams()
  return (
    <BlogHub
      data={Route.useLoaderData()}
      hub={`/blog/tags/${encodeURIComponent(tag)}`}
      title={m.marketing_blog_tag_title({ tag })}
    />
  )
}
