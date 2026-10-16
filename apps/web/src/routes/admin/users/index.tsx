import { DataTable } from '@saas/ui'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage } from '../../../features/admin/ui.tsx'
import { getAdminUsers } from '../../../features/admin/users.functions.ts'

export const Route = createFileRoute('/admin/users/')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['q'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminUsers({ data: deps }),
  component: Users,
})
function Users() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage title="Users">
      <DataTable
        label="Users"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'email',
            header: 'Email',
            cell: (row) => (
              <Link to="/admin/users/$id" params={{ id: row.id }} className="underline">
                {row.email}
              </Link>
            ),
          },
          { id: 'name', header: 'Name', cell: (row) => row.name },
          { id: 'id', header: 'ID', cell: (row) => row.id },
          { id: 'role', header: 'Role', cell: (row) => row.role ?? 'user' },
          { id: 'ban', header: 'Ban status', cell: (row) => (row.banned ? 'Banned' : 'Active') },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[{ id: 'q', label: 'Search users', placeholder: 'Email, name or ID' }]}
        filterValues={{ q: search.q }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) => void navigate({ search: filtersToSearch(['q'], values) })}
      />
    </AdminPage>
  )
}
