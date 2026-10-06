import { createRouter } from '@tanstack/react-router'
import { localeRewrite } from './features/i18n/routing.ts'
import { routeTree } from './routeTree.gen'

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    rewrite: localeRewrite,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
