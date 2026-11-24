import { createFileRoute } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { MediaTaskDetailPage } from '../../../../src/web/ai-media/tasks-page.tsx'

export const Route = createFileRoute('/app/$slug/tasks/$taskId')({
  head: () => ({ meta: [{ title: m.media_tasks_detail() }] }),
  component: TaskDetail,
})

function TaskDetail() {
  const { workspacePage } = Route.useRouteContext()
  const { taskId } = Route.useParams()
  return (
    <MediaTaskDetailPage
      key={`${workspacePage.workspace.id}:${taskId}`}
      page={workspacePage}
      taskId={taskId}
    />
  )
}
