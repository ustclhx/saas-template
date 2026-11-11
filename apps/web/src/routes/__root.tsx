import { themeInitScript } from '@saas/ui'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { ImpersonationBanner } from '../features/admin/impersonation-banner.tsx'
import { getAnnouncement } from '../features/admin/settings-announcement.functions.ts'
import { AnnouncementBanner } from '../features/admin/settings-announcement-banner.tsx'
import { ProductAnalytics } from '../features/analytics/analytics.tsx'
import { analyticsHeadScripts } from '../features/analytics/head.ts'
import { LanguageControls } from '../features/i18n/language-controls.tsx'
import { privateMeta } from '../features/seo/metadata.ts'
import {
  getPlausibleSite,
  getSafeImpersonation,
  getSeoOrigin,
} from '../features/seo/origin.functions.ts'
import { getHtmlAttributes } from '../features/theme/html-attributes.isomorphic.ts'
import { RootDocument } from '../features/theme/root-document.tsx'
import { templateConfig } from '../server/template-config.ts'
import appCss from '../styles/app.css?url'

export const Route = createRootRoute({
  beforeLoad: ({ location }) => ({
    htmlAttributes: getHtmlAttributes(location.pathname),
  }),
  loader: async () => {
    const [impersonation, announcement, appUrl, plausible] = await Promise.all([
      getSafeImpersonation(),
      getAnnouncement(),
      getSeoOrigin(),
      getPlausibleSite(),
    ])
    return { impersonation, announcement, appUrl, plausible }
  },
  staleTime: Infinity,
  head: ({ matches, loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'SaaS Template' },
      ...privateMeta(matches.at(-1)?.pathname ?? '/'),
    ],
    // 全局样式（Tailwind + @saas/ui 主题），SSR 输出的 <head> 中直接引用，避免首屏无样式闪烁
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
    ],
    // 首屏前按偏好（未设置时跟随系统）给 <html> 设置 dark 类：<head> 内同步执行，避免刷新时先浅后深的闪烁
    scripts: [
      { children: themeInitScript() },
      ...analyticsHeadScripts(
        matches.at(-1)?.pathname ?? '/',
        templateConfig,
        loaderData?.plausible,
      ),
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  const { impersonation, announcement } = Route.useLoaderData()
  const { htmlAttributes } = Route.useRouteContext()
  // 后台侧栏、认证页脚与工作台侧边栏布局自带控件，避免浮动控件遮挡正文。
  const hasInlineControls = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) =>
          match.routeId.startsWith('/(auth)/') ||
          // 只在工作台壳实际渲染时；空间不存在或出错时显示浮动控件
          (templateConfig.ui.appLayout === 'sidebar' &&
            match.routeId === '/app/$slug' &&
            match.status !== 'notFound' &&
            match.status !== 'error'),
      ) || /^\/admin(\/|$)/.test(state.location.pathname),
  })
  return (
    <RootDocument floatingControls={!hasInlineControls} htmlAttributes={htmlAttributes}>
      <ProductAnalytics />
      <ImpersonationBanner viewer={impersonation} />
      <AnnouncementBanner initial={announcement} />
      {templateConfig.i18n.enabled && !hasInlineControls && <LanguageControls />}
      <Outlet />
    </RootDocument>
  )
}
