import type { ReactNode } from 'react'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

// 项目覆盖 root-fallbacks.project.tsx 后，根路由与路由器默认界面都改用项目组件
vi.mock('./root-fallbacks.project.tsx', () => ({
  RootNotFound: () => <p>project-not-found</p>,
  RootError: () => <p>project-error</p>,
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useRouterState: () => undefined,
}))
vi.mock('../theme/root-document.tsx', () => ({
  RootDocument: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))

import { Route } from '../../routes/__root.tsx'
import { RootError, RootNotFound } from './root-fallbacks.project.tsx'

describe('根 404 / 错误界面可由项目覆盖', () => {
  it('根路由的 notFoundComponent 使用项目组件', () => {
    expect(Route.options.notFoundComponent).toBe(RootNotFound)
  })

  it('根路由出错时在 HTML 外壳中渲染项目错误界面', () => {
    const component = Route.options.errorComponent as () => ReactNode
    const html = renderToStaticMarkup(createElement(component))
    expect(html).toBe('<main><p>project-error</p></main>')
    expect(RootError).toBeTypeOf('function')
  })
})
