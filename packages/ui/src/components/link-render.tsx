// 模板新增（openspec seo-internal-linking 组 3）：内链组件共用的链接渲染约定与区域标记。
// 组件默认输出原生 <a href>；需要客户端导航时调用方传 renderLink，换成路由的 Link（必须仍渲染为带 href 的 <a>，
// 链接图检查只计入 <a href>，见 design.md 决策 3 与 spec「只有真实链接计入链接图」）。
import type { ReactElement, ReactNode } from 'react'

/** renderLink 收到的属性：原样展开到最终的 <a> 上 */
export interface LinkRenderProps {
  href: string
  className: string
  children: ReactNode
  'aria-label'?: string
}

/**
 * 自定义链接渲染，例如 TanStack Router：
 * `renderLink={({ href, ...props }) => <Link to={href} {...props} />}`
 */
export type RenderLink = (props: LinkRenderProps) => ReactElement

/**
 * `data-link-zone` 的取值：`nav`（导航层，如面包屑）、`series`、`related`、`siblings`；
 * 衍生项目可以用自己的区域名。传 `null` 不输出该属性（按正文统计）。
 */
export type LinkZone = 'nav' | 'series' | 'related' | 'siblings' | (string & {})

export const defaultRenderLink: RenderLink = (props) => <a {...props} />

/** 内链文字链接的统一焦点环（2px 描边加 2px 间隙，同 UPSTREAM.md 统一适配规则 9） */
export const linkFocusClass =
  'outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)'
