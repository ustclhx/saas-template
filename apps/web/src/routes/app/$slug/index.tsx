import { createFileRoute, getRouteApi } from '@tanstack/react-router'
import { WorkspaceOverview } from '../../../features/app-shell/overview.tsx'
import { templateConfig } from '../../../server/template-config.ts'

const workspaceRoute = getRouteApi('/app/$slug')

// 工作台首页：只在侧边栏布局下渲染；顶部布局的空间信息仍在布局头部，这里保持空白（行为不变）
export const Route = createFileRoute('/app/$slug/')({
  component: WorkspaceHome,
})

function WorkspaceHome() {
  const page = workspaceRoute.useLoaderData()
  return templateConfig.ui.appLayout === 'sidebar' ? <WorkspaceOverview page={page} /> : null
}
