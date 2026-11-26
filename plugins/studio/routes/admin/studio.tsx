import { createFileRoute, useRouter } from '@tanstack/react-router'
import { adminListSearch } from '@web/features/admin/list.ts'
import { m } from '@web/paraglide/messages.js'
import { AdminStudioError, AdminStudioPage } from '../../src/web/admin-studio-page.tsx'
import { isStudioReviewQueue } from '../../src/web/admin-studio-queues.ts'
import { AdminStudioSkeleton } from '../../src/web/admin-studio-skeleton.tsx'
import { listAdminStudioWorks } from '../../src/web/moderation.functions.ts'

// 后台作品审核（add-media-studio 任务 7.2）：守卫沿用 /admin 布局与 adminMiddleware
export const Route = createFileRoute('/admin/studio')({
  validateSearch: (search: Record<string, unknown>) => {
    const { offset, queue } = adminListSearch(['queue'])(search)
    return isStudioReviewQueue(queue) && queue !== 'pending' ? { offset, queue } : { offset }
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    listAdminStudioWorks({ data: { queue: deps.queue ?? 'pending', offset: deps.offset } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.studio_admin_title() }] }),
  component: AdminStudioRoute,
  pendingComponent: AdminStudioSkeleton,
  errorComponent: AdminStudioRouteError,
})

function AdminStudioRoute() {
  const search = Route.useSearch()
  const queue = search.queue ?? 'pending'
  // 换栏或翻页后清空选择与逐行失败标记
  return (
    <AdminStudioPage
      key={`${queue}:${search.offset}`}
      data={Route.useLoaderData()}
      queue={queue}
      offset={search.offset}
    />
  )
}

function AdminStudioRouteError() {
  const router = useRouter()
  return <AdminStudioError onRetry={() => void router.invalidate()} />
}
