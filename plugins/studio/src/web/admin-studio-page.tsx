import {
  Badge,
  Button,
  DataTable,
  type DataTableColumn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tabs,
  TabsItem,
  Textarea,
  toast,
} from '@saas/ui'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { adminListPage, offsetOfPage } from '@web/features/admin/list.ts'
import { AdminPage, adminTableLabels, formatDateTime, panelClass } from '@web/features/admin/ui.tsx'
import { m } from '@web/paraglide/messages.js'
import { useEffect, useId, useState } from 'react'
import { STUDIO_REVIEW_QUEUES, type StudioReviewQueue } from './admin-studio-queues.ts'
import { studioMediaPath } from './media-url.ts'
import {
  getAdminStudioWorkPreview,
  type listAdminStudioWorks,
  moderateAdminStudioWork,
  moderateAdminStudioWorks,
} from './moderation.functions.ts'

/**
 * 后台作品审核 `/admin/studio`（add-media-studio 任务 7.2 / 7.3，设计稿
 * docs/design-system/prototypes/media-studio/AdminStudio.dc.html）：待审核 / 被举报 / 已隐藏 / 已下架四栏，
 * 行内通过、下架（必填原因）、恢复、精选；DataTable 行选择后批量通过 / 下架，失败项逐行标出并保持选中。
 */

export type StudioReviewData = Awaited<ReturnType<typeof listAdminStudioWorks>>
export type StudioReviewRow = StudioReviewData['rows'][number]
type SingleAction = 'approve' | 'restore' | 'feature' | 'unfeature'

const REMOVAL_REASONS = ['copyright', 'sexual', 'violence', 'hate', 'spam', 'other'] as const
type RemovalReason = (typeof REMOVAL_REASONS)[number]

const removalLabel: Record<RemovalReason, () => string> = {
  copyright: m.studio_admin_removal_copyright,
  sexual: m.studio_admin_removal_sexual,
  violence: m.studio_admin_removal_violence,
  hate: m.studio_admin_removal_hate,
  spam: m.studio_admin_removal_spam,
  other: m.studio_admin_removal_other,
}

const reportReasonLabel: Record<string, () => string> = {
  sexual: m.studio_admin_report_reason_sexual,
  violence: m.studio_admin_report_reason_violence,
  hate: m.studio_admin_report_reason_hate,
  copyright: m.studio_admin_report_reason_copyright,
  spam: m.studio_admin_report_reason_spam,
  other: m.studio_admin_report_reason_other,
}

const tabLabel: Record<StudioReviewQueue, () => string> = {
  pending: m.studio_admin_tab_pending,
  reported: m.studio_admin_tab_reported,
  hidden: m.studio_admin_tab_hidden,
  removed: m.studio_admin_tab_removed,
}

const emptyCopy: Record<StudioReviewQueue, { title: () => string; body: () => string }> = {
  pending: { title: m.studio_admin_empty_pending_title, body: m.studio_admin_empty_pending_body },
  reported: {
    title: m.studio_admin_empty_reported_title,
    body: m.studio_admin_empty_reported_body,
  },
  hidden: { title: m.studio_admin_empty_hidden_title, body: m.studio_admin_empty_hidden_body },
  removed: { title: m.studio_admin_empty_removed_title, body: m.studio_admin_empty_removed_body },
}

const statusLabel: Record<StudioReviewRow['moderation'], () => string> = {
  pending: m.studio_admin_status_pending,
  approved: m.studio_admin_status_approved,
  hidden: m.studio_admin_status_hidden,
  removed: m.studio_admin_status_removed,
}

const doneLabel: Record<SingleAction | 'remove', () => string> = {
  approve: m.studio_admin_done_approve,
  remove: m.studio_admin_done_remove,
  restore: m.studio_admin_done_restore,
  feature: m.studio_admin_done_feature,
  unfeature: m.studio_admin_done_unfeature,
}

/** 服务端返回的错误码 → 行内与提示文字 */
export function studioErrorMessage(code: string | undefined) {
  if (code === 'STUDIO_MODERATION_CONFLICT') return m.studio_admin_error_conflict()
  if (code === 'NOT_FOUND') return m.studio_admin_error_not_found()
  return m.studio_admin_failed()
}

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined
}

/** 公开可见的作品经公开媒体地址显示；隐藏 / 下架 / 私有作品不公开输出，预览时临时签名 */
export function publicMediaSrc(row: StudioReviewRow) {
  return row.visibility === 'public' &&
    (row.moderation === 'pending' || row.moderation === 'approved')
    ? studioMediaPath(row.id, row.version)
    : null
}

/** 举报列：「3 · 侵权 2、垃圾 1」，按未处理数量汇总；没有未处理举报时显示累计数 */
export function reportSummary(row: StudioReviewRow) {
  if (row.reportCount === 0) return null
  const open = row.reportReasons.filter((reason) => reason.unresolved > 0)
  const reasons = (open.length ? open : row.reportReasons)
    .map((reason) =>
      m.studio_admin_report_reason_item({
        reason: (reportReasonLabel[reason.reason] ?? m.studio_admin_report_reason_other)(),
        count: open.length ? reason.unresolved : reason.total,
      }),
    )
    .join(m.studio_admin_report_reason_separator())
  return reasons
    ? m.studio_admin_reports_summary({ count: row.reportCount, reasons })
    : String(row.reportCount)
}

const canApprove = (row: StudioReviewRow) =>
  row.visibility === 'public' && row.moderation === 'pending'
const canRemove = (row: StudioReviewRow) =>
  row.visibility === 'public' && row.moderation !== 'removed'
const canRestore = (row: StudioReviewRow) =>
  row.moderation === 'hidden' || row.moderation === 'removed'
const canFeature = (row: StudioReviewRow) =>
  row.visibility === 'public' && (row.moderation === 'pending' || row.moderation === 'approved')

type RemoveTarget = { kind: 'single'; row: StudioReviewRow } | { kind: 'bulk'; ids: string[] }

export function AdminStudioPage({
  data,
  queue,
  offset,
}: {
  data: StudioReviewData
  queue: StudioReviewQueue
  offset: number
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [rowErrors, setRowErrors] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [busy, setBusy] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [preview, setPreview] = useState<StudioReviewRow | null>(null)

  const go = (next: { queue: StudioReviewQueue; offset: number }) =>
    void navigate({
      to: '/admin/studio',
      search:
        next.queue === 'pending'
          ? { offset: next.offset }
          : { queue: next.queue, offset: next.offset },
    })

  async function runSingle(row: StudioReviewRow, action: SingleAction) {
    setBusy(row.id)
    try {
      await moderateAdminStudioWork({ data: { workId: row.id, action } })
      toast.success(doneLabel[action]())
      await router.invalidate()
    } catch (error) {
      toast.error(studioErrorMessage(errorCode(error)))
    } finally {
      setBusy(null)
    }
  }

  async function runBulk(
    ids: string[],
    payload: { action: 'approve' } | { action: 'remove'; reason: string; note?: string },
  ) {
    setBusy('bulk')
    try {
      const results = await moderateAdminStudioWorks({ data: { ...payload, workIds: ids } })
      const failed = results.filter((result) => !result.ok)
      setRowErrors(
        new Map(failed.map((result) => [result.workId, 'code' in result ? result.code : ''])),
      )
      setSelected(new Set(failed.map((result) => result.workId)))
      if (failed.length === 0) toast.success(m.studio_admin_bulk_done({ count: results.length }))
      else
        toast.error(
          m.studio_admin_bulk_partial({
            ok: results.length - failed.length,
            failed: failed.length,
          }),
        )
      await router.invalidate()
    } catch (error) {
      toast.error(studioErrorMessage(errorCode(error)))
    } finally {
      setBusy(null)
    }
  }

  async function confirmRemove(reason: string, note: string) {
    const target = removeTarget
    if (!target) return
    const extra = note ? { note } : {}
    if (target.kind === 'bulk') {
      await runBulk(target.ids, { action: 'remove', reason, ...extra })
      setRemoveTarget(null)
      return
    }
    setBusy(target.row.id)
    try {
      await moderateAdminStudioWork({
        data: { workId: target.row.id, action: 'remove', reason, ...extra },
      })
      toast.success(doneLabel.remove())
      setRemoveTarget(null)
      await router.invalidate()
    } catch (error) {
      toast.error(studioErrorMessage(errorCode(error)))
    } finally {
      setBusy(null)
    }
  }

  const columns: DataTableColumn<StudioReviewRow>[] = [
    {
      id: 'media',
      header: m.studio_admin_col_media(),
      className: 'w-18',
      cell: (row) => <Thumbnail row={row} onOpen={() => setPreview(row)} />,
    },
    {
      id: 'title',
      header: m.studio_admin_col_title(),
      cell: (row) => {
        const error = rowErrors.get(row.id)
        return (
          <div className="grid min-w-0 max-w-sm gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate font-medium">{row.title}</span>
              {queue === 'reported' ? (
                <Badge color={row.moderation === 'hidden' ? 'amber' : 'gray'}>
                  {statusLabel[row.moderation]()}
                </Badge>
              ) : null}
              {row.featuredAt ? <Badge color="accent">{m.studio_admin_featured()}</Badge> : null}
            </span>
            <span className="truncate text-caption text-muted-foreground">{row.prompt ?? '—'}</span>
            {row.moderation === 'removed' && row.removalReason ? (
              <span className="text-caption text-muted-foreground">
                {m.studio_admin_removed_reason({ reason: row.removalReason })}
              </span>
            ) : null}
            {error !== undefined ? (
              <span role="alert" className="text-caption text-destructive">
                {m.studio_admin_row_failed({ message: studioErrorMessage(error) })}
              </span>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'kind',
      header: m.studio_admin_col_kind(),
      cell: (row) =>
        row.kind === 'video' ? m.studio_admin_kind_video() : m.studio_admin_kind_image(),
    },
    {
      id: 'workspace',
      header: m.studio_admin_col_workspace(),
      cell: (row) => <span className="text-muted-foreground">{row.workspaceName}</span>,
    },
    {
      id: 'published',
      header: m.studio_admin_col_published(),
      cell: (row) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatDateTime(row.publishedAt)}
        </span>
      ),
    },
    {
      id: 'reports',
      header: m.studio_admin_col_reports(),
      cell: (row) => {
        const summary = reportSummary(row)
        return summary ? (
          <Badge color="red">{summary}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: 'actions',
      header: m.studio_admin_col_actions(),
      cell: (row) => {
        const disabled = busy !== null
        return (
          <div className="flex flex-wrap items-center gap-1.5">
            {canRestore(row) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                loading={busy === row.id}
                onClick={() => void runSingle(row, 'restore')}
              >
                {m.studio_admin_restore()}
              </Button>
            ) : canApprove(row) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                loading={busy === row.id}
                onClick={() => void runSingle(row, 'approve')}
              >
                {m.studio_admin_approve()}
              </Button>
            ) : null}
            {canRemove(row) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive"
                disabled={disabled}
                onClick={() => setRemoveTarget({ kind: 'single', row })}
              >
                {m.studio_admin_remove()}
              </Button>
            ) : null}
            {row.featuredAt ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => void runSingle(row, 'unfeature')}
              >
                {m.studio_admin_unfeature()}
              </Button>
            ) : canFeature(row) ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => void runSingle(row, 'feature')}
              >
                {m.studio_admin_feature()}
              </Button>
            ) : null}
          </div>
        )
      },
    },
  ]

  const counts: Record<StudioReviewQueue, number | null> = {
    pending: data.counts.pending,
    reported: data.counts.reported,
    hidden: data.counts.hidden,
    removed: null,
  }
  const empty = data.rows.length === 0 && offset === 0
  // 已下架栏只能逐件恢复，不提供批量
  const selectable = queue !== 'removed'
  const ids = [...selected]

  return (
    <AdminPage title={m.studio_admin_title()} description={m.studio_admin_description()}>
      <Tabs
        aria-label={m.studio_admin_tabs_label()}
        selectedIndex={STUDIO_REVIEW_QUEUES.indexOf(queue)}
        onSelect={(index) => go({ queue: STUDIO_REVIEW_QUEUES[index] ?? 'pending', offset: 0 })}
        className="w-full self-start overflow-x-auto sm:w-fit"
      >
        {STUDIO_REVIEW_QUEUES.map((tab, index) => {
          const count = counts[tab]
          return (
            <TabsItem
              key={tab}
              index={index}
              className="flex-1"
              label={
                count
                  ? m.studio_admin_tab_count({ label: tabLabel[tab](), count })
                  : tabLabel[tab]()
              }
            />
          )
        })}
      </Tabs>
      {empty ? (
        <div
          className={panelClass(
            'default',
            'justify-items-center gap-2 px-6 py-24 text-center sm:px-6 sm:py-24',
          )}
        >
          <p className="font-semibold">{emptyCopy[queue].title()}</p>
          <p className="text-body text-muted-foreground">{emptyCopy[queue].body()}</p>
        </div>
      ) : (
        <DataTable<StudioReviewRow>
          label={m.studio_admin_table_label()}
          columns={columns}
          rows={data.rows}
          getRowId={(row) => row.id}
          page={adminListPage(offset, data)}
          onPageChange={(pageIndex) => go({ queue, offset: offsetOfPage(pageIndex) })}
          labels={adminTableLabels()}
          {...(selectable && {
            selection: {
              selected,
              onSelectedChange: setSelected,
              canSelect: canRemove,
              labels: {
                selectAll: m.studio_admin_select_all(),
                selectRow: (row) => m.studio_admin_select_row({ title: row.title }),
                selected: (count) => m.studio_admin_selected({ count }),
                clear: m.studio_admin_clear_selection(),
              },
              actions: (
                <>
                  {queue === 'pending' ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy !== null}
                      loading={busy === 'bulk' && removeTarget === null}
                      onClick={() => void runBulk(ids, { action: 'approve' })}
                    >
                      {m.studio_admin_bulk_approve()}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    disabled={busy !== null}
                    onClick={() => setRemoveTarget({ kind: 'bulk', ids })}
                  >
                    {m.studio_admin_bulk_remove()}
                  </Button>
                </>
              ),
            },
          })}
        />
      )}
      <RemoveDialog
        target={removeTarget}
        busy={busy !== null}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={(reason, note) => void confirmRemove(reason, note)}
      />
      <PreviewDialog row={preview} onClose={() => setPreview(null)} />
    </AdminPage>
  )
}

function kindShort(row: StudioReviewRow) {
  return row.kind === 'video'
    ? m.studio_admin_kind_video_short()
    : m.studio_admin_kind_image_short()
}

/** 48px 缩略图：公开作品取公开媒体地址，其余（或加载失败）显示类型占位；点击打开预览 */
function Thumbnail({ row, onOpen }: { row: StudioReviewRow; onOpen: () => void }) {
  const src = publicMediaSrc(row)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={m.studio_admin_preview({ title: row.title })}
      className="flex size-12 items-center justify-center overflow-hidden rounded-lg bg-muted text-caption text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2"
    >
      {src && !failed ? (
        row.kind === 'video' ? (
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            className="size-full object-cover"
            onError={() => setFailed(true)}
          />
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            className="size-full object-cover"
            onError={() => setFailed(true)}
          />
        )
      ) : (
        kindShort(row)
      )}
    </button>
  )
}

type PreviewState = { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed' }

/** 预览：公开作品直接用公开地址；隐藏、下架作品经后台鉴权临时签名（响应 private, no-store） */
function PreviewDialog({ row, onClose }: { row: StudioReviewRow | null; onClose: () => void }) {
  const [media, setMedia] = useState<PreviewState>({ state: 'loading' })
  useEffect(() => {
    if (!row) return
    const src = publicMediaSrc(row)
    if (src) {
      setMedia({ state: 'ready', url: src })
      return
    }
    let active = true
    setMedia({ state: 'loading' })
    getAdminStudioWorkPreview({ data: { workId: row.id } })
      .then((result) => active && setMedia({ state: 'ready', url: result.url }))
      .catch(() => active && setMedia({ state: 'failed' }))
    return () => {
      active = false
    }
  }, [row])

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="xl" closeLabel={m.studio_admin_close()}>
        <DialogHeader>
          <DialogTitle>{row ? m.studio_admin_preview({ title: row.title }) : ''}</DialogTitle>
          <DialogDescription>{row?.prompt ?? '—'}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-muted">
          {media.state === 'ready' && row ? (
            row.kind === 'video' ? (
              <video src={media.url} controls muted className="max-h-96 w-full object-contain" />
            ) : (
              <img src={media.url} alt={row.title} className="max-h-96 w-full object-contain" />
            )
          ) : (
            <p role="status" className="text-body text-muted-foreground">
              {media.state === 'failed'
                ? m.studio_admin_preview_failed()
                : m.studio_admin_preview_loading()}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 下架对话框：原因必选（作者可见），说明可选（只写入审计） */
function RemoveDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: RemoveTarget | null
  busy: boolean
  onCancel: () => void
  onConfirm: (reason: string, note: string) => void
}) {
  const id = useId()
  const [reason, setReason] = useState<RemovalReason | ''>('')
  const [note, setNote] = useState('')
  // 每次打开从空白开始，不沿用上一次的原因
  useEffect(() => {
    if (!target) return
    setReason('')
    setNote('')
  }, [target])
  const title =
    target?.kind === 'bulk'
      ? m.studio_admin_remove_bulk_title({ count: target.ids.length })
      : target
        ? m.studio_admin_remove_title({ title: target.row.title })
        : ''
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel()
      }}
    >
      <DialogContent size="lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{m.studio_admin_remove_body()}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-reason`}>{m.studio_admin_remove_reason()}</Label>
          <Select
            value={reason}
            onValueChange={(value) => setReason(value as RemovalReason)}
            required
          >
            <SelectTrigger
              id={`${id}-reason`}
              placeholder={m.studio_admin_remove_reason_placeholder()}
              valueLabel={reason ? removalLabel[reason]() : undefined}
            />
            <SelectContent>
              {REMOVAL_REASONS.map((value, index) => (
                <SelectItem key={value} index={index} value={value}>
                  {removalLabel[value]()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-note`}>{m.studio_admin_remove_note()}</Label>
          <Textarea
            id={`${id}-note`}
            rows={3}
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            {m.studio_admin_cancel()}
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={busy}
            disabled={!reason}
            onClick={() => reason && onConfirm(removalLabel[reason](), note.trim())}
          >
            {m.studio_admin_remove_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 列表加载失败 */
export function AdminStudioError({ onRetry }: { onRetry: () => void }) {
  return (
    <AdminPage title={m.studio_admin_title()} description={m.studio_admin_description()}>
      <div role="alert" className={panelClass('default', 'justify-items-center p-10 text-center')}>
        <p className="font-semibold">{m.studio_admin_load_failed()}</p>
        <p className="text-body text-muted-foreground">{m.studio_admin_load_failed_body()}</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          {m.studio_admin_retry()}
        </Button>
      </div>
    </AdminPage>
  )
}
