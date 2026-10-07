import { Button, Input, Label } from '@saas/ui'
import { createFileRoute } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { adminListSearch } from '../../features/admin/list.ts'
import { getAdminMetrics } from '../../features/admin/metrics.functions.ts'

export const Route = createFileRoute('/admin/metrics')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['from', 'to'])(search),
  loaderDeps: ({ search }) => ({ from: search.from, to: search.to }),
  loader: ({ deps }) => getAdminMetrics({ data: deps }),
  component: Metrics,
})
const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`)
function Metrics() {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const data = Route.useLoaderData()
  const navigate = Route.useNavigate()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    void navigate({
      search: { offset: 0, from: String(values.get('from')), to: String(values.get('to')) },
    })
  }
  return (
    <section className="grid gap-5">
      <h2 className="font-semibold text-xl">Business metrics</h2>
      <fieldset disabled={!ready}>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="metrics-from">From (UTC)</Label>
            <Input
              key={data.from}
              id="metrics-from"
              name="from"
              type="date"
              defaultValue={data.from}
              required
            />
          </div>
          <div>
            <Label htmlFor="metrics-to">To (UTC)</Label>
            <Input
              key={data.to}
              id="metrics-to"
              name="to"
              type="date"
              defaultValue={data.to}
              required
            />
          </div>
          <Button type="submit">Apply</Button>
        </form>
      </fieldset>
      <p className="text-muted-foreground text-sm">
        {data.latest
          ? `Data through ${data.latest.dataThrough.toISOString()} (exclusive); last computed ${data.latest.computedAt.toISOString()}.`
          : 'No daily summaries yet.'}
      </p>
      <p className="text-muted-foreground text-sm">
        {data.rows.length} daily summaries in this range. Paid conversion = paid workspaces / all
        active workspaces. MRR and workspace counts use the latest available daily snapshot. Success
        rate covers completed / (completed + failed + aborted) assistant text messages; media tasks
        are not included yet.
      </p>
      <dl className="grid gap-4 sm:grid-cols-3">
        {[
          ['Registrations', data.registrations],
          ['Paid workspaces', data.latest?.paidWorkspaces ?? '—'],
          ['Paid conversion', percent(data.paidConversion)],
          ['User credits consumed', data.creditsConsumed],
          ['Platform overage absorbed', data.overageAbsorbed],
          ['Text success rate', `${percent(data.successRate)} (${data.attempts} attempts)`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border p-4">
            <dt className="text-muted-foreground text-sm">{label}</dt>
            <dd className="mt-2 font-semibold text-2xl">{value}</dd>
          </div>
        ))}
      </dl>
      <h3 className="font-semibold">MRR (monthly, latest snapshot)</h3>
      {data.latest && Object.entries(data.latest.mrrByCurrency).length ? (
        <ul>
          {Object.entries(data.latest.mrrByCurrency).map(([currency, cents]) => (
            <li key={currency}>
              {currency}: {(cents / 100).toFixed(2)}
            </li>
          ))}
        </ul>
      ) : (
        <p>No paid subscriptions.</p>
      )}
      <h3 className="font-semibold">Platform overage by model</h3>
      {Object.entries(data.overageByModel).length ? (
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th>Model</th>
              <th>Credits absorbed</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(data.overageByModel)
              .sort((a, b) => b[1] - a[1])
              .map(([model, amount]) => (
                <tr key={model}>
                  <td>{model}</td>
                  <td>{amount}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p>No platform overage in this range.</p>
      )}
    </section>
  )
}
