import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
  getAdminModels,
  saveAdminModel,
  setAdminModelEnabled,
} from '../../features/ai/admin-models.functions.ts'

export const Route = createFileRoute('/admin/models')({
  loader: () => getAdminModels(),
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
  MODEL_KEY_TAKEN: 'Another model already uses this key.',
}

/** 表单状态：数值字段保留输入的字符串，提交时再转换 */
interface Draft {
  key: string
  kind: Kind
  provider: string
  providerModelId: string
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

function Models() {
  const { models, defaults } = Route.useLoaderData()
  return (
    <section>
      <h2>AI models</h2>
      <p>
        Disabled models are hidden from model pickers and calls to them are rejected. Price changes
        apply to calls started after saving.
      </p>
      <ModelEditor key="new" initial={newDraft(defaults)} defaults={defaults} />
      {models.length === 0 && <p>No models yet.</p>}
      {models.map((model) => (
        <ModelEditor key={model.id} model={model} initial={toDraft(model)} defaults={defaults} />
      ))}
    </section>
  )
}

function ModelEditor({
  model,
  initial,
  defaults,
}: {
  model?: ModelRow
  initial: Draft
  defaults: Data['defaults']
}) {
  const router = useRouter()
  const [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const field = (name: keyof Draft) => ({
    value: String(draft[name]),
    onChange: (event: { target: { value: string } }) => set({ [name]: event.target.value }),
  })

  async function act(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setBusy(true)
    try {
      const result = await action()
      if (result.ok) {
        setMessage('Saved.')
        if (!model) setDraft(newDraft(defaults))
        await router.invalidate()
      } else {
        setMessage(ERRORS[result.error] ?? `Save rejected (${result.error}).`)
      }
    } catch {
      setMessage('Save unavailable. Check the fields (multipliers must be JSON) and retry.')
    } finally {
      setBusy(false)
    }
  }

  function save() {
    return act(() =>
      saveAdminModel({
        data: {
          ...(model ? { id: model.id } : {}),
          key: draft.key,
          kind: draft.kind,
          provider: draft.provider,
          providerModelId: draft.providerModelId,
          pricing: pricingOf(draft),
          tags: draft.tags.split(','),
          enabled: draft.enabled,
          sort: Number(draft.sort) || 0,
        },
      }),
    )
  }

  const title = model ? `Model ${model.key}` : 'New model'
  return (
    <article aria-label={title}>
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
                ...pricingDraft(defaults[kind] as Record<string, unknown>),
              }))
            }}
          >
            <option value="text">Text</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
          </select>
        </label>{' '}
        <label>
          Provider <input required maxLength={64} {...field('provider')} />
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
      <p role="status">{message}</p>
    </article>
  )
}
