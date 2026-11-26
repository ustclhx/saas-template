import { AdminPage, panelClass } from '@web/features/admin/ui.tsx'
import { m } from '@web/paraglide/messages.js'

// 作品审核页的加载骨架。pendingComponent 会进入水合入口，单独成文件，不随审核页带入 DataTable。
export function AdminStudioSkeleton() {
  return (
    <AdminPage title={m.studio_admin_title()} description={m.studio_admin_description()}>
      <div className="grid gap-3" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className={panelClass('default', 'grid-cols-[auto_1fr] items-center')}>
            <div className="size-12 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <div className="grid gap-2">
              <div className="h-4 w-3/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <div className="h-4 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    </AdminPage>
  )
}
