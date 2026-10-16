import { DataTable } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage } from '../../../features/admin/ui.tsx'
import { getAdminBilling } from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminBilling({ data: deps }),
  errorComponent: () => <p role="alert">Billing data is unavailable. Please reload.</p>,
  component: BillingAdmin,
})
function BillingAdmin() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title="Billing administration">
      <div className="grid gap-2 rounded-lg border bg-card p-4 text-sm">
        <p>
          <span className="text-muted-foreground">Payment mode:</span>{' '}
          <span className="font-medium">{data.mode}</span>
        </p>
        <ul className="grid gap-1">
          {data.readiness.map((item) => (
            <li key={item.id} className="break-words">
              {item.id}:{' '}
              <span className={item.available ? 'text-success' : 'text-muted-foreground'}>
                {item.available ? 'Configured' : 'Unavailable — provider is not configured'}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <DataTable
        label="Payments"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'workspace', header: 'Workspace', cell: (row) => row.workspaceId },
          { id: 'provider', header: 'Provider', cell: (row) => row.provider },
          { id: 'amount', header: 'Amount', cell: (row) => adminMoney(row.amount, row.currency) },
          {
            id: 'refunded',
            header: 'Refunded',
            cell: (row) => adminMoney(row.refundedAmount, row.currency),
          },
          { id: 'status', header: 'Status', cell: (row) => row.status },
          { id: 'kind', header: 'Kind', cell: (row) => row.kind },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[{ id: 'workspaceId', label: 'Workspace ID' }]}
        filterValues={{ workspaceId: search.workspaceId }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) =>
          void navigate({ search: filtersToSearch(['workspaceId'], values) })
        }
      />
    </AdminPage>
  )
}
