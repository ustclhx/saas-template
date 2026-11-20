import {
  Breadcrumb,
  LinkCardGrid,
  LinkList,
  Pagination,
  type RenderLink,
  SeriesNav,
} from '@saas/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { staticPage } from '../seo/metadata.ts'
import {
  breadcrumbTrail,
  hubPagePath,
  mainLabel,
  type PageLink,
  type PageLinks,
} from '../seo/page-links.ts'

/**
 * 公开页内链区块的页面接入（openspec seo-internal-linking 3.1–3.3，design 决策 7）。组件来自 @saas/ui，
 * 数据由 server function 按公开页面清单计算（features/seo/page-links.ts）。地址不带语言前缀，
 * 交给路由 Link 按当前语言加前缀，最终仍渲染为真实 <a href>。
 */
export const routerLink: RenderLink = ({ href, ...props }) => (
  // 清单中的地址已按段编码；路由按段编码 to，先解码避免二次编码。配置路径无法对应到具体路由类型。
  // 只在完全相同的地址上标记激活：默认的前缀匹配会给面包屑上级加上 aria-current="page"
  <Link to={decodeURI(href) as '/'} activeOptions={{ exact: true }} {...props} />
)

/** 页面顶部的面包屑：替换原先的「← 返回」链接；首页（没有上级）不渲染 */
export function PageBreadcrumb({
  trail,
  current,
  className,
}: {
  trail: readonly PageLink[]
  current: string
  className?: string | undefined
}) {
  if (trail.length === 0) return null
  return (
    <Breadcrumb
      label={m.marketing_linking_breadcrumb()}
      items={trail}
      current={current}
      renderLink={routerLink}
      className={className}
    />
  )
}

/** 模板静态页（定价、通讯、候补名单）的上级链：层级在 staticPage() 中声明，不需要查询页面清单 */
export function staticTrail(path: string, locale: string = getLocale()): PageLink[] {
  return breadcrumbTrail(path, (target) => staticPage(target, locale))
}

/** 模板静态页的面包屑，当前项为该页主词 */
export function StaticPageBreadcrumb({
  path,
  className,
}: {
  path: string
  className?: string | undefined
}) {
  const locale = getLocale()
  return (
    <PageBreadcrumb
      trail={staticTrail(path, locale)}
      current={mainLabel(staticPage(path, locale))}
      className={className}
    />
  )
}

/** 正文之后的区块，顺序固定：系列上一篇／下一篇 → 相关 → 同组；未声明的区块不渲染 */
export function PageLinkSections({ links }: { links: PageLinks }) {
  const { series, related, group } = links
  return (
    <>
      {series ? (
        <SeriesNav
          label={m.marketing_linking_series()}
          previous={
            series.previous && {
              href: series.previous.href,
              title: series.previous.label,
              label: m.marketing_linking_previous(),
            }
          }
          next={
            series.next && {
              href: series.next.href,
              title: series.next.label,
              label: m.marketing_linking_next(),
            }
          }
          renderLink={routerLink}
          className="mt-4"
        />
      ) : null}
      <LinkCardGrid
        title={m.marketing_linking_related()}
        items={related.map(({ href, label, description }) => ({
          href,
          title: label,
          description,
        }))}
        renderLink={routerLink}
      />
      {group ? (
        <LinkList
          title={
            group.hub
              ? m.marketing_linking_group({ group: group.hub.label })
              : m.marketing_linking_group_other()
          }
          items={group.items}
          viewAll={group.hub}
          group={group.key}
          renderLink={routerLink}
        />
      ) : null}
    </>
  )
}

/** hub 列表的分页：第 1 页即 hub 本身；只有一页时不渲染 */
export function HubPagination({
  hub,
  page,
  pageCount,
}: {
  hub: string
  page: number
  pageCount: number
}) {
  if (pageCount <= 1) return null
  return (
    <Pagination
      page={page}
      pageCount={pageCount}
      hrefFor={(n) => hubPagePath(hub, n)}
      labels={{
        nav: m.marketing_linking_pagination(),
        previous: m.marketing_linking_previous_page(),
        next: m.marketing_linking_next_page(),
        page: (n) => m.marketing_linking_page({ page: n }),
      }}
      renderLink={routerLink}
    />
  )
}
