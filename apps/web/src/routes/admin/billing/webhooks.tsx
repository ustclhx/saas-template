import { DataTable } from '@saas/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { getAdminWebhooks, replayAdminWebhook } from '../../../features/billing/admin.functions.ts'

export const Route = createFileRoute('/admin/billing/webhooks')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminWebhooks({ data: deps }),
  component: Webhooks,
})
function Webhooks() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function replay(id: string) {
    setBusy(true)
    try {
      const result = await replayAdminWebhook({ data: { webhookEventId: id } })
      setMessage(result.ok ? result.status : `Replay unavailable (${result.error}).`)
      await router.invalidate()
    } catch {
      setMessage('Replay unavailable. Reload to check the saved record.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-5">
      <h2 className="font-semibold text-xl">Webhook events</h2>
      <p role="status">{message}</p>
      <p>Events without an associated workspace appear only when no workspace filter is set.</p>
      <DataTable
        label="Webhook events"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'provider', header: 'Provider', cell: (row) => row.provider },
          { id: 'event', header: 'Event', cell: (row) => row.providerEventId },
          { id: 'type', header: 'Type', cell: (row) => row.type },
          { id: 'status', header: 'Status', cell: (row) => row.status },
          { id: 'attempts', header: 'Attempts', cell: (row) => row.attempts },
          {
            id: 'replay',
            header: 'Replay',
            cell: (row) =>
              row.status === 'failed' ? (
                <button
                  type="button"
                  disabled={busy || !row.replayAvailable}
                  onClick={() => void replay(row.id)}
                >
                  {row.replayAvailable
                    ? 'Replay failed event'
                    : 'Replay unavailable — provider not configured'}
                </button>
              ) : (
                'Only failed events can be replayed'
              ),
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
