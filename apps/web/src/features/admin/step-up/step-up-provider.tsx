import type { StepUpMethod } from '@saas/auth'
import { Badge } from '@saas/ui'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { m } from '../../../paraglide/messages.js'
import {
  minutesLeft,
  STEP_UP_CANCELLED,
  type StepUpCancelled,
  stepUpRequiredMethods,
} from './client.ts'
import {
  type StepUpApi,
  StepUpDialog,
  type StepUpStatus,
  type StepUpVerifiedResult,
} from './step-up-dialog.tsx'

/**
 * 后台统一的敏感操作调用包装（openspec add-admin-step-up 决策 10、任务 4.1）。
 *
 * `StepUpProvider` 挂在后台布局根部，只渲染一个验证弹窗；表单组件不卸载，已填写内容不丢失。
 * `useStepUpCall(serverFn)` 返回同签名的调用函数：服务端以 `STEP_UP_REQUIRED` 拒绝时打开弹窗，
 * 验证通过后用**同一份参数**重试一次并把结果交回调用方；取消时返回 `STEP_UP_CANCELLED`。
 * 检查在服务端任何副作用之前（决策 2），被拒的那次请求没有写入，重试是安全的。
 */

type Waiter = {
  readonly retry: () => Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

type Pending = {
  readonly action: string | undefined
  readonly methods: readonly StepUpMethod[]
  readonly waiters: Waiter[]
}

type Verified = { readonly method: string; readonly expiresAt: string }

interface StepUpContextValue {
  request<T>(
    input: { action: string | undefined; methods: readonly StepUpMethod[] },
    retry: () => Promise<T>,
  ): Promise<T | StepUpCancelled>
  readonly verified: Verified | null
  readonly rescueMode: boolean
  /** 验证弹窗正在打开（等待用户验证，原操作尚未执行） */
  readonly verifying: boolean
}

const StepUpContext = createContext<StepUpContextValue | null>(null)

export function StepUpProvider({
  status,
  api,
  children,
}: {
  /** 后台布局加载器读取的当前状态；读取失败时为 null（不显示状态，弹窗照常工作） */
  readonly status: Pick<StepUpStatus, 'verified' | 'rescueMode'> | null
  readonly api?: StepUpApi
  readonly children: ReactNode
}) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [continuing, setContinuing] = useState(false)
  const [verified, setVerified] = useState<Verified | null>(status?.verified || null)
  const pendingRef = useRef<Pending | null>(null)
  pendingRef.current = pending

  // 加载器重新读取（导航、invalidate）后以服务端为准
  const loaderVerified = status?.verified || null
  useEffect(() => {
    setVerified(loaderVerified)
  }, [loaderVerified])

  const request = useCallback<StepUpContextValue['request']>((input, retry) => {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        retry,
        resolve: resolve as (value: unknown) => void,
        reject,
      }
      // 弹窗已打开时（并发的第二个敏感调用）合并到同一次验证
      const current = pendingRef.current
      if (current) {
        current.waiters.push(waiter)
        return
      }
      const next: Pending = { action: input.action, methods: input.methods, waiters: [waiter] }
      pendingRef.current = next
      setPending(next)
    })
  }, [])

  const finish = useCallback(() => {
    pendingRef.current = null
    setPending(null)
    setContinuing(false)
  }, [])

  const onVerified = useCallback(
    async (result: StepUpVerifiedResult) => {
      const current = pendingRef.current
      if (!current) return
      setVerified({ method: result.method, expiresAt: result.expiresAt })
      setContinuing(true)
      await Promise.all(
        current.waiters.map((waiter) => waiter.retry().then(waiter.resolve, waiter.reject)),
      )
      finish()
    },
    [finish],
  )

  const onCancel = useCallback(() => {
    const current = pendingRef.current
    if (!current) return
    for (const waiter of current.waiters) waiter.resolve(STEP_UP_CANCELLED)
    finish()
  }, [finish])

  const value = useMemo<StepUpContextValue>(
    () => ({
      request,
      verified,
      rescueMode: status?.rescueMode ?? false,
      verifying: pending !== null && !continuing,
    }),
    [request, verified, status?.rescueMode, pending, continuing],
  )

  return (
    <StepUpContext.Provider value={value}>
      {children}
      <StepUpDialog
        open={pending !== null}
        action={pending?.action}
        methods={pending?.methods ?? []}
        continuing={continuing}
        onVerified={(result) => void onVerified(result)}
        onCancel={onCancel}
        {...(api ? { api } : {})}
      />
    </StepUpContext.Provider>
  )
}

/**
 * 包装一个后台写操作的 Server Function。返回的函数参数与原函数相同；
 * 结果为原函数的返回值，或用户取消验证时的 `STEP_UP_CANCELLED`（用 `isStepUpCancelled` 判断）。
 * 其他错误原样抛出。`options.action` 为弹窗中显示的操作名称。
 */
export function useStepUpCall<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: { readonly action?: string } = {},
): (...args: TArgs) => Promise<TResult | StepUpCancelled> {
  const context = useContext(StepUpContext)
  const fnRef = useRef(fn)
  fnRef.current = fn
  const action = options.action
  return useCallback(
    async (...args: TArgs) => {
      try {
        return await fnRef.current(...args)
      } catch (error) {
        const methods = stepUpRequiredMethods(error)
        // 不在后台布局内（单独渲染的组件测试等）时没有弹窗可用，按原错误处理
        if (methods === undefined || !context) throw error
        return context.request({ action, methods }, () => fnRef.current(...args))
      }
    },
    [context, action],
  )
}

/** 验证弹窗打开期间为 true：调用方据此不把等待验证显示为「执行中」 */
export function useStepUpVerifying(): boolean {
  return useContext(StepUpContext)?.verifying ?? false
}

/** 当前会话的验证剩余时间（后台顶部状态）；未验证、已过期时不显示 */
export function StepUpVerifiedChip() {
  const context = useContext(StepUpContext)
  const expiresAt = context?.verified?.expiresAt
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    if (!expiresAt) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [expiresAt])
  // 服务端与水合首帧不显示：剩余分钟依赖浏览器时钟
  if (!expiresAt || now === null) return null
  const minutes = minutesLeft(expiresAt, now)
  if (minutes <= 0) return null
  return (
    <Badge color="green" role="status">
      {m.admin_step_up_verified_chip({ minutes })}
    </Badge>
  )
}

/** 救援开关开启期间后台所有页面顶部的警示条（决策 5） */
export function StepUpRescueBanner() {
  const context = useContext(StepUpContext)
  if (!context?.rescueMode) return null
  return (
    <div
      role="alert"
      className="border-destructive/30 border-b bg-destructive/10 px-4 py-2 font-medium text-destructive text-body sm:px-6"
    >
      <span className="hidden md:inline">{m.admin_step_up_rescue_banner()}</span>
      <span className="md:hidden">{m.admin_step_up_rescue_banner_short()}</span>
    </div>
  )
}
