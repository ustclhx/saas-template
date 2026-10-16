import { Button, DataTable } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage } from '../../../features/admin/ui.tsx'
import { getAdminWebhooks, replayAdminWebhook } from '../../../features/billing/admin.functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/webhooks')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
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
    <AdminPage
      title="Webhook events"
      description="Events without an associated workspace appear only when no workspace filter is set."
    >
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
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
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || !row.replayAvailable}
                  onClick={() => void replay(row.id)}
                >
                  {row.replayAvailable
                    ? 'Replay failed event'
                    : 'Replay unavailable — provider not configured'}
                </Button>
              ) : (
                <span className="text-muted-foreground">Only failed events can be replayed</span>
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
    </AdminPage>
  )
}
