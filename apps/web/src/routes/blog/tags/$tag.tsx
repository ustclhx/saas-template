import { createFileRoute } from '@tanstack/react-router'
import { BlogHub } from '../../../features/marketing/blog/blog-hub.tsx'
import { getBlogIndex } from '../../../features/marketing/content.functions.ts'
import { originFromMatches, pageHead } from '../../../features/seo/metadata.ts'
import { breadcrumbData } from '../../../features/seo/structured-data.ts'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'

export const Route = createFileRoute('/blog/tags/$tag')({
  loader: ({ params }) => getBlogIndex({ data: { locale: getLocale(), tag: params.tag } }),
  head: ({ params, matches, loaderData }) => {
    const title = m.marketing_blog_tag_title({ tag: params.tag })
    const appUrl = originFromMatches(matches)
    return pageHead(
      {
        path: `/blog/tags/${encodeURIComponent(params.tag)}`,
        locale: getLocale(),
        title,
        description: `${m.marketing_blog_subtitle()} · ${params.tag}`,
      },
      appUrl,
      loaderData ? [breadcrumbData(loaderData.breadcrumb, title, appUrl, getLocale())] : [],
    )
  },
  component: BlogTagPage,
})

function BlogTagPage() {
  const { tag } = Route.useParams()
  return (
    <BlogHub
      data={Route.useLoaderData()}
      hub={`/blog/tags/${encodeURIComponent(tag)}`}
      title={m.marketing_blog_tag_title({ tag })}
    />
  )
}
