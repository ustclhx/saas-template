import { Button, DataTable, Input } from '@saas/ui'
import {
  createFileRoute,
  notFound as featureNotFound,
  Link,
  useRouter,
} from '@tanstack/react-router'
import { useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import { AdminPage, Field, panelClass, Textarea } from '../../../features/admin/ui.tsx'
import {
  completeAdminRefund,
  getAdminRefunds,
  retryAdminRefundEmail,
  reviewAdminRefund,
} from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/refunds')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['workspaceId'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminRefunds({ data: deps }),
  errorComponent: () => <p role="alert">Refund data is unavailable. Please reload.</p>,
  component: Refunds,
})
function Refunds() {
  const { rows, hasMore } = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <AdminPage
      title="Refund reviews"
      description={
        <>
          Original and remaining credits include held or revoked credits in their difference; that
          difference is not consumed usage.
          <br />A full refund revokes all remaining credits for the payment. A partial refund keeps
          the unrefunded share of each credit batch and revokes the rest from what is unused;
          consumed credits are never clawed back.
        </>
      }
    >
      <DataTable
        label="Refund requests"
        rows={rows}
        getRowId={(row) => row.id}
        columns={[{ id: 'review', header: 'Refund review', cell: (row) => <Refund row={row} /> }]}
        page={adminListPage(search.offset, { hasMore })}
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
type RefundRow = Awaited<ReturnType<typeof getAdminRefunds>>['rows'][number]
function Refund({ row }: { row: RefundRow }) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [cents, setCents] = useState('')
  const [refundId, setRefundId] = useState('')
  const [proof, setProof] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function act(
    action: () => Promise<{ ok: true; status: string } | { ok: false; error: string }>,
  ) {
    setBusy(true)
    try {
      const result = await action()
      setMessage(
        result.ok
          ? result.status
          : `Action unavailable (${result.error}). The decision may already be saved; refreshed status is shown below. Email can be retried independently.`,
      )
      await router.invalidate()
    } catch {
      setMessage('Action unavailable. Reload to check saved status before retrying.')
    } finally {
      setBusy(false)
    }
  }
  function review(decision: 'approve' | 'reject', approvedAmount?: number) {
    return act(() =>
      reviewAdminRefund({
        data: {
          requestId: row.id,
          decision,
          reviewNote: note,
          ...(approvedAmount === undefined ? {} : { approvedAmount }),
        },
      }),
    )
  }
  return (
    <article aria-label={`Refund ${row.id}`} className="grid min-w-0 gap-3 py-2">
      <h3 className="break-all font-semibold">Refund {row.id}</h3>
      <div className="grid gap-1 break-words text-sm">
        <p>
          Workspace:{' '}
          <Link to="/admin/workspaces/$id" params={{ id: row.workspaceId }} className="underline">
            {row.workspaceId}
          </Link>{' '}
          · {row.provider} · Status: {row.status}
        </p>
        <p>Reason: {row.reason}</p>
        <p>
          Requested:{' '}
          {row.requestedAmount === null
            ? 'Full remaining payment'
            : adminMoney(row.requestedAmount, row.currency)}{' '}
          · Remaining refundable: {adminMoney(row.remainingRefundable, row.currency)}
        </p>
        <p>
          Approved:{' '}
          {row.approvedAmount === null ? 'None' : adminMoney(row.approvedAmount, row.currency)} ·
          Review note: {row.reviewNote || 'None'}
        </p>
        <p>
          Original credits: {row.originalCredits} · Remaining credits: {row.remainingCredits}
        </p>
      </div>
      {!row.providerAvailable && (
        <p className="text-muted-foreground text-sm">
          Provider not configured. Approval, manual completion and API retry are unavailable. Saved
          reviews remain visible.
        </p>
      )}
      {row.status === 'pending' && (
        <fieldset disabled={busy} className={panelClass('default', 'max-w-2xl')}>
          <legend className="px-1 font-medium text-sm">Review decision</legend>
          <Field label="Review note" htmlFor={`${row.id}-note`}>
            <Textarea
              id={`${row.id}-note`}
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-3">
            <Button
              type="button"
              disabled={!row.providerAvailable || row.remainingRefundable <= 0}
              onClick={() => review('approve')}
            >
              Approve full refund
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!note.trim()}
              onClick={() => review('reject')}
            >
              Reject refund
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Partial amount (USD cents)" htmlFor={`${row.id}-cents`}>
              <Input
                id={`${row.id}-cents`}
                className="w-48"
                type="number"
                min="1"
                max={row.remainingRefundable}
                step="1"
                value={cents}
                onChange={(event) => setCents(event.target.value)}
              />
            </Field>
            <Button
              type="button"
              variant="outline"
              disabled={
                !row.providerAvailable ||
                !Number.isInteger(Number(cents)) ||
                Number(cents) <= 0 ||
                Number(cents) >= row.remainingRefundable
              }
              onClick={() => review('approve', Number(cents))}
            >
              Approve partial refund
            </Button>
          </div>
        </fieldset>
      )}
      {row.status === 'approved' && row.providerAvailable && !row.manualAvailable && (
        <Button
          type="button"
          className="w-fit"
          disabled={busy}
          onClick={() =>
            act(() =>
              reviewAdminRefund({
                data: {
                  requestId: row.id,
                  decision: 'approve',
                  reviewNote: row.reviewNote ?? '',
                  ...(row.approvedAmount === null ? {} : { approvedAmount: row.approvedAmount }),
                },
              }),
            )
          }
        >
          Retry approved refund API
        </Button>
      )}
      {row.status === 'approved' && row.manualAvailable && (
        <fieldset disabled={busy} className={panelClass('default', 'max-w-2xl')}>
          <legend className="px-1 font-medium text-sm">Manual platform completion</legend>
          <Field label="Platform refund ID" htmlFor={`${row.id}-refund-id`}>
            <Input
              id={`${row.id}-refund-id`}
              value={refundId}
              maxLength={2000}
              onChange={(event) => setRefundId(event.target.value)}
            />
          </Field>
          <Field label="Platform proof" htmlFor={`${row.id}-proof`}>
            <Textarea
              id={`${row.id}-proof`}
              value={proof}
              maxLength={2000}
              onChange={(event) => setProof(event.target.value)}
            />
          </Field>
          <Button
            type="button"
            className="w-fit"
            disabled={!refundId.trim() || !proof.trim()}
            onClick={() =>
              act(() =>
                completeAdminRefund({
                  data: { requestId: row.id, providerRefundId: refundId, proof },
                }),
              )
            }
          >
            Mark manual refund complete
          </Button>
        </fieldset>
      )}
      {row.status !== 'pending' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-fit"
          disabled={busy}
          onClick={() => act(() => retryAdminRefundEmail({ data: { requestId: row.id } }))}
        >
          Retry refund email
        </Button>
      )}
      <p role="status" className="text-sm">
        {message}
      </p>
    </article>
  )
}
