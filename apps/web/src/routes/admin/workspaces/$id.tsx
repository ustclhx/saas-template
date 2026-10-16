import { Button, DetailList } from '@saas/ui'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ADMIN_COPY } from '../../../features/admin/copy.ts'
import {
  AdminPage,
  AdminSection,
  CheckboxField,
  EmptyState,
  formatDateTime,
  panelClass,
} from '../../../features/admin/ui.tsx'
import {
  getAdminWorkspace,
  getAdminWorkspaceCredits,
  restoreAdminWorkspace,
} from '../../../features/admin/workspaces.functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/workspaces/$id')({
  loader: ({ params }) => getAdminWorkspace({ data: { id: params.id } }),
  component: WorkspaceDetail,
})
function WorkspaceDetail() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const [confirmed, setConfirmed] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [batches, setBatches] = useState(data.batches)
  const [ledger, setLedger] = useState(data.ledger)
  async function restore() {
    setBusy(true)
    try {
      const result = await restoreAdminWorkspace({ data: { id: data.workspace.id } })
      setMessage(
        result.ok
          ? 'Workspace restored. Original owners can access it again.'
          : `${result.message} (${result.code})`,
      )
      await router.invalidate()
    } catch {
      setMessage('Restore failed. Reload to check the current state.')
    } finally {
      setBusy(false)
    }
  }
  async function more(kind: 'batches' | 'ledger') {
    const cursor = (kind === 'batches' ? batches : ledger).nextCursor
    if (!cursor) return
    setBusy(true)
    try {
      const page = await getAdminWorkspaceCredits({ data: { id: data.workspace.id, kind, cursor } })
      if (kind === 'batches') setBatches(page as typeof batches)
      else setLedger(page as typeof ledger)
    } catch {
      setMessage('Credit history is unavailable. Please retry.')
    } finally {
      setBusy(false)
    }
  }
  function overlaps(index: number) {
    const current = data.subscriptions[index]?.subscription
    if (!current?.currentPeriodStart || !current.currentPeriodEnd) return false
    const start = current.currentPeriodStart
    const end = current.currentPeriodEnd
    return data.subscriptions.some(
      ({ subscription: other }, i) =>
        i !== index &&
        other.currentPeriodStart &&
        other.currentPeriodEnd &&
        start < other.currentPeriodEnd &&
        other.currentPeriodStart < end,
    )
  }
  return (
    <AdminPage
      title="Workspace details"
      actions={
        <>
          {templateConfig.credits.enabled && (
            <Button asChild size="sm">
              <Link to="/admin/credits" search={{ offset: 0, workspaceId: data.workspace.id }}>
                {ADMIN_COPY.adjustCredits}
              </Link>
            </Button>
          )}
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/workspaces" search={{ offset: 0 }}>
              Back to workspaces
            </Link>
          </Button>
        </>
      }
    >
      <DetailList
        fields={[
          { label: 'Name', value: data.workspace.name },
          { label: 'ID', value: data.workspace.id },
          { label: 'Slug', value: data.workspace.slug },
          { label: 'Status', value: data.workspace.deletedAt ? 'Deleted' : 'Active' },
          {
            label: 'Deleted at',
            value: data.workspace.deletedAt ? formatDateTime(data.workspace.deletedAt) : null,
          },
          ...(data.entitlements
            ? [{ label: 'Entitlement plan', value: data.entitlements.key }]
            : []),
          ...(data.balance
            ? [
                { label: 'Available credits', value: data.balance.available },
                { label: 'Held credits', value: data.balance.held },
                { label: 'Credit debt', value: data.balance.debt },
              ]
            : []),
        ]}
      />
      {data.workspace.deletedAt && (
        <div className={panelClass('danger', 'max-w-xl')}>
          <p className="text-sm">
            Restore within the 30-day retention period. Only eligible original owners are restored;
            other members need new invitations.
          </p>
          <CheckboxField
            label="I confirm restoring this workspace"
            disabled={!ready}
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <Button
            className="w-fit"
            disabled={!ready || busy || !confirmed}
            onClick={() => void restore()}
          >
            Restore workspace
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <AdminSection title="Members">
        {data.members.length ? (
          <ul className="grid gap-2">
            {data.members.map((m) => (
              <li key={m.id} className="break-all rounded-md border px-3 py-2 text-sm">
                <Link to="/admin/users/$id" params={{ id: m.userId }} className="underline">
                  {m.email}
                </Link>{' '}
                · {m.role}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState />
        )}
      </AdminSection>
      {data.entitlements && (
        <AdminSection title="Subscriptions and overlapping periods">
          <p className="text-muted-foreground text-sm">
            All subscription periods are shown. Effective entitlements use the highest eligible
            plan.
          </p>
          {data.subscriptions.length ? (
            <ul className="grid gap-2">
              {data.subscriptions.map(({ subscription: sub, planName }, index) => (
                <li key={sub.id} className="break-words rounded-md border px-3 py-2 text-sm">
                  {planName} · {sub.provider} · {sub.status} · {sub.id}
                  <br />
                  Period:{' '}
                  {sub.currentPeriodStart ? formatDateTime(sub.currentPeriodStart) : 'Unconfirmed'}{' '}
                  — {sub.currentPeriodEnd ? formatDateTime(sub.currentPeriodEnd) : 'Unconfirmed'}
                  {overlaps(index) && <strong> · Overlapping period</strong>}
                  {sub.pastDueSince && <p>Past due since: {formatDateTime(sub.pastDueSince)}</p>}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState />
          )}
        </AdminSection>
      )}
      {data.balance && (
        <>
          <AdminSection title="Credit batches">
            {batches.items.length ? (
              <ul className="grid gap-2">
                {batches.items.map((batch) => (
                  <li key={batch.id} className="break-words rounded-md border px-3 py-2 text-sm">
                    {batch.id} · {batch.source} · {batch.status} · Remaining: {batch.remaining} /{' '}
                    {batch.amount} · Expires:{' '}
                    {batch.expiresAt ? formatDateTime(batch.expiresAt) : 'Never'}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState />
            )}
            {batches.nextCursor && (
              <Button
                className="w-fit"
                variant="outline"
                size="sm"
                disabled={!ready || busy}
                onClick={() => void more('batches')}
              >
                Older batches
              </Button>
            )}
          </AdminSection>
          <AdminSection title="Recent credit ledger">
            {ledger.items.length ? (
              <ul className="grid gap-2">
                {ledger.items.map((entry) => (
                  <li key={entry.id} className="break-words rounded-md border px-3 py-2 text-sm">
                    {formatDateTime(entry.createdAt)} · {entry.type} · {entry.delta} · {entry.id}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState />
            )}
            {ledger.nextCursor && (
              <Button
                className="w-fit"
                variant="outline"
                size="sm"
                disabled={!ready || busy}
                onClick={() => void more('ledger')}
              >
                Older ledger entries
              </Button>
            )}
          </AdminSection>
        </>
      )}
    </AdminPage>
  )
}
