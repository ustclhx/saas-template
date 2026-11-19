// 模板新增（openspec seo-internal-linking 3.1，设计稿 docs/design-system/prototypes/seo-internal-linking/
// Main、Mobile、Hub、States.dc.html）：公开页面包屑。只负责可见链接；BreadcrumbList JSON-LD 由页面层输出。
import { ChevronRight } from 'lucide-react'
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from '../lib/utils.ts'
import {
  defaultRenderLink,
  type LinkZone,
  linkFocusClass,
  type RenderLink,
} from './link-render.tsx'

export interface BreadcrumbItem {
  /** 上级页面的锚文本（取目标页 titleMain / anchorShort） */
  label: string
  href: string
}

interface BreadcrumbProps extends HTMLAttributes<HTMLElement> {
  /** nav 的可读名称（如「面包屑」），由调用方按语言传入 */
  label: string
  /** 从首页起的全部上级，按层级顺序 */
  items: readonly BreadcrumbItem[]
  /** 当前页名称：不是链接，带 aria-current="page"；< 768px 隐藏（当前页标题即下方 H1） */
  current: ReactNode
  renderLink?: RenderLink
  /** data-link-zone，默认 nav；null 不输出 */
  zone?: LinkZone | null
}

const Breadcrumb = forwardRef<HTMLElement, BreadcrumbProps>(
  (
    { label, items, current, renderLink = defaultRenderLink, zone = 'nav', className, ...props },
    ref,
  ) => {
    const last = items.length - 1
    return (
      <nav
        ref={ref}
        aria-label={label}
        data-slot="breadcrumb"
        data-link-zone={zone ?? undefined}
        className={cn('min-w-0 text-caption text-muted-foreground', className)}
        {...props}
      >
        {/* 不换行：桌面只截断当前项；手机只显示到上一级，最后一级上级放不下时截断 */}
        <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0">
          {items.map((item, index) => (
            <BreadcrumbAncestor
              key={item.href}
              item={item}
              shrink={index === last}
              separator={index > 0}
              renderLink={renderLink}
            />
          ))}
          {last >= 0 ? <Separator className="max-md:hidden" /> : null}
          {/* 只截断当前项，上级不截断（States ③） */}
          <li
            aria-current="page"
            className="min-w-0 max-w-md truncate text-foreground max-md:hidden"
          >
            {current}
          </li>
        </ol>
      </nav>
    )
  },
)
Breadcrumb.displayName = 'Breadcrumb'

function BreadcrumbAncestor({
  item,
  shrink,
  separator,
  renderLink,
}: {
  item: BreadcrumbItem
  /** 手机上最后一级上级可截断（Mobile 画板），其余上级保持完整 */
  shrink: boolean
  separator: boolean
  renderLink: RenderLink
}) {
  return (
    <>
      {separator ? <Separator /> : null}
      <li className={cn('shrink-0', shrink && 'max-md:min-w-0 max-md:shrink')}>
        {renderLink({
          href: item.href,
          // 手机上撑到 24px 触控高度（Mobile 画板 min-height: 24px）
          className: cn(
            'block whitespace-nowrap rounded-sm py-1 hover:underline underline-offset-3 md:py-0',
            shrink && 'max-md:truncate',
            linkFocusClass,
          ),
          children: item.label,
        })}
      </li>
    </>
  )
}

function Separator({ className }: { className?: string }) {
  return (
    <li aria-hidden="true" className={cn('flex shrink-0 items-center', className)}>
      <ChevronRight className="size-3" />
    </li>
  )
}

export type { BreadcrumbProps }
export { Breadcrumb }
