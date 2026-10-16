import { newId } from '@saas/shared'
import { Button, DataTable, Input } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { adjustCredits, getAdminCredits } from '../../features/admin/credits.functions.ts'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'
import { AdminPage, Field, formatDateTime, Panel, Textarea } from '../../features/admin/ui.tsx'
import { templateConfig } from '../../server/template-config.ts'

export const Route = createFileRoute('/admin/credits')({
  beforeLoad: () => {
    if (!templateConfig.credits.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminCredits({ data: deps }),
  component: Credits,
})
function Credits() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [amount, setAmount] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [reason, setReason] = useState('')
  const [adjustmentId, setAdjustmentId] = useState(newId)
  const [pending, setPending] = useState<Parameters<typeof adjustCredits>[0]['data'] | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(input: Parameters<typeof adjustCredits>[0]['data']) {
    setPending(input)
    setBusy(true)
    try {
      const result = await adjustCredits({ data: input })
      if (result.ok) {
        setMessage(result.replayed ? 'Adjustment already applied.' : 'Adjustment applied.')
        setPending(null)
        setAdjustmentId(newId())
        setReason('')
      } else {
        setMessage(`Adjustment unavailable (${result.error}).`)
        setPending(null)
        setAdjustmentId(newId())
      }
      await router.invalidate()
    } catch {
      setMessage('Request failed. Retry the same adjustment to check its saved result.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <AdminPage
      title="Credit adjustments"
      description="Grant or revoke credits for one workspace. Filter by workspace ID to enable the form."
    >
      {data.balance && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Available:</dt>
            <dd className="font-medium">{data.balance.available}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Held:</dt>
            <dd className="font-medium">{data.balance.held}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Debt:</dt>
            <dd className="font-medium">{data.balance.debt}</dd>
          </div>
        </dl>
      )}
      {pending ? (
        <Button
          type="button"
          className="w-fit"
          disabled={busy}
          onClick={() => void submit(pending)}
        >
          Retry same adjustment
        </Button>
      ) : (
        <Panel className="max-w-2xl">
          <fieldset disabled={busy || !search.workspaceId} className="grid min-w-0 gap-4">
            <legend className="mb-3 font-semibold">Add credits</legend>
            {!search.workspaceId && (
              <p className="text-muted-foreground text-sm">
                Enter a workspace ID in the filter below and apply it first.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Amount" htmlFor="credit-amount">
                <Input
                  id="credit-amount"
                  type="number"
                  min="1"
                  step="1"
                  max="2147483647"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </Field>
              <Field label="Expiration (optional)" htmlFor="credit-expires">
                <Input
                  id="credit-expires"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Reason"
              htmlFor="credit-reason"
              description="Required for grants and for revoking a batch below."
            >
              <Textarea
                id="credit-reason"
                value={reason}
                maxLength={2000}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              className="w-fit"
              disabled={
                !reason.trim() ||
                !Number.isInteger(Number(amount)) ||
                Number(amount) <= 0 ||
                Number(amount) > 2_147_483_647
              }
              onClick={() => {
                if (search.workspaceId)
                  void submit({
                    kind: 'grant',
                    adjustmentId,
                    workspaceId: search.workspaceId,
                    amount: Number(amount),
                    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                    reason,
                  })
              }}
            >
              Add credits
            </Button>
          </fieldset>
        </Panel>
      )}
      <p role="status" className="min-h-5 text-sm">
        {message}
      </p>
      <DataTable
        label="Credit batches"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'id', header: 'Batch', cell: (row) => row.id },
          { id: 'source', header: 'Source', cell: (row) => row.source },
          {
            id: 'amount',
            header: 'Amount / remaining',
            cell: (row) => `${row.amount} / ${row.remaining}`,
          },
          {
            id: 'expiration',
            header: 'Expiration',
            cell: (row) => (row.expiresAt ? formatDateTime(row.expiresAt) : 'Never'),
          },
          { id: 'status', header: 'Status', cell: (row) => row.status },
          {
            id: 'revoke',
            header: 'Revoke remaining',
            cell: (row) => (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || Boolean(pending) || !reason.trim() || row.status !== 'active'}
                onClick={() => {
                  if (window.confirm(`Revoke remaining credits in batch ${row.id}?`))
                    void submit({
                      kind: 'revoke',
                      adjustmentId,
                      workspaceId: row.workspaceId,
                      grantId: row.id,
                      reason,
                    })
                }}
              >
                Revoke batch
              </Button>
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
