import { Button, DetailList } from '@saas/ui'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  getAdminWorkspace,
  getAdminWorkspaceCredits,
  restoreAdminWorkspace,
} from '../../../features/admin/workspaces.functions.ts'

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
    <section className="grid gap-5">
      <Link to="/admin/workspaces" search={{ offset: 0 }} className="underline">
        Back to workspaces
      </Link>
      <h2 className="font-semibold text-xl">Workspace details</h2>
      <DetailList
        fields={[
          { label: 'Name', value: data.workspace.name },
          { label: 'ID', value: data.workspace.id },
          { label: 'Slug', value: data.workspace.slug },
          { label: 'Status', value: data.workspace.deletedAt ? 'Deleted' : 'Active' },
          { label: 'Deleted at', value: data.workspace.deletedAt?.toISOString() },
          { label: 'Entitlement plan', value: data.entitlements.key },
          { label: 'Available credits', value: data.balance.available },
          { label: 'Held credits', value: data.balance.held },
          { label: 'Credit debt', value: data.balance.debt },
        ]}
      />
      {data.workspace.deletedAt && (
        <div className="grid max-w-xl gap-3">
          <p>
            Restore within the 30-day retention period. Only eligible original owners are restored;
            other members need new invitations.
          </p>
          <label>
            <input
              disabled={!ready}
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{' '}
            I confirm restoring this workspace
          </label>
          <Button
            className="w-fit"
            disabled={!ready || busy || !confirmed}
            onClick={() => void restore()}
          >
            Restore workspace
          </Button>
        </div>
      )}
      <p role="status">{message}</p>
      <h3 className="font-semibold">Members</h3>
      <ul>
        {data.members.map((m) => (
          <li key={m.id}>
            <Link to="/admin/users/$id" params={{ id: m.userId }} className="underline">
              {m.email}
            </Link>{' '}
            · {m.role}
          </li>
        ))}
      </ul>
      <h3 className="font-semibold">Subscriptions and overlapping periods</h3>
      <p>
        All subscription periods are shown. Effective entitlements use the highest eligible plan.
      </p>
      <ul>
        {data.subscriptions.map(({ subscription: sub, planName }, index) => (
          <li key={sub.id} className="rounded border p-3">
            {planName} · {sub.provider} · {sub.status} · {sub.id}
            <br />
            Period: {sub.currentPeriodStart?.toISOString() ?? 'Unconfirmed'} —{' '}
            {sub.currentPeriodEnd?.toISOString() ?? 'Unconfirmed'}
            {overlaps(index) && <strong> · Overlapping period</strong>}
            {sub.pastDueSince && <p>Past due since: {sub.pastDueSince.toISOString()}</p>}
          </li>
        ))}
      </ul>
      <h3 className="font-semibold">Credit batches</h3>
      <ul>
        {batches.items.map((batch) => (
          <li key={batch.id} className="rounded border p-3">
            {batch.id} · {batch.source} · {batch.status} · Remaining: {batch.remaining} /{' '}
            {batch.amount} · Expires: {batch.expiresAt?.toISOString() ?? 'Never'}
          </li>
        ))}
      </ul>
      {batches.nextCursor && (
        <Button className="w-fit" disabled={!ready || busy} onClick={() => void more('batches')}>
          Older batches
        </Button>
      )}
      <h3 className="font-semibold">Recent credit ledger</h3>
      <ul>
        {ledger.items.map((entry) => (
          <li key={entry.id} className="rounded border p-3">
            {entry.createdAt.toISOString()} · {entry.type} · {entry.delta} · {entry.id}
          </li>
        ))}
      </ul>
      {ledger.nextCursor && (
        <Button className="w-fit" disabled={!ready || busy} onClick={() => void more('ledger')}>
          Older ledger entries
        </Button>
      )}
    </section>
  )
}
