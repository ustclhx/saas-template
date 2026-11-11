import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/**
 * 模板配置里的链接：站内路径走路由器 Link（客户端导航，并由 localeRewrite 按当前语言加前缀），
 * 页内锚点、带查询参数的地址与外部地址用普通 <a>。
 */
export function ConfigLink({
  href,
  ...props
}: {
  href: string
  className?: string
  'aria-label'?: string
  children: ReactNode
}) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    const url = new URL(href, 'http://local')
    if (!url.search) {
      // 配置中的路径是字符串，无法在类型层面对应到具体路由；运行时由路由器按路径匹配
      const to = url.pathname as '/'
      return url.hash ? (
        <Link to={to} hash={url.hash.slice(1)} {...props} />
      ) : (
        <Link to={to} {...props} />
      )
    }
  }
  return <a href={href} {...props} />
}
