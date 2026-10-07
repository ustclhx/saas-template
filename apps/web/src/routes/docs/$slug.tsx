import { createFileRoute } from '@tanstack/react-router'
import { getDocsPage } from '../../features/marketing/content.functions.ts'
import { DocsLayout } from '../../features/marketing/docs-layout.tsx'
import { getLocale } from '../../paraglide/runtime.js'

// features.docs 关闭时 getDocsPage 抛出 notFound（404）
export const Route = createFileRoute('/docs/$slug')({
  loader: ({ params }) => getDocsPage({ data: { locale: getLocale(), slug: params.slug } }),
  head: ({ loaderData }) => ({
    meta: loaderData
      ? [
          { title: loaderData.page.title },
          { name: 'description', content: loaderData.page.description },
        ]
      : [],
  }),
  component: DocsPage,
})

function DocsPage() {
  return <DocsLayout {...Route.useLoaderData()} />
}
