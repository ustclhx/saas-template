// 模板新增（openspec seo-internal-linking 3.2，设计稿 docs/design-system/prototypes/seo-internal-linking/
// Hub、States.dc.html）：hub 列表分页。每一页都是真实 <a href>（链接图从 hub 首页可到达全部分页），当前页不是链接。
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Fragment, forwardRef, type HTMLAttributes } from 'react'
import { cn } from '../lib/utils.ts'
import {
  defaultRenderLink,
  type LinkZone,
  linkFocusClass,
  type RenderLink,
} from './link-render.tsx'

export interface PaginationLabels {
  /** nav 的可读名称（如「分页」） */
  nav: string
  previous: string
  next: string
  /** 页码的可读名称（如 `第 ${page} 页`） */
  page: (page: number) => string
}

interface PaginationProps extends HTMLAttributes<HTMLElement> {
  /** 当前页，从 1 起；超出范围时按边界处理 */
  page: number
  pageCount: number
  /** 各页地址，由调用方给（如第 1 页为 /blog，其余为 /blog/page/n） */
  hrefFor: (page: number) => string
  labels: PaginationLabels
  renderLink?: RenderLink
  /** data-link-zone，默认不输出（hub 列表按正文统计） */
  zone?: LinkZone | null
}

export type PaginationRangeItem = number | 'ellipsis'

/**
 * 要显示的页码：首页、末页、当前页前后各一页，其余用省略号。
 * 省略号只代替两页及以上；中间只隔一页时直接显示那一页（省略号不比页码更省地方）。
 */
export function paginationRange(page: number, pageCount: number): PaginationRangeItem[] {
  if (pageCount < 1) return []
  const current = Math.min(Math.max(1, Math.trunc(page)), pageCount)
  const shown = [...new Set([1, current - 1, current, current + 1, pageCount])]
    .filter((n) => n >= 1 && n <= pageCount)
    .sort((a, b) => a - b)
  const range: PaginationRangeItem[] = []
  let previous = 0
  for (const n of shown) {
    if (n - previous === 2) range.push(previous + 1)
    else if (n - previous > 2) range.push('ellipsis')
    range.push(n)
    previous = n
  }
  return range
}

const itemClass = 'inline-flex h-9 items-center justify-center rounded-lg text-body text-foreground'
const linkClass = cn(
  itemClass,
  'transition-colors duration-80 hover:bg-hover active:bg-active',
  linkFocusClass,
)
const stepClass = 'gap-1 px-3'
const numberClass = 'w-9'

const Pagination = forwardRef<HTMLElement, PaginationProps>(
  (
    {
      page,
      pageCount,
      hrefFor,
      labels,
      renderLink = defaultRenderLink,
      zone = null,
      className,
      ...props
    },
    ref,
  ) => {
    if (pageCount <= 1) return null
    const current = Math.min(Math.max(1, Math.trunc(page)), pageCount)
    const previous = current > 1 ? current - 1 : null
    const next = current < pageCount ? current + 1 : null
    const prevContent = (
      <>
        <ChevronLeft aria-hidden="true" className="size-3.5" />
        {labels.previous}
      </>
    )
    const nextContent = (
      <>
        {labels.next}
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </>
    )
    return (
      <nav
        ref={ref}
        aria-label={labels.nav}
        data-slot="pagination"
        data-link-zone={zone ?? undefined}
        className={cn('flex items-center justify-center gap-1', className)}
        {...props}
      >
        {previous === null ? (
          // 第一页没有上一页：不渲染为链接，保留位置使页码不跳动（Hub 画板 aria-disabled 的「下一页」同理）
          <span aria-disabled="true" className={cn(itemClass, stepClass, 'text-muted-foreground')}>
            {prevContent}
          </span>
        ) : (
          renderLink({
            href: hrefFor(previous),
            className: cn(linkClass, stepClass),
            children: prevContent,
          })
        )}
        {paginationRange(current, pageCount).map((item, index) =>
          item === 'ellipsis' ? (
            <span
              // 省略号最多两个，位置即身份
              // biome-ignore lint/suspicious/noArrayIndexKey: 省略号没有自身的值，前后页码决定其位置
              key={`ellipsis-${index}`}
              aria-hidden="true"
              className="w-6 text-center text-muted-foreground max-md:hidden"
            >
              …
            </span>
          ) : item === current ? (
            <span
              key={item}
              aria-current="page"
              className={cn(
                itemClass,
                numberClass,
                'bg-primary font-semibold text-primary-foreground',
              )}
            >
              <span className="sr-only">{labels.page(item)}</span>
              <span aria-hidden="true">{item}</span>
            </span>
          ) : (
            // 手机只显示上一页、当前页码、下一页
            <Fragment key={item}>
              {renderLink({
                href: hrefFor(item),
                className: cn(linkClass, numberClass, 'max-md:hidden'),
                'aria-label': labels.page(item),
                children: item,
              })}
            </Fragment>
          ),
        )}
        {next === null ? (
          <span aria-disabled="true" className={cn(itemClass, stepClass, 'text-muted-foreground')}>
            {nextContent}
          </span>
        ) : (
          renderLink({
            href: hrefFor(next),
            className: cn(linkClass, stepClass),
            children: nextContent,
          })
        )}
      </nav>
    )
  },
)
Pagination.displayName = 'Pagination'

export type { PaginationProps }
export { Pagination }
