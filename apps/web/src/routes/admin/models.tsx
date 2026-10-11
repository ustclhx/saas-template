import { DataTable } from '@saas/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useId, useState } from 'react'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'
import {
  PARAMS_SCHEMA_TEMPLATES,
  parseAdminParamsSchema,
} from '../../features/ai/admin-model-params.ts'
import {
  copyAdminModel,
  getAdminModels,
  saveAdminModel,
  setAdminModelEnabled,
} from '../../features/ai/admin-models.functions.ts'

export const Route = createFileRoute('/admin/models')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(['kind', 'order'])(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminModels({ data: deps }),
  errorComponent: () => <p role="alert">Model data is unavailable. Please reload.</p>,
  component: Models,
})

type Data = Awaited<ReturnType<typeof getAdminModels>>
type ModelRow = Data['models'][number]
type Kind = ModelRow['kind']
type Mode = 'per_call' | 'token' | 'per_unit'

const ERRORS: Record<string, string> = {
  MISSING_TOKEN_LIMITS: 'Per-call text models require input and output token limits.',
  INVALID_PRICING: 'Pricing is invalid. Check the required fields for this pricing mode.',
  MEDIA_PROVIDER_DISABLED: 'Choose an enabled media provider.',
  MODEL_KEY_TAKEN: 'Another model already uses this key.',
}

/** 表单状态：数值字段保留输入的字符串，提交时再转换 */
interface Draft {
  key: string
  kind: Kind
  provider: string
  providerModelId: string
  paramsSchema: string
  tags: string
  sort: string
  enabled: boolean
  mode: Mode
  credits: string
  chargeOn: string
  maxInputTokens: string
  maxOutputTokens: string
  inputPer1k: string
  outputPer1k: string
  minCharge: string
  unit: string
  perUnit: string
  multipliers: string
}

const str = (value: unknown) => (value === undefined || value === null ? '' : String(value))

function pricingDraft(pricing: Record<string, unknown>) {
  const limits = (pricing.limits ?? {}) as Record<string, unknown>
  return {
    mode: pricing.mode as Mode,
    credits: str(pricing.credits),
    chargeOn: str(pricing.chargeOn),
    maxInputTokens: str(limits.maxInputTokens),
    maxOutputTokens: str(limits.maxOutputTokens),
    inputPer1k: str(pricing.inputPer1k),
    outputPer1k: str(pricing.outputPer1k),
    minCharge: str(pricing.minCharge),
    unit: str(pricing.unit) || 'image',
    perUnit: str(pricing.perUnit),
    multipliers: pricing.multipliers ? JSON.stringify(pricing.multipliers) : '',
  }
}

function toDraft(model: ModelRow): Draft {
  return {
    key: model.key,
    kind: model.kind,
    provider: model.provider,
    providerModelId: model.providerModelId,
    paramsSchema: JSON.stringify(model.paramsSchema ?? {}, null, 2),
    tags: model.tags.join(', '),
    sort: String(model.sort),
    enabled: model.enabled,
    ...pricingDraft(model.pricing),
  }
}

function newDraft(defaults: Data['defaults'], kind: Kind = 'text'): Draft {
  return {
    key: '',
    kind,
    provider: '',
    providerModelId: '',
    paramsSchema: '{}',
    tags: '',
    sort: '0',
    enabled: true,
    ...pricingDraft(defaults[kind] as Record<string, unknown>),
  }
}

/** 空字符串省略该字段，交给服务端校验；非数字原样传 NaN 也会被拒绝 */
const num = (value: string) => (value.trim() === '' ? undefined : Number(value))

function pricingOf(draft: Draft): unknown {
  const multipliers = draft.multipliers.trim() ? JSON.parse(draft.multipliers) : undefined
  switch (draft.mode) {
    case 'per_call': {
      const maxInputTokens = num(draft.maxInputTokens)
      const maxOutputTokens = num(draft.maxOutputTokens)
      return {
        mode: 'per_call',
        credits: num(draft.credits),
        ...(draft.chargeOn ? { chargeOn: draft.chargeOn } : {}),
        ...(multipliers ? { multipliers } : {}),
        ...(maxInputTokens !== undefined || maxOutputTokens !== undefined
          ? { limits: { maxInputTokens, maxOutputTokens } }
          : {}),
      }
    }
    case 'token':
      return {
        mode: 'token',
        inputPer1k: num(draft.inputPer1k),
        outputPer1k: num(draft.outputPer1k),
        minCharge: num(draft.minCharge),
      }
    case 'per_unit':
      return {
        mode: 'per_unit',
        unit: draft.unit,
        perUnit: num(draft.perUnit),
        ...(multipliers ? { multipliers } : {}),
      }
  }
}

function ParamsSchemaEditor({
  label,
  kind,
  provider,
  value,
  onChange,
  onTemplate,
}: {
  label: string
  kind: Kind
  provider: string
  value: string
  onChange: (value: string) => void
  onTemplate: (message: string) => void
}) {
  const id = useId()
  const templates = PARAMS_SCHEMA_TEMPLATES.filter(
    (template) => template.kind === kind && (kind === 'text' || template.provider === provider),
  )
  return (
    <>
      <label htmlFor={`${id}-schema`}>{label}</label>
      <textarea
        id={`${id}-schema`}
        className="block w-full font-mono"
        rows={12}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <label htmlFor={`${id}-template`}>Insert reference template</label>{' '}
      <select
        id={`${id}-template`}
        value=""
        disabled={templates.length === 0}
        onChange={(event) => {
          const template = templates.find((item) => item.id === event.target.value)
          if (!template) return
          onChange(JSON.stringify(template.schema, null, 2))
          onTemplate(
            template.kind !== 'text'
              ? `Reference inserted for ${template.providerModelId}. Verify the Provider model ID before saving.`
              : 'Text defaults inserted.',
          )
        }}
      >
        <option value="">Choose a reference template</option>
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.label}
          </option>
        ))}
      </select>
      <p>Templates replace the schema. Check the parameters against your Provider model ID.</p>
    </>
  )
}

function Models() {
  const data = Route.useLoaderData()
  const { models, defaults, mediaProviders } = data
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section>
      <h2>AI models</h2>
      <p>
        Disabled models are hidden from model pickers and calls to them are rejected. Price changes
        apply to calls started after saving.
      </p>
      <DataTable
        label="AI models"
        rows={models}
        getRowId={(row) => row.id}
        columns={[
          {
            id: 'key',
            header: 'Key',
            cell: (row) => (
              <a href={`#model-${row.id}`} className="underline">
                {row.key}
              </a>
            ),
          },
          { id: 'kind', header: 'Type', cell: (row) => row.kind },
          { id: 'provider', header: 'Provider', cell: (row) => row.provider },
          { id: 'pricing', header: 'Pricing', cell: (row) => String(row.pricing.mode) },
          { id: 'sort', header: 'Sort', cell: (row) => row.sort },
          {
            id: 'enabled',
            header: 'Status',
            cell: (row) => (row.enabled ? 'Enabled' : 'Disabled'),
          },
        ]}
        page={adminListPage(search.offset, data)}
        filters={[
          {
            id: 'kind',
            label: 'Model type',
            type: 'select',
            options: [
              { value: 'text', label: 'Text' },
              { value: 'image', label: 'Image' },
              { value: 'video', label: 'Video' },
            ],
          },
          {
            id: 'order',
            label: 'Order models',
            type: 'select',
            options: [
              { value: 'sort', label: 'Sort ascending' },
              { value: 'sort_desc', label: 'Sort descending' },
              { value: 'key', label: 'Key ascending' },
              { value: 'key_desc', label: 'Key descending' },
            ],
          },
        ]}
        filterValues={{ kind: search.kind, order: search.order }}
        onPageChange={(page) =>
          void navigate({ search: { ...search, offset: offsetOfPage(page) } })
        }
        onFiltersChange={(values) =>
          void navigate({ search: filtersToSearch(['kind', 'order'], values) })
        }
      />
      <ModelEditor
        key="new"
        initial={newDraft(defaults)}
        defaults={defaults}
        mediaProviders={mediaProviders}
      />
      {models.length === 0 && <p>No models yet.</p>}
      {models.map((model) => (
        <ModelEditor
          key={model.id}
          model={model}
          initial={toDraft(model)}
          defaults={defaults}
          mediaProviders={mediaProviders}
        />
      ))}
    </section>
  )
}

function ModelEditor({
  model,
  initial,
  defaults,
  mediaProviders,
}: {
  model?: ModelRow
  initial: Draft
  defaults: Data['defaults']
  mediaProviders: Data['mediaProviders']
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [copyKey, setCopyKey] = useState(model ? `${model.key.slice(0, 59)}-copy` : '')
  const savedParamsSchema = JSON.stringify(model?.paramsSchema ?? {}, null, 2)
  const [copyParamsSchema, setCopyParamsSchema] = useState(savedParamsSchema)
  useEffect(() => {
    setCopyParamsSchema(savedParamsSchema)
  }, [savedParamsSchema])
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const field = (name: keyof Draft) => ({
    value: String(draft[name]),
    onChange: (event: { target: { value: string } }) => set({ [name]: event.target.value }),
  })

  async function act(
    action: () => Promise<{ ok: true } | { ok: false; error: string; message?: string }>,
  ) {
    setBusy(true)
    try {
      const result = await action()
      if (result.ok) {
        setMessage('Saved.')
        if (!model) setDraft(newDraft(defaults))
        await router.invalidate()
      } else {
        setMessage(result.message ?? ERRORS[result.error] ?? `Save rejected (${result.error}).`)
      }
    } catch {
      setMessage('Save unavailable. Check the fields (multipliers must be JSON) and retry.')
    } finally {
      setBusy(false)
    }
  }

  function validateParamsSchema(kind: Kind, json: string) {
    try {
      parseAdminParamsSchema(kind, json)
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Parameter schema is invalid.')
      return false
    }
  }

  function save() {
    if (!validateParamsSchema(draft.kind, draft.paramsSchema)) return
    return act(() =>
      saveAdminModel({
        data: {
          ...(model ? { id: model.id } : {}),
          key: draft.key,
          kind: draft.kind,
          provider: draft.provider,
          providerModelId: draft.providerModelId,
          paramsSchema: draft.paramsSchema,
          pricing: pricingOf(draft),
          tags: draft.tags.split(','),
          enabled: draft.enabled,
          sort: Number(draft.sort) || 0,
        },
      }),
    )
  }

  function copy() {
    if (!model || !validateParamsSchema(model.kind, copyParamsSchema)) return
    return act(() =>
      copyAdminModel({ data: { id: model.id, key: copyKey, paramsSchema: copyParamsSchema } }),
    )
  }

  const title = model ? `Model ${model.key}` : 'New model'
  return (
    <article aria-label={title} id={model ? `model-${model.id}` : undefined}>
      <h3>
        {title}
        {model && !model.enabled && ' (disabled)'}
      </h3>
      <fieldset disabled={busy}>
        <legend>Model</legend>
        <label>
          Key <input required maxLength={64} {...field('key')} />
        </label>{' '}
        <label>
          Kind{' '}
          <select
            value={draft.kind}
            disabled={Boolean(model)}
            onChange={(event) => {
              const kind = event.target.value as Kind
              // 新建时切换类型按模板配置重新预填计费方式
              setDraft((current) => ({
                ...current,
                kind,
                provider: kind === 'text' ? '' : (mediaProviders[0] ?? ''),
                ...pricingDraft(defaults[kind] as Record<string, unknown>),
              }))
            }}
          >
            <option value="text">Text</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </label>{' '}
        <label htmlFor={`${model?.id ?? 'new'}-provider`}>
          Provider{' '}
          {draft.kind === 'text' ? (
            <input
              id={`${model?.id ?? 'new'}-provider`}
              required
              maxLength={64}
              {...field('provider')}
            />
          ) : (
            <select id={`${model?.id ?? 'new'}-provider`} required {...field('provider')}>
              <option value="">Choose a provider</option>
              {mediaProviders.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          )}
        </label>{' '}
        <label>
          Provider model ID <input required maxLength={200} {...field('providerModelId')} />
        </label>{' '}
        <label>
          Plan tags (comma separated) <input {...field('tags')} />
        </label>{' '}
        <label>
          Sort <input type="number" step="1" {...field('sort')} />
        </label>{' '}
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => set({ enabled: event.target.checked })}
          />{' '}
          Enabled
        </label>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Parameters</legend>
        <ParamsSchemaEditor
          label="Parameters schema (JSON)"
          kind={draft.kind}
          provider={draft.provider}
          value={draft.paramsSchema}
          onChange={(paramsSchema) => set({ paramsSchema })}
          onTemplate={setMessage}
        />
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Pricing</legend>
        <label>
          Pricing mode{' '}
          <select
            value={draft.mode}
            onChange={(event) => set({ mode: event.target.value as Mode })}
          >
            <option value="per_call">Per call</option>
            <option value="token">Per token</option>
            <option value="per_unit">Per unit</option>
          </select>
        </label>{' '}
        {draft.mode === 'per_call' && (
          <>
            <label>
              Credits per call <input type="number" min="0" step="1" {...field('credits')} />
            </label>{' '}
            <label>
              Charge on{' '}
              <select {...field('chargeOn')}>
                <option value="">Default</option>
                <option value="any_output">Any output</option>
                <option value="success">Success</option>
              </select>
            </label>{' '}
            <label>
              Max input tokens <input type="number" min="1" step="1" {...field('maxInputTokens')} />
            </label>{' '}
            <label>
              Max output tokens{' '}
              <input type="number" min="1" step="1" {...field('maxOutputTokens')} />
            </label>{' '}
          </>
        )}
        {draft.mode === 'token' && (
          <>
            <label>
              Input credits / 1k <input type="number" min="0" step="any" {...field('inputPer1k')} />
            </label>{' '}
            <label>
              Output credits / 1k{' '}
              <input type="number" min="0" step="any" {...field('outputPer1k')} />
            </label>{' '}
            <label>
              Minimum charge <input type="number" min="0" step="1" {...field('minCharge')} />
            </label>
          </>
        )}
        {draft.mode === 'per_unit' && (
          <>
            <label>
              Unit{' '}
              <select {...field('unit')}>
                <option value="image">Image</option>
                <option value="second">Second</option>
              </select>
            </label>{' '}
            <label>
              Credits per unit <input type="number" min="0" step="any" {...field('perUnit')} />
            </label>{' '}
          </>
        )}
        {draft.mode !== 'token' && (
          <label>
            Multipliers (JSON, optional){' '}
            <input placeholder='{"resolution":{"720p":1,"1080p":2}}' {...field('multipliers')} />
          </label>
        )}
      </fieldset>
      <button type="button" disabled={busy} onClick={save}>
        {model ? 'Save changes' : 'Create model'}
      </button>{' '}
      {model && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            act(() => setAdminModelEnabled({ data: { id: model.id, enabled: !model.enabled } }))
          }
        >
          {model.enabled ? 'Disable' : 'Enable'}
        </button>
      )}
      {model && (
        <fieldset disabled={busy}>
          <legend>Copy saved model</legend>
          <label>
            Copy key{' '}
            <input
              value={copyKey}
              maxLength={64}
              onChange={(event) => setCopyKey(event.target.value)}
            />
          </label>{' '}
          <ParamsSchemaEditor
            label="Copy parameters schema (JSON)"
            kind={model.kind}
            provider={model.provider}
            value={copyParamsSchema}
            onChange={setCopyParamsSchema}
            onTemplate={setMessage}
          />
          <button type="button" onClick={copy}>
            Copy model
          </button>
          <p>The copy is disabled until you enable it.</p>
        </fieldset>
      )}
      <p role="status">{message}</p>
    </article>
  )
}
