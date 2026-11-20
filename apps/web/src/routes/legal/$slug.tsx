import { createFileRoute } from '@tanstack/react-router'
import { formatDate } from '../../features/marketing/blog/post-list.tsx'
import { getLegalPage } from '../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../features/marketing/marketing-shell.tsx'
import { PageBreadcrumb, PageLinkSections } from '../../features/marketing/page-links.tsx'
import { RichContent } from '../../features/marketing/rich-content.tsx'
import { originFromMatches, pageHead } from '../../features/seo/metadata.ts'
import { breadcrumbListData } from '../../features/seo/structured-data.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

// 法律页（tasks.md 3.3、3.5）：隐私政策 privacy、服务条款 terms、退款政策 refund，内容见 content/legal
export const Route = createFileRoute('/legal/$slug')({
  loader: ({ params }) => getLegalPage({ data: { locale: getLocale(), slug: params.slug } }),
  head: ({ loaderData, params, matches }) =>
    loaderData
      ? pageHead(
          {
            path: `/legal/${encodeURIComponent(params.slug)}`,
            locale: getLocale(),
            title: loaderData.title,
            description: loaderData.description,
            sourceLocale: loaderData.locale,
          },
          originFromMatches(matches),
          [
            breadcrumbListData(
              loaderData.links.breadcrumb,
              loaderData.title,
              originFromMatches(matches),
              getLocale(),
            ),
          ],
          loaderData.translations,
        )
      : {},
  component: LegalPage,
})

function LegalPage() {
  const page = Route.useLoaderData()
  return (
    <MarketingShell>
      <article lang={page.locale} className="mx-auto grid max-w-3xl gap-4 px-4 pt-10 pb-16">
        <PageBreadcrumb trail={page.links.breadcrumb} current={page.title} className="mb-2" />
        <h1 className="font-bold text-4xl tracking-tight">{page.title}</h1>
        <p className="text-muted-foreground text-sm">
          {m.marketing_legal_updated({ date: formatDate(page.updatedAt, getLocale()) })}
        </p>
        <RichContent html={page.html} />
        <PageLinkSections links={page.links} />
      </article>
    </MarketingShell>
  )
}
