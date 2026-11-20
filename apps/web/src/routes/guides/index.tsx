import { LinkCardGrid } from '@saas/ui'
import { createFileRoute } from '@tanstack/react-router'
import { getGuideIndex } from '../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../features/marketing/marketing-shell.tsx'
import { PageBreadcrumb, routerLink } from '../../features/marketing/page-links.tsx'
import { originFromMatches, pageHead, staticPage } from '../../features/seo/metadata.ts'
import { breadcrumbListData } from '../../features/seo/structured-data.ts'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'

export const Route = createFileRoute('/guides/')({
  loader: () => getGuideIndex({ data: { locale: getLocale() } }),
  head: ({ matches, loaderData }) => {
    const page = staticPage('/guides', getLocale())
    const appUrl = originFromMatches(matches)
    return pageHead(
      page,
      appUrl,
      loaderData
        ? [
            breadcrumbListData(
              loaderData.breadcrumb,
              m.marketing_guides_title(),
              appUrl,
              page.locale,
            ),
          ]
        : [],
    )
  },
  component: GuideIndexPage,
})

// 答案页 hub：列出全部答案页（hub 列表，设计稿 seo-internal-linking/Hub.dc.html 的卡片样式）
function GuideIndexPage() {
  const { guides, breadcrumb } = Route.useLoaderData()
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-5xl gap-6 px-4 pt-10 pb-16">
        <PageBreadcrumb trail={breadcrumb} current={m.marketing_guides_title()} />
        <header className="grid gap-2">
          <h1 className="font-bold text-4xl tracking-tight">{m.marketing_guides_title()}</h1>
          <p className="text-muted-foreground">{m.marketing_guides_subtitle()}</p>
        </header>
        <LinkCardGrid
          columns={2}
          zone={null}
          renderLink={routerLink}
          items={guides.map((guide) => ({
            href: `/guides/${encodeURIComponent(guide.slug)}`,
            title: guide.title,
            description: guide.answer_summary,
          }))}
        />
      </div>
    </MarketingShell>
  )
}
