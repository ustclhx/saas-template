import { createFileRoute } from '@tanstack/react-router'
import { getDocsPage } from '../../features/marketing/content.functions.ts'
import { DocsLayout } from '../../features/marketing/docs-layout.tsx'
import { originFromMatches, pageHead, staticPage } from '../../features/seo/metadata.ts'
import { mainLabel } from '../../features/seo/page-links.ts'
import { breadcrumbListData } from '../../features/seo/structured-data.ts'
import { getLocale } from '../../paraglide/runtime.js'

// 文档首页显示侧边导航中的第一篇；features.docs 关闭时 getDocsPage 抛出 notFound（404）
export const Route = createFileRoute('/docs/')({
  loader: () => getDocsPage({ data: { locale: getLocale() } }),
  head: ({ matches, loaderData }) => {
    const page = staticPage('/docs', getLocale())
    const appUrl = originFromMatches(matches)
    return pageHead(
      page,
      appUrl,
      loaderData
        ? [breadcrumbListData(loaderData.links.breadcrumb, mainLabel(page), appUrl, page.locale)]
        : [],
    )
  },
  component: DocsIndexPage,
})

function DocsIndexPage() {
  return (
    <DocsLayout {...Route.useLoaderData()} current={mainLabel(staticPage('/docs', getLocale()))} />
  )
}
