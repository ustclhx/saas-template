import { createRouter } from '@tanstack/react-router'
import { createIsomorphicFn } from '@tanstack/react-start'
import { localeRewrite } from './features/i18n/routing.ts'
import { routeTree } from './routeTree.gen'
import { securityNonce } from './security-context.server.ts'
import { templateConfig } from './server/template-config.ts'

const getNonce = createIsomorphicFn()
  .server(() => securityNonce())
  .client(() => undefined)

export function getRouter() {
  // 保留文件路由类型供同一源码编译；关闭模块的页面不加入运行时路由树。
  if (!templateConfig.marketing.enabled) {
    routeTree.addChildren(
      Object.values(routeTree.children ?? {}).filter(
        (route) =>
          !/^\/(?:pricing|blog|docs|legal|newsletter|waitlist|api\/(?:newsletter|waitlist)|sitemap\.xml|robots\.txt)(?:\/|$)/.test(
            route.options.path ?? '',
          ),
      ),
    )
  }
  const nonce = getNonce()
  return createRouter({
    routeTree,
    ...(nonce ? { ssr: { nonce } } : {}),
    scrollRestoration: true,
    rewrite: localeRewrite,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
