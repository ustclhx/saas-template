import type { ReactNode } from 'react'
import { m } from '../../../paraglide/messages.js'
import type { PageLink } from '../../seo/page-links.ts'
import { MarketingShell } from '../marketing-shell.tsx'
import { HubPagination, PageBreadcrumb } from '../page-links.tsx'
import { PostList, type PostSummary } from './post-list.tsx'

export interface BlogHubData {
  readonly posts: readonly PostSummary[]
  readonly total: number
  readonly page: number
  readonly pageCount: number
  readonly breadcrumb: readonly PageLink[]
}

/**
 * 博客列表与标签页共用的 hub 布局（openspec seo-internal-linking 3.2，设计稿 seo-internal-linking/Hub.dc.html）：
 * 面包屑 → 标题 → 筛选 → 卡片列表 → 分页。第 2 页起标题带页码，避免各分页的 H1 与主词重复。
 */
export function BlogHub({
  data,
  hub,
  title,
  subtitle,
  filters,
}: {
  data: BlogHubData
  /** hub 首页地址（不带语言前缀），分页地址由它推出 */
  hub: string
  title: string
  subtitle?: ReactNode
  filters?: ReactNode
}) {
  const heading = data.page > 1 ? m.marketing_linking_page_title({ title, page: data.page }) : title
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-5xl gap-6 px-4 pt-10 pb-16">
        <PageBreadcrumb trail={data.breadcrumb} current={heading} />
        <header className="grid gap-2">
          <h1 className="font-bold text-4xl tracking-tight">{heading}</h1>
          {subtitle != null || data.pageCount > 1 ? (
            <p className="text-muted-foreground">
              {subtitle}
              {data.pageCount > 1 &&
                ` ${m.marketing_linking_page_summary({
                  total: data.total,
                  page: data.page,
                  pageCount: data.pageCount,
                })}`}
            </p>
          ) : null}
        </header>
        {filters}
        <PostList posts={data.posts} />
        <HubPagination hub={hub} page={data.page} pageCount={data.pageCount} />
      </div>
    </MarketingShell>
  )
}
