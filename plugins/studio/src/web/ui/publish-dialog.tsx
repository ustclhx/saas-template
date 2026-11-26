import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Switch,
} from '@saas/ui'
import { FormAlert } from '@web/features/auth/auth-layout.tsx'
import { m } from '@web/paraglide/messages.js'
import { type FormEvent, useId, useState } from 'react'
import type { StudioKind } from '../../kinds.ts'
import {
  publishStudioWorkFn,
  type StudioActionError,
  type StudioWorksPage,
} from '../works.functions.ts'
import { useDesktop } from './use-desktop.ts'
import { defaultWorkTitle, formatWorkTime, STUDIO_TITLE_MAX } from './work-state.ts'

export interface PublishTarget {
  fileId: string
  kind: StudioKind
  url: string
  prompt: string | null
  /** 曾经发布过（已取消发布）的作品沿用原标题 */
  title?: string | null
  showPrompt?: boolean | null
}

export type PublishedWork = Extract<
  Awaited<ReturnType<typeof publishStudioWorkFn>>,
  { ok: true }
>['work']

export function publishErrorMessage(error: StudioActionError) {
  switch (error.code) {
    case 'STUDIO_PUBLISH_LIMIT':
      return error.details
        ? m.studio_publish_limit_error({
            limit: error.details.limit ?? 0,
            time: formatWorkTime(error.details.resetsAt ?? new Date().toISOString()),
          })
        : m.studio_publish_limit_error_plain()
    case 'STUDIO_PUBLISH_REJECTED':
      return m.studio_publish_rejected({ reason: error.message })
    case 'STUDIO_WORK_REMOVED':
      return m.studio_publish_removed()
    case 'STUDIO_TITLE_INVALID':
      return m.studio_publish_title_invalid()
    case 'WORKSPACE_READ_ONLY':
      return m.studio_readonly()
    default:
      return m.studio_action_error()
  }
}

/**
 * 发布到画廊：桌面为 Dialog，手机为底部 Sheet（设计稿 Works / WorksMobile 的 publishDialog 状态）。
 * 打开期间不随断点切换形态；表单在每次打开时按作品重新初始化。
 */
export function PublishWorkDialog({
  slug,
  target,
  quota,
  onOpenChange,
  onPublished,
}: {
  slug: string
  target: PublishTarget | null
  quota: StudioWorksPage['quota'] | null
  onOpenChange: (open: boolean) => void
  onPublished: (fileId: string, work: PublishedWork) => void
}) {
  const desktop = useDesktop()
  const [layoutDesktop, setLayoutDesktop] = useState(desktop)
  if (!target && layoutDesktop !== desktop) setLayoutDesktop(desktop)
  const open = target !== null
  const body = target ? (
    <PublishForm
      key={target.fileId}
      slug={slug}
      target={target}
      quota={quota}
      desktop={layoutDesktop}
      onCancel={() => onOpenChange(false)}
      onPublished={onPublished}
    />
  ) : null
  return layoutDesktop ? (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" closeLabel={m.studio_close()}>
        <DialogHeader>
          <DialogTitle>{m.studio_publish_title()}</DialogTitle>
          <DialogDescription>{m.studio_publish_description()}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  ) : (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>{m.studio_publish_title()}</SheetTitle>
          <SheetDescription>{m.studio_publish_description_short()}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{body}</div>
      </SheetContent>
    </Sheet>
  )
}

function PublishForm({
  slug,
  target,
  quota,
  desktop,
  onCancel,
  onPublished,
}: {
  slug: string
  target: PublishTarget
  quota: StudioWorksPage['quota'] | null
  desktop: boolean
  onCancel: () => void
  onPublished: (fileId: string, work: PublishedWork) => void
}) {
  const titleId = useId()
  const hintId = useId()
  const [title, setTitle] = useState(target.title ?? defaultWorkTitle(target.prompt))
  const [showPrompt, setShowPrompt] = useState(target.showPrompt ?? true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const exhausted = quota !== null && quota.remaining <= 0

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    if (!title.trim()) {
      setError(m.studio_publish_title_invalid())
      return
    }
    setPending(true)
    setError(null)
    try {
      const result = await publishStudioWorkFn({
        data: { slug, fileId: target.fileId, title, showPrompt },
      })
      if (result.ok) onPublished(target.fileId, result.work)
      else setError(publishErrorMessage(result.error))
    } catch {
      setError(m.studio_action_error())
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="grid gap-4" noValidate onSubmit={(event) => void submit(event)}>
      <div className="flex gap-3">
        {desktop ? (
          target.kind === 'video' ? (
            <video
              src={target.url}
              preload="metadata"
              muted
              className="size-24 shrink-0 rounded-lg bg-secondary object-cover"
              aria-label={m.studio_publish_preview()}
            />
          ) : (
            <img
              src={target.url}
              alt=""
              className="size-24 shrink-0 rounded-lg bg-secondary object-cover"
            />
          )
        ) : null}
        <div className="grid flex-1 content-start gap-1.5">
          <Label htmlFor={titleId}>{m.studio_publish_field_title()}</Label>
          <Input
            id={titleId}
            value={title}
            maxLength={STUDIO_TITLE_MAX}
            required
            aria-describedby={desktop ? hintId : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {desktop ? (
            <p id={hintId} className="text-caption text-muted-foreground">
              {m.studio_publish_title_hint({ max: STUDIO_TITLE_MAX })}
            </p>
          ) : null}
        </div>
      </div>
      <div className="rounded-lg bg-secondary px-3 py-2">
        <Switch
          checked={showPrompt}
          onToggle={() => setShowPrompt((value) => !value)}
          label={
            <span className="grid">
              <span className="font-medium">{m.studio_publish_show_prompt()}</span>
              <span className="text-caption text-muted-foreground">
                {desktop
                  ? m.studio_publish_show_prompt_hint()
                  : m.studio_publish_show_prompt_hint_short()}
              </span>
            </span>
          }
        />
      </div>
      <FormAlert message={error} />
      <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-2">
        {quota ? (
          <p
            className="flex-1 text-caption text-muted-foreground max-md:col-span-2"
            data-testid="studio-publish-quota"
          >
            {m.studio_publish_quota({ remaining: quota.remaining, limit: quota.limit })}
          </p>
        ) : (
          <span className="flex-1 max-md:hidden" />
        )}
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          {m.studio_cancel()}
        </Button>
        <Button type="submit" loading={pending} disabled={exhausted}>
          {m.studio_publish_submit()}
        </Button>
      </div>
    </form>
  )
}
