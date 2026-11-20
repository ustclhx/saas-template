import { createFileRoute } from '@tanstack/react-router'
import { getGuide } from '../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../features/marketing/marketing-shell.tsx'
import { PageBreadcrumb, PageLinkSections } from '../../features/marketing/page-links.tsx'
import { RichContent } from '../../features/marketing/rich-content.tsx'
import { originFromMatches, pageHead } from '../../features/seo/metadata.ts'
import { breadcrumbListData, faqData } from '../../features/seo/structured-data.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

export const Route = createFileRoute('/guides/$slug')({
  loader: ({ params }) => getGuide({ data: { locale: getLocale(), slug: params.slug } }),
  head: ({ loaderData, params, matches }) => {
    if (!loaderData) return {}
    const appUrl = originFromMatches(matches)
    return pageHead(
      {
        path: `/guides/${encodeURIComponent(params.slug)}`,
        locale: getLocale(),
        title: loaderData.title,
        description: loaderData.answer_summary,
        sourceLocale: loaderData.locale,
      },
      appUrl,
      [
        faqData(loaderData.faq),
        breadcrumbListData(loaderData.links.breadcrumb, loaderData.title, appUrl, getLocale()),
      ],
      loaderData.translations,
    )
  },
  component: GuidePage,
})

function GuidePage() {
  const guide = Route.useLoaderData()
  return (
    <MarketingShell>
      <article lang={guide.locale} className="mx-auto grid max-w-3xl gap-6 px-4 pt-10 pb-16">
        <PageBreadcrumb trail={guide.links.breadcrumb} current={guide.title} />
        <h1 className="font-bold text-4xl tracking-tight">{guide.title}</h1>
        {/* 结论置顶：读者与 AI 助手都先看到答案，正文只做展开。 */}
        <p data-testid="answer-summary" className="rounded-xl border p-4 text-lg">
          {guide.answer_summary}
        </p>
        <RichContent html={guide.html} />
        <section className="grid gap-4">
          <h2 className="font-semibold text-2xl">{m.marketing_guides_faq()}</h2>
          {guide.faq.map((item) => (
            <div key={item.q} className="grid gap-1">
              <h3 className="font-semibold">{item.q}</h3>
              <p className="text-muted-foreground">{item.a}</p>
            </div>
          ))}
        </section>
        <PageLinkSections links={guide.links} />
      </article>
    </MarketingShell>
  )
}
