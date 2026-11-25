import { AdminPage, panelClass } from '@web/features/admin/ui.tsx'
import { m } from '@web/paraglide/messages.js'

// 待确认列表的加载骨架。pendingComponent 不在 TanStack 默认的按路由拆包范围内，会进入水合入口，
// 因此单独成文件，不随列表页带入 DataTable 与列表逻辑。
export function ConfirmationsSkeleton() {
  return (
    <AdminPage
      title={m.admin_confirm_list_title()}
      description={m.admin_confirm_list_description()}
    >
      <div className="grid gap-3" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className={panelClass('default', 'gap-2')}>
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-4 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </AdminPage>
  )
}
