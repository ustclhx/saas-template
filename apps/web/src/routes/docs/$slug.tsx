import { createFileRoute } from '@tanstack/react-router'
import { getDocsPage } from '../../features/marketing/content.functions.ts'
import { DocsLayout } from '../../features/marketing/docs-layout.tsx'
import { originFromMatches, pageHead } from '../../features/seo/metadata.ts'
import { breadcrumbListData } from '../../features/seo/structured-data.ts'
import { getLocale } from '../../paraglide/runtime.js'

// features.docs 关闭时 getDocsPage 抛出 notFound（404）
export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }) => getDocsPage({ data: { locale: getLocale(), slug: params.slug } }),
  head: ({ loaderData, params, matches }) =>
    loaderData
      ? pageHead(
          {
            path: `/docs/${encodeURIComponent(params.slug)}`,
            locale: getLocale(),
            title: loaderData.page.title,
            description: loaderData.page.description,
            sourceLocale: loaderData.page.locale,
          },
          originFromMatches(matches),
          [
            breadcrumbListData(
              loaderData.links.breadcrumb,
              loaderData.page.title,
              originFromMatches(matches),
              getLocale(),
            ),
          ],
          loaderData.translations,
        )
      : {},
  component: DocsPage,
})

function DocsPage() {
  const data = Route.useLoaderData()
  return <DocsLayout {...data} current={data.page.title} />
}
