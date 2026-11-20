import { createFileRoute } from '@tanstack/react-router'
import { BlogHub } from '../../features/marketing/blog/blog-hub.tsx'
import { TagLinks } from '../../features/marketing/blog/post-list.tsx'
import { getBlogIndex } from '../../features/marketing/content.functions.ts'
import { originFromMatches, pageHead, staticPage } from '../../features/seo/metadata.ts'
import { breadcrumbData } from '../../features/seo/structured-data.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

export const Route = createFileRoute('/blog/')({
  loader: () => getBlogIndex({ data: { locale: getLocale() } }),
  head: ({ matches, loaderData }) => {
    const page = staticPage('/blog', getLocale())
    const appUrl = originFromMatches(matches)
    return pageHead(
      page,
      appUrl,
      loaderData
        ? [breadcrumbData(loaderData.breadcrumb, m.marketing_blog_title(), appUrl, page.locale)]
        : [],
    )
  },
  component: BlogIndexPage,
})

function BlogIndexPage() {
  const data = Route.useLoaderData()
  return (
    <BlogHub
      data={data}
      hub="/blog"
      title={m.marketing_blog_title()}
      subtitle={m.marketing_blog_subtitle()}
      filters={<TagLinks tags={data.tags} />}
    />
  )
}
