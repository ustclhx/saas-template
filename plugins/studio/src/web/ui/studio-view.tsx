import { fileUploadActions, type MediaFile, uploadMediaFile } from '@saas/plugin-media/client'
import { MediaParameterFields } from '@saas/plugin-media/parameter-form'
import { pollMediaTask } from '@saas/plugin-media/polling'
import {
  initialMediaParams,
  type MediaParams,
  type MediaSchema,
  mediaCreditEstimate,
  parseMediaSchema,
  validateMediaParams,
} from '@saas/plugin-media/schema'
import {
  cancelMediaTask,
  getMediaTask,
  type MediaCancelPreview,
  type MediaTask,
  previewMediaCancel,
} from '@saas/plugin-media/tasks-client'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  cn,
  FieldErrors,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tabs,
  TabsItem,
  Textarea,
} from '@saas/ui'
import { ChevronDown, ImageIcon, Plus, Sparkles } from '@saas/ui/icons'
import { Link } from '@tanstack/react-router'
import { trackEvent } from '@web/features/analytics/track.ts'
import { AppShellBar } from '@web/features/app-shell/bar.tsx'
import { FormAlert } from '@web/features/auth/auth-layout.tsx'
import { HydratedControls } from '@web/features/workspace/components.tsx'
import { m } from '@web/paraglide/messages.js'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { StudioKind } from '../../kinds.ts'
import type { getStudioSubmitPage } from '../submit.functions.ts'
import { submitStudio } from '../submit.functions.ts'
import { type StudioWorksPage, studioFileUrl } from '../works.functions.ts'
import { type PublishedWork, type PublishTarget, PublishWorkDialog } from './publish-dialog.tsx'
import { formatBytes, studioWorkBadge } from './work-state.ts'
import { WorkMedia } from './works-view.tsx'

export type StudioSubmitPage = Awaited<ReturnType<typeof getStudioSubmitPage>>
type StudioModel = StudioSubmitPage['models'][number]

export interface StudioSearch {
  mode?: StudioKind | undefined
  model?: string | undefined
  prompt?: string | undefined
}

const PROMPT_MAX = 2000
const PROMPT_FIELD = 'prompt'

interface ParsedModel {
  schema: MediaSchema
  defaults: MediaParams
  /** 「更多设置」中的参数：去掉提示词与参考图字段 */
  extra: MediaSchema
  fileFields: string[]
  promptMax: number
}

function parseModel(model: StudioModel): ParsedModel | null {
  try {
    const schema = parseMediaSchema(
      model.paramsSchema === null ? null : JSON.parse(model.paramsSchema),
    )
    const fileFields = Object.entries(schema.properties)
      .filter(([, field]) => field.format === 'file')
      .map(([name]) => name)
    const hidden = new Set([PROMPT_FIELD, ...fileFields])
    const extra: MediaSchema = {
      ...schema,
      properties: Object.fromEntries(
        Object.entries(schema.properties).filter(([name]) => !hidden.has(name)),
      ),
      required: schema.required.filter((name) => !hidden.has(name)),
    }
    return {
      schema,
      defaults: initialMediaParams(schema),
      extra,
      fileFields,
      promptMax: Math.min(schema.properties[PROMPT_FIELD]?.maxLength ?? PROMPT_MAX, PROMPT_MAX),
    }
  } catch {
    return null
  }
}

type Run = {
  taskId: string
  mode: StudioKind
  credits: number | undefined
  task: MediaTask | null
} | null

function errorCode(cause: unknown) {
  return cause instanceof Error ? cause.message : undefined
}

function submitErrorMessage(code: string) {
  switch (code) {
    case 'UPGRADE_REQUIRED':
    case 'MODEL_UNAVAILABLE':
      return m.studio_error_upgrade()
    case 'QUOTA_EXCEEDED':
      return m.studio_error_quota()
    case 'STUDIO_REFERENCE_REQUIRED':
      return m.studio_reference_missing()
    case 'STUDIO_REFERENCE_INVALID':
      return m.studio_reference_invalid()
    case 'RATE_LIMITED':
    case 'CONCURRENCY_LIMIT':
      return m.studio_error_busy()
    case 'WORKSPACE_READ_ONLY':
      return m.studio_readonly()
    default:
      return m.studio_error_submit()
  }
}

/**
 * 创作页（设计稿 media-studio/Main.dc.html、StudioMobile.dc.html）：桌面左栏为生成设置、右栏为本次结果与最近作品；
 * 手机按设置 → 结果 → 底部固定操作栏排列。只显示启用的模式；`search` 支持「做同款」预填模型与提示词。
 */
export function StudioView({
  page,
  recent,
  search,
}: {
  page: StudioSubmitPage
  recent: StudioWorksPage | null
  search: StudioSearch
}) {
  const slug = page.workspaceSlug
  const initialModel = page.models.find((model) => model.key === search.model)
  const [mode, setMode] = useState<StudioKind>(
    (initialModel?.kind as StudioKind | undefined) ??
      (search.mode && page.kinds.includes(search.mode) ? search.mode : undefined) ??
      page.kinds[0] ??
      'image',
  )
  const [modelByMode, setModelByMode] = useState<Partial<Record<StudioKind, string>>>(
    initialModel ? { [initialModel.kind]: initialModel.key } : {},
  )
  const [prompt, setPrompt] = useState((search.prompt ?? '').slice(0, PROMPT_MAX))
  const [paramsByModel, setParamsByModel] = useState<Record<string, MediaParams>>({})
  const [presetId, setPresetId] = useState<string | undefined>()
  const [files, setFiles] = useState<MediaFile[]>(page.files)
  const [moreOpen, setMoreOpen] = useState(false)
  const [errors, setErrors] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [shortfall, setShortfall] = useState<{ estimated: number; available: number } | null>(null)
  const [pending, setPending] = useState(false)
  const [uploading, setUploading] = useState<string>()
  const [run, setRun] = useState<Run>(null)
  const [published, setPublished] = useState<Record<string, PublishedWork>>({})
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null)
  const [quota, setQuota] = useState(recent?.quota ?? null)
  const promptId = useId()
  const modelId = useId()

  const models = page.models.filter((model) => model.kind === mode)
  const model = models.find((item) => item.key === modelByMode[mode]) ?? models[0]
  const parsed = useMemo(() => (model ? parseModel(model) : null), [model])
  const params = (model && paramsByModel[model.key]) ?? parsed?.defaults ?? {}
  const presets = page.presets.filter((preset) => preset.mode === mode)
  const running =
    run !== null && (run.task === null || ['queued', 'running'].includes(run.task.status))
  const busy = pending || uploading !== undefined || running

  let estimate: number | undefined
  if (model && parsed) {
    try {
      estimate = mediaCreditEstimate(model, parsed.schema, { ...params, [PROMPT_FIELD]: prompt })
    } catch {
      // 计费用量参数缺失或不合法时不给出误导性的预计值。
    }
  }
  const insufficient =
    shortfall ??
    (estimate !== undefined && (page.balance.debt > 0 || estimate > page.balance.available)
      ? { estimated: estimate, available: page.balance.available }
      : null)
  const canSubmit =
    !page.readOnly && !busy && model !== undefined && prompt.trim().length > 0 && !insufficient

  // 轮询复用 media 的退避与「页面隐藏时暂停」；终态后停止。
  const taskId = run?.taskId
  useEffect(() => {
    if (!taskId) return
    const poll = pollMediaTask({
      load: (signal) => getMediaTask(page.workspaceId, taskId, signal),
      onTask: (task) => {
        setRun((current) => (current?.taskId === task.id ? { ...current, task } : current))
        if (task.status === 'succeeded') trackEvent('generate_success')
      },
      onError: () => setError(m.studio_error_poll()),
    })
    return () => poll.stop()
  }, [taskId, page.workspaceId])

  function changeParam(name: string, value: string | number | boolean | undefined) {
    if (!model) return
    setParamsByModel((current) => {
      const next = { ...(current[model.key] ?? parsed?.defaults ?? {}) }
      if (value === undefined) delete next[name]
      else next[name] = value
      return { ...current, [model.key]: next }
    })
    setErrors((current) => ({ ...current, [name]: [] }))
    setShortfall(null)
  }

  async function upload(name: string, file: File) {
    if (busy || page.readOnly) return
    setUploading(name)
    setError(null)
    try {
      const ready = await uploadMediaFile(page.workspaceId, file, fileUploadActions)
      setFiles((current) => [ready, ...current])
      changeParam(name, ready.id)
      trackEvent('upload')
    } catch (cause) {
      setError(
        errorCode(cause) === 'QUOTA_EXCEEDED' ? m.studio_error_quota() : m.studio_upload_error(),
      )
    } finally {
      setUploading(undefined)
    }
  }

  async function submit() {
    if (!model || !parsed || !canSubmit) return
    setError(null)
    const validated = validateMediaParams(
      parsed.schema,
      { ...params, [PROMPT_FIELD]: prompt },
      files,
      mode,
    )
    if (!validated.success) {
      const next: Record<string, string[]> = {}
      for (const issue of validated.error.issues) {
        const field = String(issue.path[0])
        next[field] = [
          parsed.fileFields.includes(field) ? m.studio_reference_missing() : m.studio_invalid(),
        ]
      }
      setErrors(next)
      if (Object.keys(next).some((field) => field in parsed.extra.properties)) setMoreOpen(true)
      return
    }
    const { [PROMPT_FIELD]: _prompt, ...rest } = validated.data
    setPending(true)
    trackEvent('generate_start')
    try {
      const result = await submitStudio({
        data: {
          slug,
          mode,
          modelKey: model.key,
          prompt,
          ...(presetId !== undefined && { presetId }),
          params: rest as Record<string, string | number | boolean>,
        },
      })
      if (result.ok) {
        setRun({ taskId: result.taskId, mode, credits: estimate, task: null })
        return
      }
      const { code, details } = result.error
      if (code === 'INSUFFICIENT_CREDITS' || code === 'CREDIT_DEBT') {
        trackEvent('paywall_view')
        setShortfall({
          estimated:
            details && 'estimatedCredits' in details ? details.estimatedCredits : (estimate ?? 0),
          available:
            details && 'availableCredits' in details
              ? details.availableCredits
              : page.balance.available,
        })
        return
      }
      trackEvent('generate_fail')
      if (code === 'STUDIO_REFERENCE_REQUIRED' && details && 'field' in details)
        setErrors({ [details.field]: [m.studio_reference_missing()] })
      setError(submitErrorMessage(code))
    } catch {
      trackEvent('generate_fail')
      setError(m.studio_error_submit())
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-y-4 lg:grid-cols-2 lg:gap-x-0 xl:grid-cols-3">
      <AppShellBar
        actions={
          <span className="text-caption text-muted-foreground" data-testid="studio-balance">
            {m.studio_balance({ credits: page.balance.available })}
          </span>
        }
      />
      <section
        aria-label={m.studio_settings_label()}
        className="grid content-start gap-4 lg:row-start-1 lg:border-border lg:border-r lg:pr-6"
      >
        <p className="text-muted-foreground max-md:hidden">{m.studio_description()}</p>
        {page.readOnly ? <p role="status">{m.studio_readonly()}</p> : null}
        {page.kinds.length > 1 ? (
          <Tabs
            aria-label={m.studio_mode_label()}
            selectedIndex={Math.max(0, page.kinds.indexOf(mode))}
            onSelect={(index) => {
              const next = page.kinds[index]
              if (next && next !== mode) {
                setMode(next)
                setPresetId(undefined)
                setErrors({})
                setShortfall(null)
              }
            }}
            className="w-full"
          >
            {page.kinds.map((kind, index) => (
              <TabsItem
                key={kind}
                index={index}
                label={kind === 'image' ? m.studio_mode_image() : m.studio_mode_video()}
                className="flex-1"
              />
            ))}
          </Tabs>
        ) : null}
        {model && parsed ? (
          <HydratedControls>
            <form
              id="studio-form"
              className="grid gap-4"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void submit()
              }}
            >
              <fieldset disabled={page.readOnly} className="grid gap-4">
                <div className="grid gap-1.5">
                  <Label htmlFor={promptId}>{m.studio_prompt()}</Label>
                  <Textarea
                    id={promptId}
                    rows={4}
                    value={prompt}
                    maxLength={parsed.promptMax}
                    placeholder={
                      mode === 'image'
                        ? m.studio_prompt_placeholder_image()
                        : m.studio_prompt_placeholder_video()
                    }
                    aria-invalid={(errors[PROMPT_FIELD]?.length ?? 0) > 0 || undefined}
                    aria-describedby={
                      errors[PROMPT_FIELD]?.length ? `${promptId}-error` : undefined
                    }
                    onChange={(event) => {
                      setPrompt(event.target.value)
                      setErrors((current) => ({ ...current, [PROMPT_FIELD]: [] }))
                    }}
                  />
                  <div className="flex items-start gap-2">
                    <FieldErrors id={`${promptId}-error`} errors={errors[PROMPT_FIELD] ?? []} />
                    <span className="ml-auto text-caption text-muted-foreground max-md:hidden">
                      {m.studio_prompt_count({ count: prompt.length, max: parsed.promptMax })}
                    </span>
                  </div>
                </div>
                <Collapsible open={moreOpen} onOpenChange={setMoreOpen} className="grid gap-4">
                  <div className="flex items-end gap-2">
                    <div className="grid min-w-0 flex-1 gap-1.5">
                      <Label htmlFor={modelId} className="max-md:sr-only">
                        {m.studio_model()}
                      </Label>
                      <Select
                        value={model.key}
                        disabled={busy}
                        onValueChange={(key) => {
                          setModelByMode((current) => ({ ...current, [mode]: key }))
                          setErrors({})
                          setShortfall(null)
                        }}
                      >
                        <SelectTrigger
                          id={modelId}
                          className="w-full"
                          placeholder={m.studio_model()}
                          valueLabel={model.displayName}
                        />
                        <SelectContent>
                          {models.map((item, index) => (
                            <SelectItem key={item.key} index={index} value={item.key}>
                              {item.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {Object.keys(parsed.extra.properties).length > 0 ? (
                      <CollapsibleTrigger asChild>
                        <Button type="button" variant="outline" className="md:hidden">
                          {m.studio_more_settings()}
                        </Button>
                      </CollapsibleTrigger>
                    ) : null}
                  </div>
                  {parsed.fileFields.map((name) => (
                    <ReferencePicker
                      key={name}
                      name={name}
                      mode={mode}
                      required={parsed.schema.required.includes(name)}
                      workspaceId={page.workspaceId}
                      files={files}
                      value={
                        typeof params[name] === 'string' ? (params[name] as string) : undefined
                      }
                      errors={errors[name] ?? []}
                      disabled={busy || page.readOnly}
                      uploading={uploading === name}
                      onChange={(fileId) => changeParam(name, fileId)}
                      onUpload={(file) => void upload(name, file)}
                    />
                  ))}
                  {presets.length > 0 ? (
                    <fieldset className="grid gap-1.5">
                      <legend className="mb-1.5 font-medium text-caption">
                        {m.studio_presets()}
                      </legend>
                      <div className="flex gap-1.5 max-md:overflow-x-auto md:flex-wrap">
                        {presets.map((preset) => {
                          const selected = preset.id === presetId
                          return (
                            <Button
                              key={preset.id}
                              type="button"
                              size="compact"
                              variant={selected ? 'default' : 'outline'}
                              aria-pressed={selected}
                              className="rounded-full"
                              onClick={() => setPresetId(selected ? undefined : preset.id)}
                            >
                              {preset.name}
                            </Button>
                          )
                        })}
                      </div>
                    </fieldset>
                  ) : null}
                  {Object.keys(parsed.extra.properties).length > 0 ? (
                    <div className="grid gap-2.5 md:border-border md:border-t md:pt-1">
                      <CollapsibleTrigger className="flex h-8 items-center justify-between rounded-md font-medium text-caption max-md:hidden">
                        {m.studio_more_settings()}
                        <ChevronDown
                          aria-hidden="true"
                          className={cn(
                            'size-4 text-muted-foreground transition-transform motion-reduce:transition-none',
                            moreOpen && 'rotate-180',
                          )}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        {/* 内边距给字段的焦点环留出位置（折叠区 overflow-hidden） */}
                        <div className="grid grid-cols-2 gap-3 p-1 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
                          <MediaParameterFields
                            schema={parsed.extra}
                            params={params}
                            files={files}
                            errors={errors}
                            disabled={busy || page.readOnly}
                            onChange={changeParam}
                            onUpload={() => {}}
                          />
                        </div>
                      </CollapsibleContent>
                    </div>
                  ) : null}
                </Collapsible>
              </fieldset>
            </form>
          </HydratedControls>
        ) : model ? (
          <p role="alert">{m.studio_model_unsupported()}</p>
        ) : (
          <div role="status" className="grid gap-2 rounded-xl border border-border p-4">
            <p>{mode === 'image' ? m.studio_no_models_image() : m.studio_no_models_video()}</p>
            <Link to="/app/$slug/billing" params={{ slug }} className="text-primary-text underline">
              {m.studio_upgrade_link()}
            </Link>
          </div>
        )}
      </section>

      <section
        aria-label={m.studio_results_label()}
        className="grid content-start gap-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pl-6 xl:col-span-2"
      >
        <Results
          slug={slug}
          workspaceId={page.workspaceId}
          run={run}
          published={published}
          canPublish={!page.readOnly}
          onPublish={setPublishTarget}
          prompt={prompt}
          onRetryError={setError}
        />
        {recent && recent.works.length > 0 ? (
          <div className="grid gap-2.5 max-md:hidden">
            <div className="flex items-center">
              <h2 className="flex-1 font-semibold">{m.studio_recent()}</h2>
              <Link
                to="/app/$slug/studio/works"
                params={{ slug }}
                className="text-caption text-muted-foreground hover:underline"
              >
                {m.studio_view_all()}
              </Link>
            </div>
            <ul className="grid grid-cols-3 gap-2.5 xl:grid-cols-6">
              {recent.works.slice(0, 6).map((item) => {
                const work = published[item.fileId] ?? item.work
                const label = item.work?.title || item.prompt || item.modelDisplayName
                return (
                  <li key={item.fileId}>
                    <Link
                      to="/app/$slug/studio/works"
                      params={{ slug }}
                      className="relative block h-24 overflow-hidden rounded-lg bg-secondary"
                      aria-label={label}
                    >
                      <WorkMedia kind={item.kind} url={item.url} label="" />
                      {work && work.visibility === 'public' ? (
                        <Badge
                          size="compact"
                          color={studioWorkBadge(work).color}
                          className="absolute top-1.5 left-1.5"
                        >
                          {m.studio_state_public_short()}
                        </Badge>
                      ) : null}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </section>

      <div className="grid gap-2 max-lg:sticky max-lg:bottom-0 max-lg:z-(--z-sticky) max-lg:-mx-4 max-lg:border-border max-lg:border-t max-lg:bg-card max-lg:px-4 max-lg:py-3 lg:row-start-2 lg:self-end lg:border-border lg:border-r lg:pt-2 lg:pr-6">
        {insufficient ? (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-lg bg-destructive-light px-3 py-2.5 text-destructive"
          >
            <span className="flex-1">
              {m.studio_insufficient({
                cost: insufficient.estimated,
                balance: insufficient.available,
              })}
            </span>
            <Link
              to="/app/$slug/billing"
              hash="credit-packs"
              params={{ slug }}
              className="font-semibold underline"
            >
              {m.studio_recharge()}
            </Link>
          </div>
        ) : null}
        <FormAlert message={error} />
        <div className="flex items-center gap-3">
          <p className="flex-1 text-caption text-muted-foreground" data-testid="studio-estimate">
            {estimate === undefined ? (
              m.studio_estimate_unavailable()
            ) : (
              <>
                {m.studio_estimate_prefix()} <strong className="text-foreground">{estimate}</strong>{' '}
                {m.studio_estimate_suffix()}
              </>
            )}
          </p>
          <Button
            type="submit"
            form="studio-form"
            className="max-md:min-w-30"
            disabled={!canSubmit}
            aria-busy={pending || running}
          >
            {pending || running ? m.studio_generating() : m.studio_generate()}
          </Button>
        </div>
      </div>

      <PublishWorkDialog
        slug={slug}
        target={publishTarget}
        quota={quota}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(null)
        }}
        onPublished={(fileId, work) => {
          setPublishTarget(null)
          setPublished((current) => ({ ...current, [fileId]: work }))
          setQuota((current) =>
            current ? { ...current, remaining: Math.max(0, current.remaining - 1) } : current,
          )
        }}
      />
    </div>
  )
}

function ReferencePicker({
  name,
  mode,
  required,
  workspaceId,
  files,
  value,
  errors,
  disabled,
  uploading,
  onChange,
  onUpload,
}: {
  name: string
  mode: StudioKind
  required: boolean
  workspaceId: string
  files: readonly MediaFile[]
  value: string | undefined
  errors: string[]
  disabled: boolean
  uploading: boolean
  onChange: (fileId: string | undefined) => void
  onUpload: (file: File) => void
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const images = files.filter((file) => file.status === 'ready' && file.mime.startsWith('image/'))
  const selected = images.find((file) => file.id === value)
  const label = required
    ? mode === 'video'
      ? m.studio_reference_required_video()
      : m.studio_reference_required_image()
    : m.studio_reference_optional()
  return (
    <div className="grid gap-1.5" data-field={name}>
      <span className="font-medium text-caption" id={`${id}-label`}>
        {label}
      </span>
      {selected ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-border bg-card p-2">
          <img
            src={studioFileUrl(workspaceId, selected.id)}
            alt={m.studio_reference_selected()}
            className="size-14 shrink-0 rounded-lg bg-secondary object-cover"
          />
          <span className="grid min-w-0 flex-1">
            <span className="truncate font-medium">{m.studio_reference_selected()}</span>
            <span className="text-caption text-muted-foreground">
              {selected.mime} · {formatBytes(selected.size)}
            </span>
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(undefined)}
          >
            {m.studio_reference_change()}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-2">
          {images.length > 0 ? (
            <div className="min-w-0 flex-1">
              <Select value="" disabled={disabled} onValueChange={(fileId) => onChange(fileId)}>
                <SelectTrigger
                  aria-labelledby={`${id}-label`}
                  aria-invalid={errors.length > 0 || undefined}
                  aria-describedby={errors.length > 0 ? `${id}-error` : undefined}
                  className="w-full"
                  placeholder={m.studio_reference_choose()}
                />
                <SelectContent>
                  {images.map((file, index) => (
                    <SelectItem key={file.id} index={index} value={file.id}>
                      {file.mime} · {formatBytes(file.size)} · {file.id.slice(-8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <span className="flex flex-1 items-center gap-2 text-muted-foreground">
              <ImageIcon aria-hidden="true" className="size-4" />
              {m.studio_reference_none()}
            </span>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            leadingIcon={Plus}
            loading={uploading}
            disabled={disabled}
            onClick={() => input.current?.click()}
          >
            {m.studio_reference_upload()}
          </Button>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-label={m.studio_reference_upload()}
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onUpload(file)
              event.target.value = ''
            }}
          />
        </div>
      )}
      {uploading ? (
        <p role="status" className="text-caption text-muted-foreground">
          {m.studio_reference_uploading()}
        </p>
      ) : null}
      <FieldErrors id={`${id}-error`} errors={errors} />
    </div>
  )
}

function Results({
  slug,
  workspaceId,
  run,
  published,
  canPublish,
  onPublish,
  prompt,
  onRetryError,
}: {
  slug: string
  workspaceId: string
  run: Run
  published: Record<string, PublishedWork>
  canPublish: boolean
  onPublish: (target: PublishTarget) => void
  prompt: string
  onRetryError: (message: string | null) => void
}) {
  const [cancelPreview, setCancelPreview] = useState<MediaCancelPreview | null>(null)
  const [canceling, setCanceling] = useState(false)
  const task = run?.task ?? null
  const status = task?.status ?? (run ? 'queued' : null)
  const files = task?.status === 'succeeded' ? task.files : []
  const first = files[0]
  const doneMeta =
    task?.status === 'succeeded' && first
      ? [
          first.width && first.height ? `${first.width} × ${first.height}` : null,
          run?.mode === 'video' && first.duration
            ? m.studio_seconds({ seconds: Math.round(first.duration) })
            : files.length > 1
              ? m.studio_count({ count: files.length })
              : null,
          task.creditsCharged !== null ? m.studio_charged({ credits: task.creditsCharged }) : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : null

  async function openCancel() {
    if (!run) return
    try {
      setCancelPreview(await previewMediaCancel(workspaceId, run.taskId))
    } catch {
      onRetryError(m.studio_error_cancel())
    }
  }

  async function confirmCancel() {
    if (!run) return
    setCanceling(true)
    try {
      await cancelMediaTask(workspaceId, run.taskId)
    } catch {
      onRetryError(m.studio_error_cancel())
    } finally {
      setCanceling(false)
      setCancelPreview(null)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-semibold">{m.studio_results()}</h2>
        {doneMeta ? (
          <span className="text-caption text-muted-foreground" data-testid="studio-result-meta">
            {doneMeta}
          </span>
        ) : null}
      </div>
      {status === null ? (
        <div className="grid min-h-48 place-content-center justify-items-center gap-2.5 rounded-xl border border-border p-4 text-center lg:min-h-96">
          <span
            aria-hidden="true"
            className="grid size-10 place-content-center rounded-full bg-secondary max-md:hidden"
          >
            <Sparkles className="size-4" />
          </span>
          <p className="font-semibold">{m.studio_empty_title()}</p>
          <p className="max-w-sm text-muted-foreground max-md:text-caption">
            {m.studio_empty_body()}
          </p>
        </div>
      ) : status === 'queued' || status === 'running' ? (
        <div className="grid gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-hidden="true">
            <div className="h-64 animate-pulse rounded-lg bg-active motion-reduce:animate-none lg:h-80" />
            <div className="h-80 animate-pulse rounded-lg bg-active motion-reduce:animate-none max-md:hidden" />
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <p role="status" className="flex-1 max-md:text-caption">
              {m.studio_running()}
            </p>
            {task?.canCancel !== false ? (
              <Button
                type="button"
                size="compact"
                variant="ghost"
                onClick={() => void openCancel()}
              >
                {m.studio_cancel()}
              </Button>
            ) : null}
          </div>
        </div>
      ) : status === 'succeeded' ? (
        <ul
          aria-label={m.studio_results()}
          className={cn(
            'grid gap-3',
            run?.mode === 'image' && files.length > 1 && 'md:grid-cols-2',
          )}
        >
          {files.map((file, index) => {
            const work = published[file.id]
            const label = m.studio_result_label({ index: index + 1 })
            return (
              <li key={file.id} className="grid gap-2">
                {run?.mode === 'video' ? (
                  // 原生播放器：键盘可操作、支持 Range 拖动；首帧预加载
                  // biome-ignore lint/a11y/useMediaCaption: 生成接口没有字幕产出，不能提供虚构字幕。
                  <video
                    src={file.downloadUrl}
                    controls
                    preload="metadata"
                    playsInline
                    aria-label={label}
                    className="aspect-video max-h-120 w-full rounded-lg bg-secondary"
                  />
                ) : (
                  <img
                    src={file.downloadUrl}
                    alt={label}
                    width={file.width ?? undefined}
                    height={file.height ?? undefined}
                    className="h-auto max-h-120 w-full rounded-lg bg-secondary object-contain"
                  />
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  {work ? (
                    <>
                      <Badge color={studioWorkBadge(work).color} data-testid="studio-result-state">
                        {studioWorkBadge(work).label}
                      </Badge>
                      <Link
                        to="/app/$slug/studio/works"
                        params={{ slug }}
                        className="text-caption text-muted-foreground hover:underline"
                      >
                        {m.studio_manage_in_works()}
                      </Link>
                    </>
                  ) : canPublish ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        onPublish({
                          fileId: file.id,
                          kind: run?.mode ?? 'image',
                          url: file.downloadUrl,
                          prompt,
                        })
                      }
                    >
                      {m.studio_publish_to_gallery()}
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="outline">
                    <a href={`${file.downloadUrl}&download=1`}>{m.studio_download()}</a>
                  </Button>
                  {run ? (
                    <Link
                      to="/app/$slug/tasks/$taskId"
                      params={{ slug, taskId: run.taskId }}
                      className="ml-auto text-caption text-muted-foreground hover:underline"
                    >
                      {m.studio_view_task()}
                    </Link>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div role="alert" className="grid gap-1 rounded-xl border border-border p-4">
          <p className="font-semibold">
            {status === 'canceled' ? m.studio_canceled_title() : m.studio_failed_title()}
          </p>
          <p className="text-muted-foreground">{m.studio_failed_body()}</p>
        </div>
      )}

      <AlertDialog
        open={cancelPreview !== null}
        onOpenChange={(open) => {
          if (!open && !canceling) setCancelPreview(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.studio_cancel_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelPreview ? cancelText(cancelPreview) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={canceling}>{m.studio_cancel_keep()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={canceling}
              onClick={(event) => {
                event.preventDefault()
                void confirmCancel()
              }}
            >
              {m.studio_cancel_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 与任务详情页同一口径：未开始免费、首次已开始免费、之后按全价。 */
function cancelText(preview: MediaCancelPreview) {
  if (!preview.started) return m.studio_cancel_unstarted()
  if (!preview.charged) return m.studio_cancel_free_started()
  return m.studio_cancel_charged({ credits: preview.credits })
}
