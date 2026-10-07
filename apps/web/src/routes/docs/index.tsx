import { createFileRoute } from '@tanstack/react-router'
import { getDocsPage } from '../../features/marketing/content.functions.ts'
import { DocsLayout } from '../../features/marketing/docs-layout.tsx'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

// 文档首页显示侧边导航中的第一篇；features.docs 关闭时 getDocsPage 抛出 notFound（404）
export const Route = createFileRoute('/docs/')({
  loader: () => getDocsPage({ data: { locale: getLocale() } }),
  head: () => ({ meta: [{ title: m.marketing_docs_title() }] }),
  component: DocsIndexPage,
})

function DocsIndexPage() {
  return <DocsLayout {...Route.useLoaderData()} />
}
