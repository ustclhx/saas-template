import { createFileRoute } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { ConfirmationPage } from '../../src/web/confirmation-page.tsx'
import { getAdminConfirmation } from '../../src/web/confirmations.functions.ts'

// 后台确认 AI 发起的操作（openspec add-admin-step-up 任务 4.3）。MCP 返回的 confirmUrl 指向这里；
// 守卫沿用 /admin 布局与 adminMiddleware，查看不要求重新验证，确认执行时才要求。
export const Route = createFileRoute('/admin/confirm/$id')({
  loader: ({ params }) => getAdminConfirmation({ data: { id: params.id } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.admin_confirm_page_title() }] }),
  component: ConfirmRoute,
})

function ConfirmRoute() {
  return <ConfirmationPage data={Route.useLoaderData()} />
}
