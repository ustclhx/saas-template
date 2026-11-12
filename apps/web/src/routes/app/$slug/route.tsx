import { createFileRoute } from '@tanstack/react-router'
import { SidebarLayout } from '../../../features/app-shell/sidebar-layout.tsx'
import { readSidebarOpen } from '../../../features/app-shell/sidebar-state.ts'
import { TopbarLayout } from '../../../features/app-shell/topbar-layout.tsx'
import { NotificationsProvider } from '../../../features/notifications/store.tsx'
import { getWorkspacePage } from '../../../features/workspace/workspace.functions.ts'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/app/$slug')({
  beforeLoad: async ({ params }) => ({
    workspacePage: await getWorkspacePage({ data: { slug: params.slug } }),
    // 折叠状态：首屏服务端读 cookie 直接按状态渲染，避免闪动（tasks 8.3）
    sidebarOpen: readSidebarOpen(),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.workspace.name} · Workspace` }] : [],
  }),
  component: WorkspaceLayout,
  notFoundComponent: () => (
    <main>
      <h1>{m.app_workspace_not_found()}</h1>
      <p>{m.app_workspace_no_access()}</p>
      <a href="/app">{m.app_go_workspace()}</a>
    </main>
  ),
})

function WorkspaceLayout() {
  const page = Route.useLoaderData()
  const { sidebarOpen } = Route.useRouteContext()
  // 顶部条铃铛与首页通知区共用一份通知数据与 30 秒轮询（评审清单 #90），按空间重建
  return (
    <NotificationsProvider key={page.workspace.slug} slug={page.workspace.slug}>
      {templateConfig.ui.appLayout === 'sidebar' ? (
        <SidebarLayout page={page} defaultOpen={sidebarOpen} />
      ) : (
        <TopbarLayout page={page} />
      )}
    </NotificationsProvider>
  )
}
