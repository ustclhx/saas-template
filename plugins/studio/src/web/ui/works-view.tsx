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
  cn,
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  MenuItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@saas/ui'
import { Ellipsis, ImageIcon } from '@saas/ui/icons'
import { Link } from '@tanstack/react-router'
import { FormAlert, StatusAlert } from '@web/features/auth/auth-layout.tsx'
import { m } from '@web/paraglide/messages.js'
import { useState } from 'react'
import type { StudioKind } from '../../kinds.ts'
import {
  deleteStudioWorkFn,
  getStudioWorks,
  type StudioWorkItem,
  type StudioWorksPage,
  unpublishStudioWorkFn,
} from '../works.functions.ts'
import { type PublishTarget, PublishWorkDialog } from './publish-dialog.tsx'
import { formatDuration, formatWorkTime, studioWorkBadge, studioWorkState } from './work-state.ts'

export interface StudioWorksFilters {
  kind?: StudioKind | undefined
  visibility?: 'public' | 'private' | undefined
}

type Visibility = NonNullable<StudioWorksFilters['visibility']>

/**
 * 我的作品（设计稿 media-studio/Works.dc.html、WorksMobile.dc.html）：网格、类型 / 公开状态筛选、状态徽标、
 * 发布 / 取消发布 / 删除。只读成员只看不写；按钮禁用只是提示，服务端同样拒绝。
 */
export function StudioWorksView({
  page,
  filters,
  onFiltersChange,
}: {
  page: StudioWorksPage
  filters: StudioWorksFilters
  onFiltersChange: (filters: StudioWorksFilters) => void
}) {
  const slug = page.workspaceSlug
  const [works, setWorks] = useState(page.works)
  const [nextCursor, setNextCursor] = useState(page.nextCursor)
  const [quota, setQuota] = useState(page.quota)
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<StudioWorkItem | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'status' | 'error'; text: string } | null>(null)

  function update(fileId: string, change: (work: StudioWorkItem) => StudioWorkItem | null) {
    setWorks((current) =>
      current.flatMap((work) => {
        if (work.fileId !== fileId) return [work]
        const next = change(work)
        return next ? [next] : []
      }),
    )
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const more = await getStudioWorks({
        data: {
          slug,
          cursor: nextCursor,
          ...(filters.kind && { kind: filters.kind }),
          ...(filters.visibility && { visibility: filters.visibility }),
        },
      })
      setWorks((current) => [...current, ...more.works])
      setNextCursor(more.nextCursor)
      setQuota(more.quota)
    } catch {
      setNotice({ kind: 'error', text: m.studio_load_error() })
    } finally {
      setLoadingMore(false)
    }
  }

  async function unpublish(item: StudioWorkItem) {
    if (busy) return
    setBusy(item.fileId)
    setNotice(null)
    try {
      const result = await unpublishStudioWorkFn({ data: { slug, fileId: item.fileId } })
      if (!result.ok) {
        setNotice({ kind: 'error', text: m.studio_action_error() })
        return
      }
      update(item.fileId, (work) =>
        filters.visibility === 'public'
          ? null
          : { ...work, work: work.work && { ...work.work, visibility: 'private' } },
      )
      setNotice({ kind: 'status', text: m.studio_unpublished() })
    } catch {
      setNotice({ kind: 'error', text: m.studio_action_error() })
    } finally {
      setBusy(null)
    }
  }

  async function remove(item: StudioWorkItem) {
    setBusy(item.fileId)
    setNotice(null)
    try {
      const result = await deleteStudioWorkFn({ data: { slug, fileId: item.fileId } })
      if (!result.ok) {
        setNotice({ kind: 'error', text: m.studio_action_error() })
        return
      }
      update(item.fileId, () => null)
      setNotice({ kind: 'status', text: m.studio_deleted() })
    } catch {
      setNotice({ kind: 'error', text: m.studio_action_error() })
    } finally {
      setBusy(null)
      setDeleteTarget(null)
    }
  }

  const kindOptions: { value: StudioKind | undefined; label: string }[] = [
    { value: undefined, label: m.studio_filter_all() },
    ...page.kinds.map((kind) => ({
      value: kind,
      label: kind === 'image' ? m.studio_mode_image() : m.studio_mode_video(),
    })),
  ]
  const visibilityOptions: { value: Visibility | undefined; label: string }[] = [
    { value: undefined, label: m.studio_filter_all() },
    { value: 'private', label: m.studio_filter_private() },
    { value: 'public', label: m.studio_filter_public() },
  ]
  const visibilityLabel =
    visibilityOptions.find((option) => option.value === filters.visibility)?.label ??
    m.studio_filter_all()
  const filtered = filters.kind !== undefined || filters.visibility !== undefined

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-start gap-3">
        <p className="min-w-0 flex-1 text-muted-foreground max-md:hidden">
          {m.studio_works_description()}
        </p>
        <Button asChild className="max-md:hidden">
          <Link to="/app/$slug/studio" params={{ slug }}>
            {m.studio_go_create()}
          </Link>
        </Button>
      </div>
      {page.canWrite ? null : (
        <p role="note" className="rounded-lg bg-secondary px-3 py-2.5 text-muted-foreground">
          {m.studio_works_readonly()}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        {page.kinds.length > 1 ? (
          <FilterGroup
            label={m.studio_filter_kind()}
            options={kindOptions}
            value={filters.kind}
            onChange={(kind) => onFiltersChange({ ...filters, kind })}
          />
        ) : null}
        <FilterGroup
          className="max-md:hidden"
          label={m.studio_filter_visibility()}
          options={visibilityOptions}
          value={filters.visibility}
          onChange={(visibility) => onFiltersChange({ ...filters, visibility })}
        />
        <div className="ml-auto md:hidden">
          <Select
            value={filters.visibility ?? 'all'}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                visibility: value === 'all' ? undefined : (value as Visibility),
              })
            }
          >
            <SelectTrigger
              aria-label={m.studio_filter_visibility()}
              placeholder={m.studio_filter_visibility()}
              valueLabel={m.studio_filter_status_value({ value: visibilityLabel })}
            />
            <SelectContent>
              {visibilityOptions.map((option, index) => (
                <SelectItem key={option.label} index={index} value={option.value ?? 'all'}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {page.canWrite ? (
          <span
            className="ml-auto text-caption text-muted-foreground max-md:hidden"
            data-testid="studio-works-quota"
          >
            {m.studio_publish_quota({ remaining: quota.remaining, limit: quota.limit })}
          </span>
        ) : null}
      </div>
      {notice ? (
        notice.kind === 'error' ? (
          <FormAlert message={notice.text} />
        ) : (
          <StatusAlert>{notice.text}</StatusAlert>
        )
      ) : null}
      {works.length > 0 ? (
        <ul
          aria-label={m.studio_my_works()}
          className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:gap-4 lg:grid-cols-4"
        >
          {works.map((item) => (
            <li key={item.fileId}>
              <WorkCard
                item={item}
                canWrite={page.canWrite}
                busy={busy === item.fileId}
                onPublish={() =>
                  setPublishTarget({
                    fileId: item.fileId,
                    kind: item.kind,
                    url: item.url,
                    prompt: item.prompt,
                    title: item.work?.title ?? null,
                    showPrompt: item.work?.showPrompt ?? null,
                  })
                }
                onUnpublish={() => void unpublish(item)}
                onDelete={() => setDeleteTarget(item)}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid justify-items-center gap-2.5 rounded-xl border border-border px-6 py-24 text-center">
          <h2 className="font-semibold text-subtitle">
            {filtered ? m.studio_works_empty_filtered() : m.studio_works_empty_title()}
          </h2>
          <p className="max-w-md text-muted-foreground">
            {filtered ? m.studio_works_empty_filtered_body() : m.studio_works_empty_body()}
          </p>
          <Button asChild className="mt-2">
            <Link to="/app/$slug/studio" params={{ slug }}>
              {m.studio_start_create()}
            </Link>
          </Button>
        </div>
      )}
      {nextCursor ? (
        <Button
          variant="outline"
          className="justify-self-center"
          loading={loadingMore}
          onClick={() => void loadMore()}
        >
          {m.studio_load_more()}
        </Button>
      ) : null}

      <PublishWorkDialog
        slug={slug}
        target={publishTarget}
        quota={quota}
        onOpenChange={(open) => {
          if (!open) setPublishTarget(null)
        }}
        onPublished={(fileId, published) => {
          setPublishTarget(null)
          setQuota((current) => ({ ...current, remaining: Math.max(0, current.remaining - 1) }))
          update(fileId, (work) =>
            filters.visibility === 'private'
              ? null
              : {
                  ...work,
                  work: {
                    id: published.id,
                    slug: published.slug,
                    title: published.title,
                    visibility: published.visibility,
                    moderation: published.moderation,
                    removalReason: null,
                    showPrompt: work.work?.showPrompt ?? true,
                    version: work.work?.version ?? 1,
                  },
                },
          )
          setNotice({ kind: 'status', text: m.studio_published() })
        }}
      />

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m.studio_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>{m.studio_delete_description()}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>{m.studio_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy !== null}
              onClick={(event) => {
                event.preventDefault()
                if (deleteTarget) void remove(deleteTarget)
              }}
            >
              {m.studio_delete_confirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function FilterGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string
  options: { value: T | undefined; label: string }[]
  value: T | undefined
  onChange: (value: T | undefined) => void
  className?: string
}) {
  return (
    <fieldset className={cn('inline-flex gap-0.5 rounded-lg bg-secondary p-0.5', className)}>
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <Button
            key={option.label}
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={selected}
            className={cn(
              selected ? 'bg-card text-foreground shadow-surface-2' : 'text-muted-foreground',
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        )
      })}
    </fieldset>
  )
}

export function WorkMedia({
  kind,
  url,
  label,
  className,
}: {
  kind: StudioKind
  url: string
  label: string
  className?: string
}) {
  if (kind === 'video')
    return (
      // 视频卡片只取首帧（preload="metadata"），桌面悬停时静音播放，离开后回到开头。
      <video
        src={url}
        preload="metadata"
        muted
        playsInline
        loop
        aria-label={label}
        className={cn('size-full bg-secondary object-cover', className)}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') void event.currentTarget.play().catch(() => {})
        }}
        onPointerLeave={(event) => {
          event.currentTarget.pause()
          event.currentTarget.currentTime = 0
        }}
      />
    )
  return (
    <img
      src={url}
      alt={label}
      loading="lazy"
      decoding="async"
      className={cn('size-full bg-secondary object-cover', className)}
    />
  )
}

function WorkCard({
  item,
  canWrite,
  busy,
  onPublish,
  onUnpublish,
  onDelete,
}: {
  item: StudioWorkItem
  canWrite: boolean
  busy: boolean
  onPublish: () => void
  onUnpublish: () => void
  onDelete: () => void
}) {
  const state = studioWorkState(item.work)
  const badge = studioWorkBadge(item.work)
  const title = item.work?.title || item.prompt || item.modelDisplayName
  const primary =
    state === 'removed'
      ? null
      : state === 'private'
        ? { label: m.studio_publish(), action: onPublish }
        : { label: m.studio_unpublish(), action: onUnpublish }
  const download = `${item.url}&download=1`
  return (
    <article
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
      aria-label={title}
    >
      <div className="relative h-37.5 bg-secondary sm:h-45">
        {item.url ? (
          <WorkMedia kind={item.kind} url={item.url} label={title} />
        ) : (
          <ImageIcon aria-hidden="true" className="m-auto text-muted-foreground" />
        )}
        <div className="absolute inset-x-2 top-2 flex">
          <Badge
            color={badge.color}
            size="compact"
            className="max-w-full"
            data-testid="studio-work-state"
          >
            <span className="truncate">{badge.label}</span>
          </Badge>
        </div>
        {item.kind === 'video' && item.duration !== null ? (
          <Badge size="compact" className="absolute right-2 bottom-2">
            {formatDuration(item.duration)}
          </Badge>
        ) : null}
      </div>
      <div className="grid gap-2 py-1 pr-1 pl-2.5 md:px-3 md:py-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 flex-1 truncate max-md:text-caption">{title}</span>
          {canWrite ? (
            <WorkMenu
              className="md:hidden"
              label={m.studio_work_actions({ title })}
              primary={primary}
              download={download}
              busy={busy}
              onDelete={onDelete}
            />
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 max-md:hidden">
          <time
            dateTime={item.createdAt}
            className="flex-1 text-caption text-muted-foreground"
            suppressHydrationWarning
          >
            {formatWorkTime(item.createdAt)}
          </time>
          {canWrite ? (
            <>
              {primary ? (
                <Button
                  type="button"
                  size="compact"
                  variant="outline"
                  loading={busy}
                  onClick={primary.action}
                >
                  {primary.label}
                </Button>
              ) : null}
              <WorkMenu
                label={m.studio_more_actions({ title })}
                primary={null}
                download={download}
                busy={busy}
                onDelete={onDelete}
              />
            </>
          ) : (
            <Button asChild size="compact" variant="ghost">
              <a href={download}>{m.studio_download()}</a>
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}

function WorkMenu({
  label,
  primary,
  download,
  busy,
  onDelete,
  className,
}: {
  label: string
  primary: { label: string; action: () => void } | null
  download: string
  busy: boolean
  onDelete: () => void
  className?: string
}) {
  let index = 0
  return (
    <span className={className}>
      <DropdownMenu disabled={busy}>
        <DropdownTrigger
          render={
            <Button type="button" size="icon-sm" variant="ghost" aria-label={label}>
              <Ellipsis aria-hidden="true" />
            </Button>
          }
        />
        <DropdownContent align="end">
          {primary ? (
            <MenuItem index={index++} label={primary.label} onSelect={primary.action} />
          ) : null}
          <MenuItem index={index++} label={m.studio_download()} render={<a href={download} />} />
          <MenuItem index={index++} label={m.studio_delete()} onSelect={onDelete} />
        </DropdownContent>
      </DropdownMenu>
    </span>
  )
}
