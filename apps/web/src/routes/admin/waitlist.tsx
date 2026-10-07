import { Button, DataTable } from '@saas/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ADMIN_PAGE_SIZE, adminListPage, adminListSearch } from '../../features/admin/list.ts'
import { getAdminWaitlist, inviteAdminWaitlist } from '../../features/growth/growth.functions.ts'
export const Route = createFileRoute('/admin/waitlist')({
  validateSearch: (search) => ({ offset: adminListSearch([])(search).offset }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminWaitlist({ data: deps }),
  component: WaitlistAdmin,
})
function WaitlistAdmin() {
  const data = Route.useLoaderData()
  const { offset } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  return (
    <section className="grid gap-4">
      <h2 className="text-xl font-semibold">Waitlist</h2>
      <Button
        disabled={busy || selected.length === 0}
        onClick={async () => {
          setBusy(true)
          try {
            const result = await inviteAdminWaitlist({ data: { ids: selected } })
            setMessage(`${result.count} invitations queued.`)
            setSelected([])
            await router.invalidate()
          } catch {
            setMessage('Invitations could not all be queued. Select the same addresses to retry.')
          } finally {
            setBusy(false)
          }
        }}
      >
        Invite selected ({selected.length})
      </Button>
      <p role="status">{message}</p>
      <DataTable
        label="Waitlist"
        rows={data.rows}
        getRowId={(row) => row.id}
        page={adminListPage(offset, data)}
        onPageChange={(page) => {
          setSelected([])
          void navigate({ search: { offset: page * ADMIN_PAGE_SIZE } })
        }}
        columns={[
          {
            id: 'select',
            header: 'Select',
            cell: (row) => (
              <input
                aria-label={`Select ${row.email}`}
                type="checkbox"
                checked={selected.includes(row.id)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id),
                  )
                }
              />
            ),
          },
          { id: 'email', header: 'Email', cell: (row) => row.email },
          { id: 'created', header: 'Joined', cell: (row) => row.createdAt.toLocaleDateString() },
          {
            id: 'invited',
            header: 'Invited',
            cell: (row) => row.invitedAt?.toLocaleDateString() ?? 'Awaiting invitation',
          },
        ]}
      />
    </section>
  )
}
