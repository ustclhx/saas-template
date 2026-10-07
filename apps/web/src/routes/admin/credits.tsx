import { newId } from '@saas/shared'
import { DataTable } from '@saas/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { adjustCredits, getAdminCredits } from '../../features/admin/credits.functions.ts'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'

export const Route = createFileRoute('/admin/credits')({
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
    <section className="grid gap-5">
      <h2 className="font-semibold text-xl">Credit adjustments</h2>
      {data.balance && (
        <p>
          Available: {data.balance.available} · Held: {data.balance.held} · Debt:{' '}
          {data.balance.debt}
        </p>
      )}
      <p role="status">{message}</p>
      {pending ? (
        <button type="button" disabled={busy} onClick={() => void submit(pending)}>
          Retry same adjustment
        </button>
      ) : (
        <fieldset disabled={busy || !search.workspaceId}>
          <legend>Add credits</legend>
          <label>
            Amount{' '}
            <input
              type="number"
              min="1"
              step="1"
              max="2147483647"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label>
            Expiration (optional){' '}
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <label>
            Reason{' '}
            <textarea
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <button
            type="button"
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
          </button>
        </fieldset>
      )}
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
            cell: (row) => (row.expiresAt ? new Date(row.expiresAt).toLocaleString() : 'Never'),
          },
          { id: 'status', header: 'Status', cell: (row) => row.status },
          {
            id: 'revoke',
            header: 'Revoke remaining',
            cell: (row) => (
              <button
                type="button"
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
              </button>
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
