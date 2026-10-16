import { DataTable } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage } from '../../../features/admin/ui.tsx'
import { getAdminWorkspaces } from '../../../features/admin/workspaces.functions.ts'

export const Route = createFileRoute('/admin/workspaces/')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['q', 'status'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    getAdminWorkspaces({
      data: {
        ...deps,
        status: deps.status === 'active' || deps.status === 'deleted' ? deps.status : undefined,
      },
    }),
  component: Workspaces,
})
function Workspaces() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title="Workspaces">
      <DataTable
        label="Workspaces"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'name',
            header: 'Name',
            cell: (row) => (
              <Link to="/admin/workspaces/$id" params={{ id: row.id }} className="underline">
                {row.name}
              </Link>
            ),
          },
          { id: 'id', header: 'ID', cell: (row) => row.id },
          { id: 'slug', header: 'Slug', cell: (row) => row.slug },
          { id: 'kind', header: 'Type', cell: (row) => (row.isPersonal ? 'Personal' : 'Team') },
          { id: 'status', header: 'Status', cell: (row) => (row.deletedAt ? 'Deleted' : 'Active') },
        ]}
        page={adminListPage(search.offset, data)}
        filterValues={{ q: search.q, status: search.status }}
        filters={[
          { id: 'q', label: 'Search workspaces', placeholder: 'Name, slug or ID' },
          {
            id: 'status',
            label: 'Status',
            type: 'select',
            options: [
              { value: '', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'deleted', label: 'Deleted' },
            ],
          },
        ]}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) =>
          void navigate({ search: filtersToSearch(['q', 'status'], values) })
        }
      />
    </AdminPage>
  )
}
