import { Badge, Button, cn, Select, SelectContent, SelectItem, SelectTrigger } from '@saas/ui'
import { useRouter } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { saveAdminFeatureModels } from './feature-models.functions.ts'
import type { AdminFeatureModel } from './feature-models.ts'
import { isStepUpCancelled } from './step-up/client.ts'
import { useStepUpCall } from './step-up/step-up-provider.tsx'
import { panelClass } from './ui.tsx'

// 运行时设置页的「功能模型」分组（设计稿 admin-mcp/Settings.dc.html、SettingsMobile.dc.html）。
// 登记表为空时不渲染；保存只提交有变化的功能，沿用运行时设置的校验与审计。

const UNSET = '__unset__'

const kindLabel = {
  text: () => m.admin_text(),
  image: () => m.admin_image(),
  video: () => m.admin_video(),
} as const

type Tone = 'ok' | 'inherited' | 'warn' | 'bad'

/** 实际使用的模型与来源说明（显式 / 沿用 / 所选已停用 / 未配置） */
export function describeResolution(item: AdminFeatureModel) {
  const { resolved, selectedUnavailable: unavailable } = item
  if (resolved.source === 'unset')
    return {
      tone: 'bad' as Tone,
      model: m.admin_feature_models_unset(),
      source:
        item.inherit.length > 0
          ? m.admin_feature_models_unset_inherit({ from: item.inherit.join(', ') })
          : m.admin_feature_models_unset_hint(),
    }
  if (resolved.source === 'explicit')
    return {
      tone: 'ok' as Tone,
      model: resolved.modelKey,
      source:
        item.inherit.length > 0
          ? m.admin_feature_models_explicit_with_inherit()
          : m.admin_feature_models_explicit(),
    }
  return {
    tone: (unavailable ? 'warn' : 'inherited') as Tone,
    model: resolved.modelKey,
    source: unavailable
      ? m.admin_feature_models_disabled_inherited({ from: resolved.from })
      : m.admin_feature_models_inherited({ from: resolved.from }),
  }
}

const dotClass: Record<Tone, string> = {
  ok: 'bg-success',
  inherited: 'bg-muted-foreground',
  warn: 'bg-warning',
  bad: 'bg-destructive',
}

export function FeatureModelsForm({ items }: { items: readonly AdminFeatureModel[] }) {
  const router = useRouter()
  const initial = () => Object.fromEntries(items.map((item) => [item.feature, item.selected]))
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  // 保存后 loader 重新取数，表单跟随最新的已保存值
  // biome-ignore lint/correctness/useExhaustiveDependencies: items 变化时整体重置
  useEffect(() => setValues(initial()), [items])

  // 与设置页同一动作（setting.update）：改动密钥类设置时要求重新验证
  const save = useStepUpCall(saveAdminFeatureModels, { action: m.admin_feature_models() })
  if (items.length === 0) return null

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await save({ data: { values } })
      if (isStepUpCancelled(result)) return
      setMessage(
        result.ok
          ? m.admin_saved_changes_apply_within_about_60_seconds()
          : m.admin_feature_models_cache_failed(),
      )
      await router.invalidate()
    } catch {
      setMessage(m.admin_feature_models_save_failed())
    } finally {
      setBusy(false)
    }
  }

  const disabled = !hydrated || busy
  return (
    <form onSubmit={submit} aria-labelledby="feature-models-title" className="grid min-w-0 gap-3">
      <section className={cn(panelClass(), 'gap-1')}>
        <div className="grid gap-1 pb-2">
          <h2 id="feature-models-title" className="font-semibold">
            {m.admin_feature_models()}
          </h2>
          <p className="text-muted-foreground text-sm">{m.admin_feature_models_description()}</p>
        </div>
        <div className="hidden gap-4 border-b py-1.5 font-medium text-muted-foreground text-xs md:grid md:grid-cols-3">
          <span>{m.admin_feature_models_col_feature()}</span>
          <span>{m.admin_feature_models_col_model()}</span>
          <span>{m.admin_feature_models_col_resolved()}</span>
        </div>
        {items.map((item, index) => {
          const selected = values[item.feature] ?? ''
          const resolution = describeResolution(item)
          const unavailable = selected !== '' && !item.options.some((o) => o.key === selected)
          const label = m.admin_feature_models_select_label({ feature: item.feature })
          return (
            <div
              key={item.feature}
              className={cn(
                'grid min-w-0 gap-3 py-3 md:grid-cols-3 md:items-center md:gap-4',
                index > 0 && 'border-t',
              )}
            >
              <div className="grid min-w-0 gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-medium">{item.feature}</span>
                  <Badge color="gray" size="compact">
                    {kindLabel[item.kind]()}
                  </Badge>
                </div>
                {/* 设置键与沿用说明分行；键名过长时截断并以 title 显示全名，沿用说明按词换行 */}
                <span
                  className="truncate font-mono text-muted-foreground text-xs"
                  title={`ai.model.${item.feature}`}
                >
                  {`ai.model.${item.feature}`}
                </span>
                {item.inherit.length > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {m.admin_feature_models_inherit_note({ from: item.inherit.join(' → ') })}
                  </span>
                ) : null}
              </div>
              <Select
                value={selected === '' ? UNSET : selected}
                disabled={disabled}
                onValueChange={(value) =>
                  setValues((current) => ({
                    ...current,
                    [item.feature]: value === UNSET ? '' : value,
                  }))
                }
              >
                <SelectTrigger
                  aria-label={label}
                  className={cn('w-full', unavailable && 'border-warning')}
                  placeholder={m.admin_feature_models_unselected()}
                  valueLabel={
                    selected === ''
                      ? m.admin_feature_models_unselected()
                      : unavailable
                        ? m.admin_feature_models_disabled_choice({ key: selected })
                        : selected
                  }
                />
                <SelectContent>
                  <SelectItem index={0} value={UNSET}>
                    {m.admin_feature_models_unselected_option()}
                  </SelectItem>
                  {item.options.map((option, optionIndex) => (
                    <SelectItem key={option.key} index={optionIndex + 1} value={option.key}>
                      {option.key}
                      <span className="ml-2 font-mono text-muted-foreground text-xs">
                        {option.provider}/{option.providerModelId}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn('size-2 shrink-0 rounded-full', dotClass[resolution.tone])}
                />
                <span className="grid min-w-0 gap-0.5">
                  <span
                    className={cn(
                      'truncate font-medium text-sm',
                      resolution.tone === 'bad' && 'text-destructive',
                    )}
                  >
                    {resolution.model}
                  </span>
                  <span
                    className={cn(
                      'text-xs',
                      resolution.tone === 'warn'
                        ? 'text-warning'
                        : resolution.tone === 'bad'
                          ? 'text-destructive'
                          : 'text-muted-foreground',
                    )}
                  >
                    {resolution.source}
                  </span>
                </span>
              </div>
            </div>
          )
        })}
      </section>
      <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-end">
        <span className="text-muted-foreground text-xs">{m.admin_feature_models_mcp_hint()}</span>
        <Button type="submit" disabled={disabled} className="md:w-fit">
          {m.admin_feature_models_save()}
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </form>
  )
}
