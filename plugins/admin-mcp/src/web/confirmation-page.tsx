import { Alert, AlertDescription, Badge, Button, cn } from '@saas/ui'
import { Link, useRouter } from '@tanstack/react-router'
import { isStepUpCancelled } from '@web/features/admin/step-up/client.ts'
import { useStepUpCall, useStepUpVerifying } from '@web/features/admin/step-up/step-up-provider.tsx'
import { AdminPage, formatDateTime, panelClass } from '@web/features/admin/ui.tsx'
import { m } from '@web/paraglide/messages.js'
import { useEffect, useState } from 'react'
import {
  type AdminConfirmationView,
  confirmAdminConfirmation,
  type getAdminConfirmation,
  rejectAdminConfirmation,
} from './confirmations.functions.ts'
import {
  confirmationBanner,
  confirmationRows,
  confirmationStatus,
  confirmationTitle,
  minutesUntil,
} from './confirmations-display.tsx'

/**
 * 后台确认 AI 发起的操作 `/admin/confirm/$id`（openspec add-admin-step-up 任务 4.3，设计稿
 * docs/design-system/prototypes/admin-step-up/Confirm.dc.html 与 ConfirmMobile.dc.html）。
 * 「确认执行」经 useStepUpCall：服务端要求重新验证时当场弹窗，通过后自动继续。
 */

type Data = Awaited<ReturnType<typeof getAdminConfirmation>>

/** 页面打开期间按分钟刷新剩余有效期；首帧用服务端时间，避免水合差异 */
function useNow(serverNow: Date | string) {
  const [now, setNow] = useState(() => new Date(serverNow).getTime())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function ConfirmationPage({ data }: { data: Data }) {
  const now = useNow(data.now)
  const back = (
    <Button asChild variant="ghost" size="sm">
      <Link
        to="/admin/confirmations"
        search={{ offset: 0 }}
        aria-label={m.admin_confirm_back_label()}
      >
        {m.admin_confirm_back()}
      </Link>
    </Button>
  )
  if (!data.found)
    return (
      <AdminPage title={m.admin_confirm_page_title()} actions={back}>
        <div className={panelClass('default', 'justify-items-center p-8 text-center')}>
          <p className="font-semibold text-title">{m.admin_confirm_not_found_title()}</p>
          <p className="text-muted-foreground text-body">{m.admin_confirm_not_found_body()}</p>
          <Button asChild variant="outline">
            <Link to="/admin/confirmations" search={{ offset: 0 }}>
              {m.admin_confirm_back_to_list()}
            </Link>
          </Button>
        </div>
      </AdminPage>
    )
  return (
    <AdminPage title={m.admin_confirm_page_title()} actions={back} className="max-w-3xl">
      <ConfirmationDetail
        record={data.record}
        now={now}
        isOwner={data.isOwner}
        requestedByEmail={data.requestedByEmail}
        decidedByEmail={data.decidedByEmail}
        liveBalance={data.liveBalance}
      />
    </AdminPage>
  )
}

function ConfirmationDetail(props: {
  record: AdminConfirmationView
  now: number
  isOwner: boolean
  requestedByEmail: string | null
  decidedByEmail: string | null
  liveBalance: number | null
}) {
  const { record, now } = props
  const router = useRouter()
  const [busy, setBusy] = useState<'confirm' | 'reject' | null>(null)
  // 水合前按钮不可用：避免点击落在尚未接管的按钮上而无反应
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [message, setMessage] = useState('')
  const title = confirmationTitle(record)
  const confirm = useStepUpCall(confirmAdminConfirmation, { action: title })
  const status = confirmationStatus(record, now)
  const open = status.state === 'open' && record.status === 'pending'
  // 等待重新验证时操作尚未执行，状态仍显示为待确认
  const verifying = useStepUpVerifying()
  const running = (busy === 'confirm' && !verifying) || record.status === 'running'
  const badge = running
    ? { label: m.admin_confirm_status_running(), color: 'gray' as const }
    : status
  const banner = confirmationBanner(record, now)
  const rows = confirmationRows(record, { liveBalance: props.liveBalance })
  const display = record.display
  const isRefund =
    typeof display === 'object' &&
    display !== null &&
    !Array.isArray(display) &&
    display.kind === 'refund'

  async function act(kind: 'confirm' | 'reject') {
    setBusy(kind)
    setMessage('')
    try {
      const result =
        kind === 'confirm'
          ? await confirm({ data: { id: record.id } })
          : await rejectAdminConfirmation({ data: { id: record.id } })
      if (isStepUpCancelled(result)) return
      if (!result.ok)
        setMessage(
          result.error === 'CONFIRMATION_FORBIDDEN'
            ? m.admin_confirm_error_not_owner()
            : m.admin_confirm_error_not_pending(),
        )
      // 成功或已被他人处理：重新读取记录与导航计数
      await router.invalidate()
    } catch {
      setMessage(m.admin_confirm_error_failed())
    } finally {
      setBusy(null)
    }
  }

  const minutes = minutesUntil(record.expiresAt, now)
  const expiry = open ? m.admin_confirm_minutes_left({ minutes }) : m.admin_confirm_valid_for()
  const auditAction =
    record.status === 'done'
      ? 'admin.confirmation.confirmed'
      : record.status === 'rejected'
        ? 'admin.confirmation.rejected'
        : record.status === 'failed'
          ? 'admin.confirmation.failed'
          : null
  const decided = record.decidedAt
    ? props.decidedByEmail
      ? m.admin_confirm_decided({
          time: formatDateTime(record.decidedAt),
          email: props.decidedByEmail,
        })
      : m.admin_confirm_decided_unknown({ time: formatDateTime(record.decidedAt) })
    : null

  const actions = (
    <>
      <Button
        type="button"
        variant="outline"
        className="text-destructive"
        disabled={!ready || busy !== null}
        loading={busy === 'reject'}
        onClick={() => void act('reject')}
      >
        {busy === 'reject' ? m.admin_confirm_rejecting() : m.admin_confirm_reject()}
      </Button>
      {props.isOwner ? (
        <Button
          type="button"
          disabled={!ready || busy !== null}
          loading={running}
          onClick={() => void act('confirm')}
        >
          {running ? m.admin_confirm_running() : m.admin_confirm_confirm()}
        </Button>
      ) : null}
    </>
  )

  return (
    <div className="grid min-w-0 gap-4">
      {banner ? (
        <Alert variant={banner.tone}>
          <AlertDescription>{banner.text}</AlertDescription>
        </Alert>
      ) : null}
      <div className={panelClass()}>
        <div className="flex min-w-0 items-start gap-3">
          <h3 className="min-w-0 flex-1 font-semibold text-title">{title}</h3>
          <Badge color={badge.color}>{badge.label}</Badge>
        </div>
        {/* 桌面：三列对照表；手机：逐行键值（设计稿 ConfirmMobile） */}
        <table className="hidden w-full text-body md:table">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">
                {m.admin_confirm_col_item()}
              </th>
              <th scope="col" className="py-2 pr-3 font-medium">
                {m.admin_confirm_col_current()}
              </th>
              <th scope="col" className="py-2 font-medium">
                {m.admin_confirm_col_after()}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b last:border-0">
                <th
                  scope="row"
                  className="py-2 pr-3 text-left align-top font-normal text-muted-foreground"
                >
                  {row.label}
                </th>
                {row.current === undefined ? (
                  <td colSpan={2} className={cn('break-all py-2', row.mono && 'font-mono')}>
                    {row.after}
                  </td>
                ) : (
                  <>
                    <td className={cn('break-all py-2 pr-3', row.mono && 'font-mono')}>
                      {row.current}
                    </td>
                    <td className={cn('break-all py-2 font-semibold', row.mono && 'font-mono')}>
                      {row.after}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="grid text-body md:hidden">
          {rows.map((row) => (
            <div key={row.label} className="flex min-w-0 justify-between gap-3 border-t py-2">
              <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
              <dd className={cn('min-w-0 break-all text-right', row.mono && 'font-mono')}>
                {row.current === undefined ? (
                  row.after
                ) : (
                  <>
                    {row.current} → <span className="font-semibold">{row.after}</span>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground text-body">
          <span>
            {m.admin_confirm_meta_token({ name: record.token.name })}{' '}
            <span className="font-mono">{record.token.prefix}…</span>
          </span>
          {props.requestedByEmail && !props.isOwner ? (
            <span>{m.admin_confirm_meta_requested_by({ email: props.requestedByEmail })}</span>
          ) : null}
          <span>{m.admin_confirm_meta_created({ time: formatDateTime(record.createdAt) })}</span>
          <span className={cn('font-medium', open && 'text-foreground')}>{expiry}</span>
        </div>
        {open && !props.isOwner ? (
          <p role="note" className="rounded-md bg-muted p-3 text-body">
            {props.requestedByEmail
              ? m.admin_confirm_not_owner({ email: props.requestedByEmail })
              : m.admin_confirm_not_owner_unknown()}
          </p>
        ) : null}
        {open || running ? <div className="hidden justify-end gap-2 md:flex">{actions}</div> : null}
        {decided ? (
          <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground text-body">
            <span>{decided}</span>
            {record.status === 'done' && isRefund ? (
              <Link
                to="/admin/billing/refunds"
                search={{ offset: 0 }}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                {m.admin_confirm_open_refunds()}
              </Link>
            ) : null}
            {auditAction ? (
              <Link
                to="/admin/audit"
                search={{ offset: 0, action: auditAction }}
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                {m.admin_confirm_view_audit()}
              </Link>
            ) : null}
          </div>
        ) : null}
        {message ? (
          <p role="alert" className="font-medium text-destructive text-body">
            {message}
          </p>
        ) : null}
      </div>
      <p className="text-muted-foreground text-body">{m.admin_confirm_footnote()}</p>
      {open || running ? (
        <div className="-mx-4 sm:-mx-6 sticky bottom-0 flex flex-col-reverse gap-2 border-t bg-card p-4 md:hidden">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
