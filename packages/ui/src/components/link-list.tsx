// 模板新增（openspec seo-internal-linking 3.3，设计稿 docs/design-system/prototypes/seo-internal-linking/
// Main、Mobile.dc.html）：同组列表。纯文字链接，桌面两列、手机单列（行高 ≥ 44px），可带一个「查看全部」链接。
import { forwardRef, type HTMLAttributes, type ReactNode, useId } from 'react'
import { cn } from '../lib/utils.ts'
import {
  defaultRenderLink,
  type LinkZone,
  linkFocusClass,
  type RenderLink,
} from './link-render.tsx'

export interface LinkListItem {
  href: string
  /** 目标页的 titleMain / anchorShort */
  label: string
}

interface LinkListProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** 区块标题（h2），如「本系列其他课程」 */
  title: ReactNode
  items: readonly LinkListItem[]
  /** 「查看全部」：锚文本同样取目标（hub）页的主词，如「AI 写作入门（全部 9 课）」 */
  viewAll?: LinkListItem | null
  renderLink?: RenderLink
  /** data-link-zone，默认 siblings */
  zone?: LinkZone | null
  /**
   * 同组列表的 group key（页面的 `group` 字段），输出为 `data-link-group`；
   * 链接检查据此识别「声明了 group 的详情页」，同组区块应当传入
   */
  group?: string
}

/** items 为空时整块不渲染 */
const LinkList = forwardRef<HTMLElement, LinkListProps>(
  (
    {
      title,
      items,
      viewAll,
      renderLink = defaultRenderLink,
      zone = 'siblings',
      group,
      className,
      ...props
    },
    ref,
  ) => {
    const headingId = useId()
    if (items.length === 0) return null
    return (
      <section
        ref={ref}
        aria-labelledby={headingId}
        data-slot="link-list"
        data-link-zone={zone ?? undefined}
        data-link-group={group}
        // 「查看全部」只有一个元素：桌面在标题行右侧（caption），手机排到列表之后成为 44px 的一行（body）
        className={cn(
          'flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t pt-5 text-body md:gap-y-2 md:pt-6',
          className,
        )}
        {...props}
      >
        <h2
          id={headingId}
          className="m-0 min-w-0 font-semibold text-title text-foreground max-md:mb-1"
        >
          {title}
        </h2>
        <ul className="order-2 m-0 grid w-full list-none grid-cols-1 p-0 md:order-3 md:grid-cols-2 md:gap-x-6">
          {items.map((item) => (
            <li key={item.href} className="min-w-0">
              {renderLink({
                href: item.href,
                className: cn(
                  'flex min-h-11 items-center break-words rounded-sm text-foreground hover:underline underline-offset-3 md:block md:min-h-0 md:py-2',
                  linkFocusClass,
                ),
                children: item.label,
              })}
            </li>
          ))}
        </ul>
        {viewAll ? (
          <div className="order-3 w-full md:order-2 md:w-auto">
            {renderLink({
              href: viewAll.href,
              className: cn(
                'flex min-h-11 items-center rounded-sm text-primary-text hover:underline underline-offset-3 md:inline md:min-h-0 md:text-caption',
                linkFocusClass,
              ),
              children: viewAll.label,
            })}
          </div>
        ) : null}
      </section>
    )
  },
)
LinkList.displayName = 'LinkList'

export type { LinkListProps }
export { LinkList }
