// 举报对话框（设计稿 Work.dc.html / WorkMobile.dc.html 的 reportDialog）：桌面居中弹窗、手机底部面板；
// 原因单选、可选说明、未登录时人机验证。提交到 POST /api/studio/reports（content-moderation「举报」）。
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  RadioGroup,
  RadioItem,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Textarea,
} from '@saas/ui'
import { useTurnstile } from '@web/features/auth/turnstile.tsx'
import { m } from '@web/paraglide/messages.js'
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { getStudioReportContext, type StudioReportContext } from './report.functions.ts'

export const REPORT_REASONS = ['sexual', 'violence', 'hate', 'copyright', 'spam', 'other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]
export const REPORT_NOTE_MAX = 500

function reasonLabel(reason: ReportReason) {
  switch (reason) {
    case 'sexual':
      return m.studio_report_reason_sexual()
    case 'violence':
      return m.studio_report_reason_violence()
    case 'hate':
      return m.studio_report_reason_hate()
    case 'copyright':
      return m.studio_report_reason_copyright()
    case 'spam':
      return m.studio_report_reason_spam()
    case 'other':
      return m.studio_report_reason_other()
  }
}

export type ReportOutcome = 'ok' | 'turnstile' | 'rate-limited' | 'failed'

/** 举报接口的结果分类：人机验证失败（403 TURNSTILE_FAILED）、限流（429）与其他失败 */
export async function reportOutcome(response: Response): Promise<ReportOutcome> {
  if (response.ok) return 'ok'
  if (response.status === 429) return 'rate-limited'
  const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null
  if (body?.error?.code === 'TURNSTILE_FAILED') return 'turnstile'
  return 'failed'
}

// 与 Tailwind md 断点一致；服务端与水合首帧按桌面渲染（对话框只在交互后打开）
const DESKTOP_QUERY = '(min-width: 48rem)'
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
function useDesktop() {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}

function Shell({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  const desktop = useDesktop()
  // 打开期间不切换形态（design-system「弹层与底部面板」）
  const [mode, setMode] = useState(desktop)
  useEffect(() => {
    if (!open) setMode(desktop)
  }, [open, desktop])
  if (mode)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{m.studio_report_title()}</DialogTitle>
            <DialogDescription>{m.studio_report_description()}</DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-3.5">{children}</div>
        </DialogContent>
      </Dialog>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false}>
        <div className="flex min-w-0 flex-col gap-3 px-4 pt-2 pb-6">
          <SheetTitle>{m.studio_report_title()}</SheetTitle>
          <SheetDescription className="text-caption">
            {m.studio_report_description()}
          </SheetDescription>
          {children}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ReportForm({
  workId,
  context,
  onClose,
  onSessionLost,
}: {
  workId: string
  context: StudioReportContext
  onClose: () => void
  /** 打开时判定为已登录、提交时接口却要求人机验证（会话已失效）：按未登录重新渲染 */
  onSessionLost: () => void
}) {
  const legendId = useId()
  const noteId = useId()
  const [reason, setReason] = useState<ReportReason | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ReportOutcome | null>(null)
  // 登录用户不需要人机验证
  const turnstile = useTurnstile(
    context.signedIn ? null : context.turnstileSiteKey,
    'studio_report',
  )

  const submit = async () => {
    if (!reason || busy) return
    if (!turnstile.ready) {
      setOutcome('turnstile')
      return
    }
    setBusy(true)
    try {
      const response = await fetch('/api/studio/reports', {
        method: 'POST',
        // 令牌经请求头传递（与认证表单同一个 x-turnstile-token），正文为严格的 JSON 对象
        headers: { 'content-type': 'application/json', ...turnstile.headers() },
        body: JSON.stringify({ workId, reason, ...(note.trim() && { note: note.trim() }) }),
      })
      const result = await reportOutcome(response)
      if (result === 'turnstile' && context.signedIn) {
        onSessionLost()
        return
      }
      setOutcome(result)
      if (result !== 'ok') turnstile.reset()
    } catch {
      setOutcome('failed')
      turnstile.reset()
    } finally {
      setBusy(false)
    }
  }

  if (outcome === 'ok')
    return (
      <>
        <p role="status" className="text-body">
          {m.studio_report_success()}
        </p>
        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            {m.studio_report_done()}
          </Button>
        </div>
      </>
    )

  const error =
    outcome === 'turnstile'
      ? m.studio_report_turnstile_required()
      : outcome === 'rate-limited'
        ? m.studio_report_rate_limited()
        : outcome === 'failed'
          ? m.studio_report_failed()
          : null

  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span id={legendId} className="font-medium text-caption">
          {m.studio_report_reason()}
        </span>
        <RadioGroup
          aria-labelledby={legendId}
          name="reason"
          value={reason}
          onValueChange={(value) => setReason(value as ReportReason)}
          className="w-full"
        >
          {REPORT_REASONS.map((value, index) => (
            <RadioItem key={value} index={index} value={value} label={reasonLabel(value)} />
          ))}
        </RadioGroup>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={noteId} className="font-medium text-caption">
          {m.studio_report_note()}
        </label>
        <Textarea
          id={noteId}
          rows={3}
          maxLength={REPORT_NOTE_MAX}
          value={note}
          placeholder={m.studio_report_note_placeholder()}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
      {turnstile.widget}
      {error && (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2 *:flex-1 sm:justify-end sm:*:flex-none">
        <Button type="button" variant="outline" onClick={onClose}>
          {m.studio_report_cancel()}
        </Button>
        <Button type="submit" loading={busy} disabled={!reason}>
          {m.studio_report_submit()}
        </Button>
      </div>
    </form>
  )
}

export function ReportDialog({
  workId,
  open,
  onOpenChange,
}: {
  workId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [context, setContext] = useState<StudioReportContext | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open || context) return
    let cancelled = false
    getStudioReportContext()
      .then((value) => {
        if (!cancelled) setContext(value)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [open, context])

  const close = () => onOpenChange(false)
  const anonymousClosed = context && !context.signedIn && !context.turnstileSiteKey
  const loginHref = () =>
    `/login?redirect=${encodeURIComponent(typeof window === 'undefined' ? '/gallery' : window.location.pathname)}`

  return (
    <Shell open={open} onOpenChange={onOpenChange}>
      {failed ? (
        <p role="alert" className="text-body text-destructive">
          {m.studio_report_failed()}
        </p>
      ) : !context ? (
        <p role="status" className="text-body text-muted-foreground">
          {m.studio_report_loading()}
        </p>
      ) : anonymousClosed ? (
        // 未配置 Turnstile 时匿名举报关闭，只允许登录用户举报
        <>
          <p className="text-body">{m.studio_report_sign_in_required()}</p>
          <div className="flex gap-2 *:flex-1 sm:justify-end sm:*:flex-none">
            <Button type="button" variant="outline" onClick={close}>
              {m.studio_report_cancel()}
            </Button>
            <Button asChild>
              <a href={loginHref()}>{m.studio_report_sign_in()}</a>
            </Button>
          </div>
        </>
      ) : (
        <ReportForm
          key={String(context.signedIn)}
          workId={workId}
          context={context}
          onClose={close}
          onSessionLost={() => setContext({ ...context, signedIn: false })}
        />
      )}
    </Shell>
  )
}
