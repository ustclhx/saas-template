import { themeInitScript } from '@saas/ui'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { ImpersonationBanner } from '../features/admin/impersonation-banner.tsx'
import { getAnnouncement } from '../features/admin/settings-announcement.functions.ts'
import { AnnouncementBanner } from '../features/admin/settings-announcement-banner.tsx'
import { ProductAnalytics } from '../features/analytics/analytics.tsx'
import { analyticsHeadScripts } from '../features/analytics/head.ts'
import { isAppAreaPath } from '../features/i18n/app-area.ts'
import { LanguageAssist } from '../features/i18n/language-assist.tsx'
import { LanguageControls } from '../features/i18n/language-controls.tsx'
import { ErrorPage } from '../features/marketing/not-found.tsx'
import { privateMeta } from '../features/seo/metadata.ts'
import {
  getPlausibleSite,
  getSafeImpersonation,
  getSeoOrigin,
} from '../features/seo/origin.functions.ts'
import { getHtmlAttributes } from '../features/theme/html-attributes.isomorphic.ts'
import { RootDocument } from '../features/theme/root-document.tsx'
import { SiteSettings } from '../features/theme/site-settings.tsx'
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
  errorComponent: RootErrorComponent,
})

/**
 * 根路由自身出错时（beforeLoad / loader / 渲染）会替换整个 RootComponent，这里补上 HTML 外壳，
 * 仍显示带站点导航的错误界面而不是框架默认错误页（public-site-availability）。
 */
function RootErrorComponent() {
  const htmlAttributes = useRouterState({
    select: (state) =>
      (state.matches[0]?.context as { htmlAttributes?: Record<string, string> } | undefined)
        ?.htmlAttributes,
  })
  return (
    <RootDocument floatingControls htmlAttributes={htmlAttributes ?? {}}>
      <ErrorPage />
    </RootDocument>
  )
}

function RootComponent() {
  const { impersonation, announcement } = Route.useLoaderData()
  const { htmlAttributes } = Route.useRouteContext()
  // 后台侧栏、认证页脚与工作台侧边栏布局自带控件，路由也可用 staticData.floatingControls = false 声明不需要，
  // 避免浮动控件遮挡正文。
  const hasInlineControls = useRouterState({
    select: (state) =>
      state.matches.some(
        (match) =>
          match.routeId.startsWith('/(auth)/') ||
          match.staticData.floatingControls === false ||
          // 只在工作台壳实际渲染时；空间不存在或出错时显示浮动控件
          (templateConfig.ui.appLayout === 'sidebar' &&
            match.routeId === '/app/$slug' &&
            match.status !== 'notFound' &&
            match.status !== 'error'),
      ) || /^\/admin(\/|$)/.test(state.location.pathname),
  })
  const publicPage = useRouterState({
    select: (state) => !isAppAreaPath(state.location.pathname),
  })
  return (
    <RootDocument floatingControls={!hasInlineControls} htmlAttributes={htmlAttributes}>
      <ProductAnalytics />
      <ImpersonationBanner viewer={impersonation} />
      <AnnouncementBanner initial={announcement} />
      {templateConfig.i18n.enabled && !hasInlineControls && <LanguageControls />}
      <Outlet />
      {/* 语言提示条与首页记住语言：只在公开页、水合后挂载，服务端 HTML 中没有（multilingual-seo 4.2、4.4） */}
      {templateConfig.i18n.enabled && publicPage && <LanguageAssist />}
      {/* 手机端没有站点页脚的公开页：设置行放在页面末尾，底部留 80px 给右下悬浮按钮；有页脚时由页脚渲染，这里隐藏 */}
      {!hasInlineControls && (
        <SiteSettings className="border-t px-4 pt-4 pb-20 md:hidden print:hidden [body:has([data-site-footer])_&]:hidden" />
      )}
    </RootDocument>
  )
}
