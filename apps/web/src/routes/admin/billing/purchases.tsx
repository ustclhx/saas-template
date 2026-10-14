import { DataTable } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { getAdminPurchases } from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/purchases')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminPurchases({ data: deps }),
  component: List,
})
function List() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="grid gap-5">
      <h2 className="font-semibold text-xl">One-time purchases</h2>
      <DataTable
        label="One-time purchases"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'id', header: 'ID', cell: (row) => row.id },
          { id: 'workspace', header: 'Workspace', cell: (row) => row.workspaceId },
          { id: 'provider', header: 'Provider', cell: (row) => row.provider },
          { id: 'status', header: 'Status', cell: (row) => row.status },
          { id: 'amount', header: 'Amount', cell: (row) => adminMoney(row.amount, row.currency) },
          {
            id: 'paid',
            header: 'Paid at',
            cell: (row) => (row.paidAt ? new Date(row.paidAt).toLocaleString() : '—'),
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
    </section>
  )
}
