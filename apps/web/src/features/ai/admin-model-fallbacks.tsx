import { MAX_MODEL_FALLBACKS, type ModelFallback } from '@saas/ai/client'
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger } from '@saas/ui'
import { useId } from 'react'
import { m } from '../../paraglide/messages.js'

type Kind = 'text' | 'image' | 'video'

/** 备用模型下拉的候选（全部已登记模型的摘要，见 listAdminFallbackOptions）。 */
export interface FallbackOption {
  readonly key: string
  readonly displayName: string | null
  readonly kind: Kind
  readonly provider: string
  readonly enabled: boolean
}

export interface FallbackDraft {
  modelKey: string
  /** 参数映射按行编辑，保存时去掉空行再组成对象。 */
  params: { from: string; to: string }[]
}

export function fallbackDrafts(fallbacks: readonly ModelFallback[] | undefined): FallbackDraft[] {
  return (fallbacks ?? []).map(({ modelKey, paramMap }) => ({
    modelKey,
    params: Object.entries(paramMap ?? {}).map(([from, to]) => ({ from, to })),
  }))
}

/** 组装保存载荷；有未选择模型的行时返回 undefined，由调用方提示。 */
export function fallbacksPayload(kind: Kind, drafts: readonly FallbackDraft[]) {
  if (drafts.some(({ modelKey }) => modelKey === '')) return undefined
  return drafts.map(({ modelKey, params }) => {
    const rows = params
      .map(({ from, to }) => [from.trim(), to.trim()] as const)
      .filter(([from, to]) => from !== '' && to !== '')
    // 文本模型不支持参数映射（共用校验会拒绝），切换类型后残留的行直接丢弃。
    return kind !== 'text' && rows.length > 0
      ? { modelKey, paramMap: Object.fromEntries(rows) }
      : { modelKey }
  })
}

/**
 * 第 `index` 个备用可选的模型：同类型、非自身、服务商与主模型及其他备用都不同。
 * 已选中但不再符合条件的模型仍列出，便于看到并由服务端校验给出原因。
 */
export function selectableFallbacks(
  options: readonly FallbackOption[],
  primary: { kind: Kind; key: string; provider: string },
  value: readonly FallbackDraft[],
  index: number,
): FallbackOption[] {
  const providerOf = (key: string) => options.find((option) => option.key === key)?.provider
  const taken = new Set([
    primary.provider,
    ...value.filter((_, i) => i !== index).map(({ modelKey }) => providerOf(modelKey)),
  ])
  const current = value[index]?.modelKey
  return options.filter(
    (option) =>
      option.key === current ||
      (option.kind === primary.kind && option.key !== primary.key && !taken.has(option.provider)),
  )
}

const optionLabel = (option: FallbackOption) =>
  `${option.displayName ? `${option.displayName} · ` : ''}${option.key} — ${option.provider}${
    option.enabled ? '' : m.admin_disabled_suffix()
  }`

/**
 * 备用模型有序列表（add-media-provider-fallback 7.1）：下拉只列同类型、非自身、
 * 服务商与主模型及其他备用不同的模型；完整校验在服务端共用函数中进行。
 */
export function FallbacksEditor({
  idPrefix,
  kind,
  modelKey,
  provider,
  options,
  value,
  disabled,
  onChange,
}: {
  idPrefix: string
  kind: Kind
  modelKey: string
  provider: string
  options: readonly FallbackOption[]
  value: readonly FallbackDraft[]
  /** 外层 fieldset 的禁用态不会进入 Radix Select，需显式传入 */
  disabled: boolean
  onChange: (value: FallbackDraft[]) => void
}) {
  const hintId = useId()
  const primary = { kind, key: modelKey, provider }
  const hasCandidates = selectableFallbacks(options, primary, [], 0).length > 0
  const update = (index: number, patch: Partial<FallbackDraft>) =>
    onChange(value.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  const remove = (index: number) => onChange(value.filter((_, i) => i !== index))
  const moveUp = (index: number) =>
    onChange(
      value.map((entry, i) => value[i === index ? i - 1 : i === index - 1 ? index : i] ?? entry),
    )

  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-3" aria-describedby={hintId}>
      <legend className="mb-3 font-medium">{m.admin_fallback_models()}</legend>
      <p id={hintId} className="text-muted-foreground text-sm">
        {m.admin_fallback_models_hint({ max: MAX_MODEL_FALLBACKS })}
      </p>
      {value.map((entry, index) => {
        const id = `${idPrefix}-fallback-${index}`
        const selectable = selectableFallbacks(options, primary, value, index)
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: 行按位置编辑，没有稳定 ID；顺序变化时整体重绘即可。
          <div key={index} className="grid min-w-0 gap-3 rounded-md border p-4">
            <div className="grid gap-2">
              <label className="font-medium text-sm" htmlFor={id}>
                {m.admin_fallback_n({ n: index + 1 })}
              </label>
              <Select
                disabled={disabled}
                value={entry.modelKey}
                onValueChange={(next) => update(index, { modelKey: next })}
              >
                <SelectTrigger
                  id={id}
                  className="w-full"
                  placeholder={m.admin_choose_fallback_model()}
                />
                <SelectContent>
                  {selectable.map((option, optionIndex) => (
                    <SelectItem key={option.key} index={optionIndex} value={option.key}>
                      {optionLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {kind !== 'text' && (
              <ParamMapEditor
                id={id}
                rows={entry.params}
                onChange={(params) => update(index, { params })}
              />
            )}
            <div className="flex flex-wrap gap-2">
              {index > 0 && (
                <Button type="button" variant="outline" size="sm" onClick={() => moveUp(index)}>
                  {m.admin_move_fallback_up()}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => remove(index)}>
                {m.admin_remove_fallback()}
              </Button>
            </div>
          </div>
        )
      })}
      {!hasCandidates && value.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m.admin_no_fallback_candidates({ kind })}</p>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          disabled={value.length >= MAX_MODEL_FALLBACKS}
          onClick={() => onChange([...value, { modelKey: '', params: [] }])}
        >
          {m.admin_add_fallback_model()}
        </Button>
      )}
    </fieldset>
  )
}

function ParamMapEditor({
  id,
  rows,
  onChange,
}: {
  id: string
  rows: readonly FallbackDraft['params'][number][]
  onChange: (rows: FallbackDraft['params']) => void
}) {
  const set = (index: number, patch: Partial<FallbackDraft['params'][number]>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  return (
    <div className="grid min-w-0 gap-2">
      <p className="font-medium text-sm">{m.admin_fallback_param_map()}</p>
      <p className="text-muted-foreground text-sm">{m.admin_fallback_param_map_hint()}</p>
      {rows.map((row, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 映射行按位置编辑，没有稳定 ID。
        <div key={index} className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-2 text-sm" htmlFor={`${id}-from-${index}`}>
            {m.admin_fallback_primary_param()}
            <Input
              id={`${id}-from-${index}`}
              className="font-mono"
              value={row.from}
              onChange={(event) => set(index, { from: event.target.value })}
            />
          </label>
          <label className="grid min-w-0 flex-1 gap-2 text-sm" htmlFor={`${id}-to-${index}`}>
            {m.admin_fallback_target_param()}
            <Input
              id={`${id}-to-${index}`}
              className="font-mono"
              value={row.to}
              onChange={(event) => set(index, { to: event.target.value })}
            />
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            {m.admin_remove_param_mapping()}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => onChange([...rows, { from: '', to: '' }])}
      >
        {m.admin_add_param_mapping()}
      </Button>
    </div>
  )
}
