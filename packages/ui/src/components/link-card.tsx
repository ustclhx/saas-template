// 模板新增（openspec seo-internal-linking 3.3，设计稿 docs/design-system/prototypes/seo-internal-linking/
// Main、Mobile、Hub、States.dc.html）：内链卡片 LinkCard，以及用它组合的相关区块 LinkCardGrid 与系列导航 SeriesNav。
// 锚文本（title）由调用方取目标页的 titleMain / anchorShort，组件不接受也不生成自由文本。
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { forwardRef, type HTMLAttributes, type ReactNode, useId } from 'react'
import { fontWeights } from '../lib/font-weight.ts'
import { cn } from '../lib/utils.ts'
import {
  defaultRenderLink,
  type LinkZone,
  linkFocusClass,
  type RenderLink,
} from './link-render.tsx'

interface LinkCardProps {
  href: string
  /** 锚文本：目标页的 titleMain 或 anchorShort */
  title: string
  /** 可选一行说明（caption） */
  description?: ReactNode
  /** 标题上方的小字，如系列方向「上一篇」、列表日期 */
  eyebrow?: ReactNode
  /** end：右对齐（系列导航的下一篇，仅 ≥ 768px） */
  align?: 'start' | 'end'
  renderLink?: RenderLink
  className?: string
}

/** 单张内链卡片：整张卡片是一个 <a href>（card 底、border 外框、radius-xl） */
function LinkCard({
  href,
  title,
  description,
  eyebrow,
  align = 'start',
  renderLink = defaultRenderLink,
  className,
}: LinkCardProps) {
  return renderLink({
    href,
    className: cn(
      'group flex min-w-0 flex-col rounded-xl border bg-card px-4 py-3.5 text-body text-card-foreground md:py-4',
      // 只有方向标签加标题时更紧凑（系列卡片 4px），带说明时桌面 6px（相关文章卡片）
      eyebrow != null && description == null ? 'gap-1' : 'gap-1 md:gap-1.5',
      align === 'end' && 'md:items-end md:text-right',
      linkFocusClass,
      className,
    ),
    children: (
      <>
        {eyebrow != null ? (
          <span className="flex items-center gap-1 text-caption text-muted-foreground">
            {eyebrow}
          </span>
        ) : null}
        <span
          // fontVariationSettings 只作用于 Inter，中文回退字体需要 font-semibold 才会加粗（同 DialogTitle）
          className="break-words font-semibold underline-offset-3 group-hover:underline"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {title}
        </span>
        {description != null ? (
          <span className="text-caption text-muted-foreground">{description}</span>
        ) : null}
      </>
    ),
  })
}

export interface LinkCardItem {
  href: string
  title: string
  description?: ReactNode
  eyebrow?: ReactNode
}

interface LinkCardGridProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  items: readonly LinkCardItem[]
  /** 区块标题（如「相关文章」，h2）；省略时不输出标题，例如 hub 列表上方已有 H1 */
  title?: ReactNode
  /** ≥ 768px 的列数：相关文章 3 列，hub 列表 2 列；手机始终单列 */
  columns?: 2 | 3
  renderLink?: RenderLink
  /** data-link-zone，默认 related；hub 列表传 null 按正文统计 */
  zone?: LinkZone | null
}

/** 卡片区块：相关文章、hub 下级列表。items 为空时整块不渲染（不出现空标题或「暂无」） */
const LinkCardGrid = forwardRef<HTMLElement, LinkCardGridProps>(
  (
    {
      items,
      title,
      columns = 3,
      renderLink = defaultRenderLink,
      zone = 'related',
      className,
      ...props
    },
    ref,
  ) => {
    const headingId = useId()
    if (items.length === 0) return null
    const hasTitle = title != null
    return (
      <section
        ref={ref}
        data-slot="link-card-grid"
        data-link-zone={zone ?? undefined}
        aria-labelledby={hasTitle ? headingId : undefined}
        className={cn('flex min-w-0 flex-col gap-2.5 md:gap-3', className)}
        {...props}
      >
        {hasTitle ? (
          <h2 id={headingId} className="m-0 font-semibold text-title text-foreground">
            {title}
          </h2>
        ) : null}
        <ul
          className={cn(
            'm-0 grid list-none grid-cols-1 gap-2.5 p-0 md:gap-3',
            columns === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2',
          )}
        >
          {items.map((item) => (
            <li key={item.href} className="flex min-w-0">
              <LinkCard {...item} renderLink={renderLink} className="w-full" />
            </li>
          ))}
        </ul>
      </section>
    )
  },
)
LinkCardGrid.displayName = 'LinkCardGrid'

export interface SeriesNavLink {
  href: string
  /** 目标页的 titleMain / anchorShort */
  title: string
  /** 方向标签，如「上一篇」「下一篇」，由调用方按语言传入 */
  label: string
}

interface SeriesNavProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** nav 的可读名称（如「系列导航」） */
  label: string
  /** 系列第一篇不传 */
  previous?: SeriesNavLink | null
  /** 系列最后一篇不传 */
  next?: SeriesNavLink | null
  renderLink?: RenderLink
  /** data-link-zone，默认 series */
  zone?: LinkZone | null
}

/**
 * 系列上一篇 / 下一篇：≥ 768px 两列，下一篇右对齐；手机上下堆叠。
 * 缺少的一侧不显示禁用态卡片，桌面保留网格占位（States ①）；两侧都没有时不渲染。
 */
const SeriesNav = forwardRef<HTMLElement, SeriesNavProps>(
  (
    { label, previous, next, renderLink = defaultRenderLink, zone = 'series', className, ...props },
    ref,
  ) => {
    if (!previous && !next) return null
    const placeholder = <div aria-hidden="true" className="max-md:hidden" />
    return (
      <nav
        ref={ref}
        aria-label={label}
        data-slot="series-nav"
        data-link-zone={zone ?? undefined}
        className={cn('grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2 md:gap-4', className)}
        {...props}
      >
        {previous ? (
          <LinkCard
            href={previous.href}
            title={previous.title}
            eyebrow={
              <>
                <ChevronLeft aria-hidden="true" className="size-3" />
                {previous.label}
              </>
            }
            renderLink={renderLink}
            className="min-h-16"
          />
        ) : (
          placeholder
        )}
        {next ? (
          <LinkCard
            href={next.href}
            title={next.title}
            eyebrow={
              <>
                {next.label}
                <ChevronRight aria-hidden="true" className="size-3" />
              </>
            }
            align="end"
            renderLink={renderLink}
            className="min-h-16"
          />
        ) : (
          placeholder
        )}
      </nav>
    )
  },
)
SeriesNav.displayName = 'SeriesNav'

export type { LinkCardGridProps, LinkCardProps, SeriesNavProps }
export { LinkCard, LinkCardGrid, SeriesNav }
