import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { WorkspaceOverview } from '../../../features/app-shell/overview.tsx'
import { NotificationCenter } from '../../../features/notifications/center.tsx'
import { templateConfig } from '../../../server/template-config.ts'

const workspaceRoute = getRouteApi('/app/$slug')

// 工作台首页：侧边栏布局渲染概览；顶部布局的空间信息仍在布局头部。两种布局都在这里放通知区，
// 作为顶部条铃铛「查看全部通知」的落点（#notifications，评审清单 #90 方案 A）
export const Route = createFileRoute('/app/$slug/')({
  component: WorkspaceHome,
})

function WorkspaceHome() {
  const page = workspaceRoute.useLoaderData()
  if (templateConfig.ui.appLayout !== 'sidebar') return <NotificationCenter />
  return (
    <div className="flex flex-col gap-6">
      {/* 还没有任何通知时不渲染（empty:hidden 去掉占位的间距） */}
      <div className="empty:hidden print:hidden">
        <NotificationCenter hideWhenEmpty />
      </div>
      <WorkspaceOverview page={page} />
    </div>
  )
}
