import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'

const router = vi.hoisted(() => ({ pathname: '/blog', invalidate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useRouter: () => ({ invalidate: router.invalidate }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: router.pathname } }),
}))
// 营销页头页脚有自己的数据与测试，这里只确认是否套用
vi.mock('./marketing-shell.tsx', () => ({
  MarketingShell: ({ children }: { children: ReactNode }) => <div data-shell="">{children}</div>,
}))

import { ErrorPage, NotFoundPage } from './not-found.tsx'

beforeEach(() => {
  router.pathname = '/blog'
})

describe('兜底错误界面（public-site-availability）', () => {
  it('公开页显示带站点导航的错误界面、返回首页与重试，不显示错误详情', () => {
    const html = renderToStaticMarkup(<ErrorPage />)
    expect(html).toContain(m.marketing_error_title())
    expect(html).toContain(m.marketing_error_body())
    expect(html).toContain(m.marketing_error_retry())
    expect(html).toContain(
      `href="${templateConfig.marketing.enabled ? '/' : '/app'}">${m.marketing_not_found_home()}`,
    )
    expect(html.includes('data-shell')).toBe(templateConfig.marketing.enabled)
  })

  it('应用区内的错误返回应用首页', () => {
    router.pathname = '/app/demo'
    const html = renderToStaticMarkup(<ErrorPage />)
    expect(html).toContain(`href="/app">${m.marketing_not_found_home()}`)
  })

  it('404 页沿用同一布局', () => {
    const html = renderToStaticMarkup(<NotFoundPage />)
    expect(html).toContain(m.marketing_not_found_title())
    expect(html).not.toContain(m.marketing_error_retry())
  })
})
