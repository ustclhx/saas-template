import { Link, Outlet } from '@tanstack/react-router'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { DailyCreditsNotice } from '../credits/daily-notice.tsx'
import { NotificationBell } from '../notifications/bell.tsx'
import { type WorkspacePage, WorkspaceSwitcher } from '../workspace/components.tsx'
import type { AppNavItem } from './nav.ts'
import { resolveAppNav, TEMPLATE_NAV_IDS } from './registry.ts'

function navLink(item: AppNavItem, slug: string) {
  return (
    <Link
      key={item.id}
      to={item.to as '/app/$slug'}
      params={{ slug }}
      {...(item.search && { search: item.search as never })}
      className="underline"
    >
      {item.label()}
    </Link>
  )
}

/** 原有顶部布局（ui.appLayout: 'topbar'），结构与文案保持不变；另渲染项目注册的导航条目。
 * 通知入口改为与侧边栏布局相同的铃铛，完整列表在首页 #notifications */
export function TopbarLayout({ page }: { page: WorkspacePage }) {
  const extraItems = resolveAppNav({
    role: page.role,
    readOnly: page.readOnly,
    isPersonal: page.workspace.isPersonal,
  })
    .flatMap((group) => group.items)
    .filter((item) => !(TEMPLATE_NAV_IDS as readonly string[]).includes(item.id))
  const topbarItems = extraItems
    .flatMap((item) => (item.topbarOrder === undefined ? [] : [{ item, order: item.topbarOrder }]))
    .sort((a, b) => a.order - b.order)
  return (
    <div className="mx-auto grid max-w-4xl gap-8 p-6">
      <header className="grid gap-4">
        <div className="flex items-center justify-between gap-4">
          <h1 data-testid="workspace-name" className="text-2xl font-semibold">
            {page.workspace.name}
          </h1>
          <NotificationBell />
        </div>
        <p>{page.workspace.isPersonal ? m.app_personal_workspace() : m.app_team_workspace()}</p>
        <p>{m.app_role({ role: page.role })}</p>
        <p data-testid="current-user">
          {page.user.name} ({page.user.email})
        </p>
        {page.readOnly ? <p role="status">{m.app_readonly()}</p> : null}
        <DailyCreditsNotice result={page.dailyCredits} />
        <WorkspaceSwitcher page={page} />
        <nav className="flex flex-wrap gap-4">
          {templateConfig.billing.enabled &&
          templateConfig.features.publicApi &&
          (page.role === 'owner' || page.role === 'admin') ? (
            <Link
              to="/app/$slug/api-keys"
              search={{ page: 0 }}
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              API Keys
            </Link>
          ) : null}
          {templateConfig.ai.text.enabled && (
            <Link to="/app/$slug/chat" params={{ slug: page.workspace.slug }} className="underline">
              {m.app_chat()}
            </Link>
          )}
          {topbarItems.map(({ item }) => navLink(item, page.workspace.slug))}
          <Link
            to="/app/$slug/settings"
            params={{ slug: page.workspace.slug }}
            className="underline"
          >
            {m.app_workspace_settings()}
          </Link>
          {templateConfig.billing.enabled && (
            <Link
              to="/app/$slug/billing"
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              {m.app_billing()}
            </Link>
          )}
          {templateConfig.credits.enabled && (
            <Link
              to="/app/$slug/usage"
              params={{ slug: page.workspace.slug }}
              className="underline"
            >
              {m.app_usage()}
            </Link>
          )}
          {extraItems
            .filter((item) => item.topbarOrder === undefined)
            .map((item) => navLink(item, page.workspace.slug))}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
