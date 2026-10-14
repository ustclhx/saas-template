import { DataTable } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../../features/admin/list.ts'
import {
  getAdminPlans,
  saveAdminPlanModels,
} from '../../../features/billing/admin-plans.functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/billing/plans')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['q'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminPlans({ data: deps }),
  errorComponent: () => <p role="alert">Plan data is unavailable. Please reload.</p>,
  component: Plans,
})

type Data = Awaited<ReturnType<typeof getAdminPlans>>

function Plans() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="grid gap-5">
      <h2 className="font-semibold text-xl">Plan model access</h2>
      <p>Saved model access applies to the next request. Select no models to revoke all access.</p>
      <p>Credit packs only grant credits; their model selections do not grant plan entitlements.</p>
      <DataTable
        label="Plans"
        rows={data.rows}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'key',
            header: 'Key',
            cell: (row) => (
              <a href={`#plan-${row.id}`} className="underline">
                {row.key}
              </a>
            ),
          },
          { id: 'name', header: 'Name', cell: (row) => row.name },
          { id: 'type', header: 'Type', cell: (row) => row.type },
          { id: 'active', header: 'Status', cell: (row) => (row.active ? 'Active' : 'Inactive') },
          { id: 'models', header: 'Models', cell: (row) => row.models.join(', ') || 'None' },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[{ id: 'q', label: 'Search plans' }]}
        filterValues={{ q: search.q }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) => void navigate({ search: filtersToSearch(['q'], values) })}
      />
      {data.rows.map((plan) => (
        <PlanEditor key={plan.id} plan={plan} models={data.models} />
      ))}
    </section>
  )
}

function PlanEditor({ plan, models }: { plan: Data['rows'][number]; models: Data['models'] }) {
  const router = useRouter()
  const [selected, setSelected] = useState(plan.models)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [message, setMessage] = useState('')
  // SSR 展示表单时尚无事件处理器，完成 hydration 后再允许编辑和保存。
  useEffect(() => setReady(true), [])
  const currentKeys = new Set(models.map((model) => model.key))
  const historical = plan.models.filter((key) => key !== '*' && !currentKeys.has(key))
  const options = [
    { key: '*', label: 'All models (*)' },
    ...models.map((model) => ({
      key: model.key,
      label: `${model.key}${model.enabled ? '' : ' (disabled)'}`,
    })),
    ...historical.map((key) => ({ key, label: `${key} (historical; model missing)` })),
  ]
  async function save() {
    setBusy(true)
    setMessage('')
    try {
      const result = await saveAdminPlanModels({ data: { id: plan.id, models: selected } })
      if (!result.ok) {
        setMessage(result.error)
        return
      }
      await router.invalidate()
      setMessage('Saved.')
    } catch {
      setMessage('Save unavailable. Reload and retry.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <article
      aria-label={`Plan ${plan.key}`}
      id={`plan-${plan.id}`}
      className="grid gap-3 rounded border p-4"
    >
      <h3 className="font-semibold">
        {plan.name} ({plan.key})
      </h3>
      {plan.type === 'credit_pack' && (
        <p>Credit pack: these selections do not grant model access.</p>
      )}
      {historical.length > 0 && (
        <p role="alert">
          Historical model keys are missing: {historical.join(', ')}. They remain selected until you
          remove them.
        </p>
      )}
      <fieldset disabled={busy || !ready} className="grid gap-2">
        <legend>Allowed models</legend>
        {options.map((option) => (
          <label key={option.key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selected.includes(option.key)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, option.key]
                    : current.filter((key) => key !== option.key),
                )
              }
            />
            {option.label}
          </label>
        ))}
      </fieldset>
      <button type="button" disabled={busy || !ready} onClick={() => void save()}>
        Save model access
      </button>
      <p role="status">{message}</p>
    </article>
  )
}
