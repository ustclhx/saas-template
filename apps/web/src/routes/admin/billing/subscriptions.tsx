import { DataTable } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage } from '../../../features/admin/ui.tsx'
import { getAdminSubscriptions } from '../../../features/billing/admin.functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/subscriptions')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminSubscriptions({ data: deps }),
  component: List,
})
function List() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title="Subscriptions">
      <DataTable
        label="Subscriptions"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'id', header: 'ID', cell: (row) => row.id },
          { id: 'workspace', header: 'Workspace', cell: (row) => row.workspaceId },
          { id: 'provider', header: 'Provider', cell: (row) => row.provider },
          { id: 'status', header: 'Status', cell: (row) => row.status },
          {
            id: 'cancel',
            header: 'Cancellation',
            cell: (row) => (row.cancelAtPeriodEnd ? 'At period end' : 'None scheduled'),
          },
          {
            id: 'start',
            header: 'Period start',
            cell: (row) =>
              row.currentPeriodStart ? new Date(row.currentPeriodStart).toLocaleString() : '—',
          },
          {
            id: 'end',
            header: 'Period end',
            cell: (row) =>
              row.currentPeriodEnd ? new Date(row.currentPeriodEnd).toLocaleString() : '—',
          },
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
