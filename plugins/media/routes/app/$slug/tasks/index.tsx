import { createFileRoute } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { MediaTasksPage } from '../../../../src/web/ai-media/tasks-page.tsx'

export const Route = createFileRoute('/app/$slug/tasks/')({
  head: () => ({ meta: [{ title: m.media_tasks_title() }] }),
  component: TasksPage,
})

function TasksPage() {
  const { workspacePage } = Route.useRouteContext()
  return <MediaTasksPage key={workspacePage.workspace.id} page={workspacePage} />
}
