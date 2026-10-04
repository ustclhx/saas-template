import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { getAdminBilling, replayAdminWebhook } from '../../../features/billing/admin.functions.ts'
import { adminMoney } from '../../../features/billing/admin-display.ts'

export const Route = createFileRoute('/admin/billing/')({
  validateSearch: (search: Record<string, unknown>) => ({
    offset: Math.min(100_000, Math.max(0, Number(search.offset) || 0)),
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminBilling({ data: deps }),
  errorComponent: () => <p role="alert">Billing data is unavailable. Please reload.</p>,
  component: BillingAdmin,
})
function BillingAdmin() {
  const data = Route.useLoaderData()
  const { offset } = Route.useSearch()
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
    <section>
      <h2>Billing administration</h2>
      <Link to="/admin/billing/refunds" search={{ offset: 0 }}>
        Refund reviews
      </Link>
      <p role="status">{message || 'Each list shows at most 50 records per page.'}</p>
      <ul>
        {data.readiness.map((item) => (
          <li key={item.id}>
            {item.id}: {item.available ? 'Configured' : 'Unavailable — provider is not configured'}
          </li>
        ))}
      </ul>
      <h3>Payments</h3>
      <table>
        <thead>
          <tr>
            <th>Workspace</th>
            <th>Provider</th>
            <th>Amount</th>
            <th>Refunded</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.payments.map((row) => (
            <tr key={row.id}>
              <td>{row.workspaceId}</td>
              <td>{row.provider}</td>
              <td>{adminMoney(row.amount, row.currency)}</td>
              <td>{adminMoney(row.refundedAmount, row.currency)}</td>
              <td>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Subscriptions</h3>
      <table>
        <thead>
          <tr>
            <th>Workspace</th>
            <th>Provider</th>
            <th>Status</th>
            <th>Cancellation</th>
          </tr>
        </thead>
        <tbody>
          {data.subscriptions.map((row) => (
            <tr key={row.id}>
              <td>{row.workspaceId}</td>
              <td>{row.provider}</td>
              <td>{row.status}</td>
              <td>{row.cancelAtPeriodEnd ? 'At period end' : 'None scheduled'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Webhook events</h3>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Event</th>
            <th>Type</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Replay</th>
          </tr>
        </thead>
        <tbody>
          {data.webhooks.map((row) => (
            <tr key={row.id}>
              <td>{row.provider}</td>
              <td>{row.providerEventId}</td>
              <td>{row.type}</td>
              <td>{row.status}</td>
              <td>{row.attempts}</td>
              <td>
                {row.status === 'failed' ? (
                  <button
                    type="button"
                    disabled={busy || !row.replayAvailable}
                    onClick={() => replay(row.id)}
                  >
                    {row.replayAvailable
                      ? 'Replay failed event'
                      : 'Replay unavailable — provider not configured'}
                  </button>
                ) : (
                  'Only failed events can be replayed'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <nav aria-label="Billing pages">
        {offset > 0 && (
          <Link to="/admin/billing" search={{ offset: Math.max(0, offset - 50) }}>
            Previous
          </Link>
        )}{' '}
        {data.hasMore && offset < 100_000 && (
          <Link to="/admin/billing" search={{ offset: Math.min(100_000, offset + 50) }}>
            Next
          </Link>
        )}
      </nav>
    </section>
  )
}
