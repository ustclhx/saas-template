import type { StepUpMethod } from '@saas/auth'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  InputOTP,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsItem,
} from '@saas/ui'
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from 'react'
import { m } from '../../../paraglide/messages.js'
import { templateConfig } from '../../../server/template-config.ts'
import { secondsLeft } from './client.ts'
import { getStepUpStatus, sendStepUpCode, verifyStepUp } from './step-up.functions.ts'

/**
 * 后台敏感操作的验证弹窗（openspec add-admin-step-up 决策 10，设计稿
 * docs/design-system/prototypes/admin-step-up/Main.dc.html 与 DialogMobile.dc.html）。
 * 桌面为居中弹窗，手机为底部面板；打开时读取当前会话的可用方式、锁定与验证码冷却。
 * 只负责验证本身：通过后交给 StepUpProvider 用原参数重试并在完成后关闭。
 */

export type StepUpStatus = Awaited<ReturnType<typeof getStepUpStatus>>
export type StepUpVerifiedResult = { method: StepUpMethod; expiresAt: string }

type VerifyFailure = { ok: false; error: string; details?: Record<string, unknown> }

const DESKTOP_QUERY = '(min-width: 48rem)'
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const desktopSnapshot = () => window.matchMedia(DESKTOP_QUERY).matches
const desktopServerSnapshot = () => true

const CODE_LENGTH = 6
const CODE_METHODS = new Set<StepUpMethod>(['totp', 'email_otp', 'rescue'])
const EMAIL_METHODS = new Set<StepUpMethod>(['email_otp', 'rescue'])

export function methodLabel(method: StepUpMethod): string {
  switch (method) {
    case 'totp':
      return m.admin_step_up_method_totp()
    case 'backup_code':
      return m.admin_step_up_method_backup_code()
    case 'email_otp':
      return m.admin_step_up_method_email_otp()
    case 'password':
      return m.admin_step_up_method_password()
    case 'rescue':
      return m.admin_step_up_method_rescue()
  }
}

/** 锁定解锁时间按浏览器本地时区显示到分钟 */
function clockTime(value: string): string {
  const date = new Date(value)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 救援开启时默认选救援方式（设计稿 rescue 状态），否则选账号最强的方式（服务端按优先级排列） */
function defaultMethod(methods: readonly StepUpMethod[]): StepUpMethod | undefined {
  return methods.includes('rescue') ? 'rescue' : methods[0]
}

function failureMessage(method: StepUpMethod, failure: VerifyFailure): string {
  const details = failure.details ?? {}
  switch (failure.error) {
    case 'STEP_UP_INVALID':
      if (details.reason === 'replayed') return m.admin_step_up_error_replayed()
      if (method === 'password') return m.admin_step_up_error_password()
      if (method === 'backup_code') return m.admin_step_up_error_backup()
      return typeof details.attemptsRemaining === 'number' && details.attemptsRemaining > 0
        ? m.admin_step_up_error_code_remaining({ count: details.attemptsRemaining })
        : m.admin_step_up_error_code()
    case 'STEP_UP_CODE_EXPIRED':
      return m.admin_step_up_error_expired()
    case 'STEP_UP_RATE_LIMITED':
      return m.admin_step_up_error_rate_limited()
    case 'STEP_UP_RESEND_COOLDOWN':
      return m.admin_step_up_error_cooldown()
    case 'EMAIL_UNAVAILABLE':
      return m.admin_step_up_error_email_unavailable()
    case 'STEP_UP_METHOD_UNAVAILABLE':
      return m.admin_step_up_error_method_unavailable()
    default:
      return m.admin_step_up_error_failed()
  }
}

export interface StepUpDialogProps {
  readonly open: boolean
  /** 被拦下的操作名称（如「积分调整」），显示在说明与成功提示中 */
  readonly action?: string | undefined
  /** STEP_UP_REQUIRED 错误中带回的可用方式，读取状态前先用它渲染 */
  readonly methods: readonly StepUpMethod[]
  /** 验证通过、正在用原参数继续操作 */
  readonly continuing: boolean
  readonly onVerified: (result: StepUpVerifiedResult) => void
  readonly onCancel: () => void
  /** 测试注入；默认调用 Server Functions */
  readonly api?: StepUpApi
}

export interface StepUpApi {
  status: () => Promise<StepUpStatus>
  send: (method: 'email_otp' | 'rescue') => ReturnType<typeof sendStepUpCode>
  verify: (
    input:
      | { method: 'password'; password: string }
      | { method: Exclude<StepUpMethod, 'password'>; code: string },
  ) => ReturnType<typeof verifyStepUp>
}

export const defaultStepUpApi: StepUpApi = {
  status: () => getStepUpStatus(),
  send: (method) => sendStepUpCode({ data: { method } }),
  verify: (data) => verifyStepUp({ data }),
}

export function StepUpDialog(props: StepUpDialogProps) {
  const desktop = useSyncExternalStore(subscribeDesktop, desktopSnapshot, desktopServerSnapshot)
  const titleText = m.admin_step_up_title()
  const minutes = templateConfig.admin.stepUpMinutes
  const description = props.action
    ? m.admin_step_up_description({ action: props.action, minutes })
    : m.admin_step_up_description_generic({ minutes })
  const onOpenChange = (next: boolean) => {
    // 继续执行原操作期间不允许关闭，避免用户以为已取消
    if (!next && !props.continuing) props.onCancel()
  }
  // 每次打开重新挂载表单：上一次的输入、错误与方式选择不会带到下一次
  const body = props.open ? <StepUpForm {...props} desktop={desktop} /> : null
  if (desktop)
    return (
      <Dialog open={props.open} onOpenChange={onOpenChange}>
        <DialogContent
          size="sm"
          closeLabel={m.admin_step_up_close()}
          showCloseButton={!props.continuing}
        >
          <DialogHeader>
            <DialogTitle>{titleText}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    )
  return (
    <Sheet open={props.open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false}>
        <SheetHeader>
          <SheetTitle>{titleText}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{body}</div>
      </SheetContent>
    </Sheet>
  )
}

function StepUpForm(props: StepUpDialogProps & { readonly desktop: boolean }) {
  const api = props.api ?? defaultStepUpApi
  const formId = useId()
  const [status, setStatus] = useState<StepUpStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const methods: readonly StepUpMethod[] = status?.methods ?? props.methods
  const [picked, setPicked] = useState<StepUpMethod | undefined>(() => defaultMethod(props.methods))
  const method = picked && methods.includes(picked) ? picked : defaultMethod(methods)
  const [code, setCode] = useState('')
  const [secret, setSecret] = useState('')
  const [error, setError] = useState('')
  const [lockedUntil, setLockedUntil] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [resendAt, setResendAt] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let active = true
    api
      .status()
      .then((next) => {
        if (!active) return
        setStatus(next)
        setLockedUntil(next.lockedUntil)
        if (next.code) {
          setSentTo(next.email)
          setResendAt(next.code.resendAt)
        }
        setPicked((current) =>
          current && next.methods.includes(current) ? current : defaultMethod(next.methods),
        )
      })
      .catch(() => {
        if (active) setLoadFailed(true)
      })
    return () => {
      active = false
    }
  }, [api])

  // 冷却倒计时与锁定到期按秒刷新
  const cooling = secondsLeft(resendAt, now)
  const locked = lockedUntil !== null && new Date(lockedUntil).getTime() > now
  useEffect(() => {
    if (cooling <= 0 && !locked) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [cooling, locked])

  function choose(next: StepUpMethod) {
    setPicked(next)
    setCode('')
    setSecret('')
    setError('')
  }

  async function send() {
    if (!method || !EMAIL_METHODS.has(method)) return
    setSending(true)
    setError('')
    try {
      const result = await api.send(method === 'rescue' ? 'rescue' : 'email_otp')
      if (result.ok) {
        setSentTo(result.email)
        setResendAt(result.resendAt)
        setNow(Date.now())
      } else {
        const failure = result as VerifyFailure
        if (failure.error === 'STEP_UP_LOCKED' && typeof failure.details?.lockedUntil === 'string')
          setLockedUntil(failure.details.lockedUntil)
        else if (
          failure.error === 'STEP_UP_RESEND_COOLDOWN' &&
          typeof failure.details?.resendAt === 'string'
        )
          setResendAt(failure.details.resendAt)
        else setError(failureMessage(method, failure))
        setNow(Date.now())
      }
    } catch {
      setError(m.admin_step_up_error_failed())
    } finally {
      setSending(false)
    }
  }

  const isCode = method !== undefined && CODE_METHODS.has(method)
  const ready = isCode ? code.length === CODE_LENGTH : secret.trim().length > 0

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!method || !ready || submitting || locked) return
    setSubmitting(true)
    setError('')
    try {
      const result = await api.verify(
        method === 'password'
          ? { method, password: secret }
          : { method, code: isCode ? code : secret.trim() },
      )
      if (result.ok) {
        props.onVerified({ method: result.method, expiresAt: result.expiresAt })
        return
      }
      const failure = result as VerifyFailure
      if (failure.error === 'STEP_UP_LOCKED' && typeof failure.details?.lockedUntil === 'string') {
        setLockedUntil(failure.details.lockedUntil)
        setNow(Date.now())
      } else {
        if (
          failure.error === 'STEP_UP_METHOD_UNAVAILABLE' &&
          Array.isArray(failure.details?.methods)
        )
          setStatus((current) =>
            current ? { ...current, methods: failure.details?.methods as StepUpMethod[] } : current,
          )
        if (failure.error === 'STEP_UP_CODE_EXPIRED') {
          setSentTo(null)
          setResendAt(null)
          setCode('')
        }
        setError(failureMessage(method, failure))
      }
    } catch {
      setError(m.admin_step_up_error_failed())
    } finally {
      setSubmitting(false)
    }
  }

  const codeLabelId = `${formId}-code`
  const secretId = `${formId}-secret`
  const none = status !== null && methods.length === 0
  const showInputs = !props.continuing && !locked && !none && method !== undefined
  const emailHint =
    sentTo !== null
      ? m.admin_step_up_email_sent({ email: sentTo })
      : status?.email
        ? m.admin_step_up_email_will_send({ email: status.email })
        : m.admin_step_up_email_will_send_generic()

  let content: ReactNode
  if (props.continuing)
    content = (
      <Alert variant="success">
        <AlertDescription>
          {props.action
            ? m.admin_step_up_success({ action: props.action })
            : m.admin_step_up_success_generic()}
        </AlertDescription>
      </Alert>
    )
  else if (locked && lockedUntil)
    content = (
      <Alert variant="destructive">
        <AlertTitle>{m.admin_step_up_locked_title()}</AlertTitle>
        <AlertDescription>
          {m.admin_step_up_locked_body({ time: clockTime(lockedUntil) })}
        </AlertDescription>
      </Alert>
    )
  else if (none)
    content = (
      <Alert>
        <AlertTitle>{m.admin_step_up_none_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.admin_step_up_none_body()}</p>
          <p className="font-mono">{m.admin_step_up_none_runbook()}</p>
        </AlertDescription>
      </Alert>
    )

  return (
    <form
      id={formId}
      onSubmit={(event) => void submit(event)}
      className="grid min-w-0 gap-4"
      noValidate
    >
      {showInputs && methods.length > 1 ? (
        <Tabs
          aria-label={m.admin_step_up_methods_label()}
          selectedIndex={Math.max(0, methods.indexOf(method))}
          onSelect={(index) => {
            const next = methods[index]
            if (next) choose(next)
          }}
        >
          {methods.map((item, index) => (
            <TabsItem key={item} index={index} label={methodLabel(item)} />
          ))}
        </Tabs>
      ) : null}
      {showInputs && method === 'rescue' ? (
        <Alert variant="destructive">
          <AlertDescription>{m.admin_step_up_rescue_note()}</AlertDescription>
        </Alert>
      ) : null}
      {showInputs && isCode ? (
        <div className="grid min-w-0 gap-2.5">
          <span id={codeLabelId} className="font-medium text-muted-foreground text-sm">
            {method === 'totp'
              ? m.admin_step_up_code_label_totp()
              : m.admin_step_up_code_label_email()}
          </span>
          <InputOTP
            aria-labelledby={codeLabelId}
            aria-invalid={error ? true : undefined}
            value={code}
            onChange={(next) => {
              setCode(next)
              if (error) setError('')
            }}
            autoFocus={method === 'totp' || sentTo !== null}
            {...(props.desktop ? {} : { containerClassName: 'w-full justify-between' })}
          />
          {method !== undefined && EMAIL_METHODS.has(method) ? (
            <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-sm">
              <span className="min-w-0 flex-1">{emailHint}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                disabled={sending || cooling > 0}
                onClick={() => void send()}
              >
                {sending
                  ? m.admin_step_up_sending()
                  : cooling > 0
                    ? m.admin_step_up_resend_in({ seconds: cooling })
                    : sentTo !== null
                      ? m.admin_step_up_resend()
                      : m.admin_step_up_send_code()}
              </Button>
            </div>
          ) : (
            <span className="text-muted-foreground text-sm">{m.admin_step_up_totp_hint()}</span>
          )}
        </div>
      ) : null}
      {showInputs && !isCode ? (
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={secretId}>
            {method === 'password'
              ? m.admin_step_up_password_label()
              : m.admin_step_up_backup_label()}
          </Label>
          <Input
            id={secretId}
            type={method === 'password' ? 'password' : 'text'}
            autoComplete={method === 'password' ? 'current-password' : 'one-time-code'}
            placeholder={method === 'backup_code' ? 'xxxx-xxxx' : undefined}
            className={method === 'backup_code' ? 'font-mono' : undefined}
            aria-invalid={error ? true : undefined}
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value)
              if (error) setError('')
            }}
            autoFocus
          />
          {method === 'backup_code' ? (
            <span className="text-muted-foreground text-sm">{m.admin_step_up_backup_hint()}</span>
          ) : null}
        </div>
      ) : null}
      {status === null && !loadFailed && !props.continuing && props.methods.length === 0 ? (
        <p role="status" className="text-muted-foreground text-sm">
          {m.admin_step_up_loading()}
        </p>
      ) : null}
      {loadFailed && status === null && !props.continuing ? (
        <p role="alert" className="font-medium text-destructive text-sm">
          {m.admin_step_up_error_failed()}
        </p>
      ) : null}
      {error && !locked ? (
        <p role="alert" className="font-medium text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {content}
      <StepUpFooter desktop={props.desktop}>
        {props.desktop ? (
          <>
            <CancelButton {...props} />
            <SubmitButton
              {...props}
              visible={!none}
              disabled={!ready || locked}
              submitting={submitting}
            />
          </>
        ) : (
          <>
            <SubmitButton
              {...props}
              visible={!none}
              disabled={!ready || locked}
              submitting={submitting}
            />
            <CancelButton {...props} />
          </>
        )}
      </StepUpFooter>
    </form>
  )
}

function StepUpFooter({ desktop, children }: { desktop: boolean; children: ReactNode }) {
  return desktop ? (
    <DialogFooter className="mt-2">{children}</DialogFooter>
  ) : (
    <SheetFooter className="mt-2 grid gap-2 p-0">{children}</SheetFooter>
  )
}

function CancelButton(props: StepUpDialogProps & { readonly desktop: boolean }) {
  return (
    <Button
      type="button"
      variant={props.desktop ? 'outline' : 'ghost'}
      disabled={props.continuing}
      onClick={props.onCancel}
    >
      {m.admin_step_up_cancel()}
    </Button>
  )
}

function SubmitButton(
  props: StepUpDialogProps & {
    readonly desktop: boolean
    readonly visible: boolean
    readonly disabled: boolean
    readonly submitting: boolean
  },
) {
  if (!props.visible || props.continuing) return null
  return (
    <Button type="submit" disabled={props.disabled || props.submitting} loading={props.submitting}>
      {props.submitting ? m.admin_step_up_submitting() : m.admin_step_up_submit()}
    </Button>
  )
}
