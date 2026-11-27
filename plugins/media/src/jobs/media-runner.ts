import {
  attemptsWithJobId,
  canSwitchMediaAttempt,
  type FailureKind,
  failureKindOf,
  isSyncMediaProvider,
  type MediaAcceptanceFault,
  type MediaBinaryResult,
  type MediaError,
  type MediaResult,
  type MediaStatus,
  type MediaTaskFile,
  mediaAttemptIndex,
  mediaAttemptRequest,
  mediaCallbackUrl,
  nextMediaCandidate,
  readMediaFailover,
  readMediaFault,
  readMediaTaskInput,
  type SyncMediaProvider,
  settleMediaTask,
  switchMediaTaskAttempt,
  type TaskMediaProvider,
  updateMediaFaultProof,
  wrapMediaFaultProvider,
} from '@saas/ai'
import { type AiFaultInjectionEnv, isAiFaultInjectionEnabled } from '@saas/config'
import { type AiTask, aiTask, type Database, dbSettingStore, getSetting, scoped } from '@saas/db'
import { NonRetryableError, type WorkflowStep } from '@saas/platform'
import { AppError, MEDIA_DONE_EVENT } from '@saas/shared'
import { type JobObserver, log, logJobObserver, setLogContext } from '@saas/shared/log'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

export type AiMediaParams = {
  taskId: string
  requestId?: string
}

export interface MediaRunnerDeps {
  db: Database
  provider(task: AiTask): TaskMediaProvider
  params(task: AiTask): Promise<Record<string, unknown>>
  callbackOrigin: string
  callbackSecret: string
  faultEnv?: AiFaultInjectionEnv
  persist(
    task: AiTask,
    result: MediaResult | MediaBinaryResult,
  ): Promise<
    {
      id: string
      mime: string
      size: number
      width?: number | null
      height?: number | null
      duration?: number | null
    }[]
  >
  observer?: JobObserver
  now?: () => number
}
// Provider 的 interface 本身没有 JSON 索引签名；只在持久步骤边界展开现有 JSON 字段。
type StepData<T> = T extends object ? { [K in keyof T]: StepData<T[K]> } : T
type Callback = StepData<{ jobId: string; result?: MediaResult; error?: MediaError }>
type SubmitFailover = { kind: FailureKind; code: string; message: string }
/** 失败注入后由真实作业以外的结果决定成败的模式；这些模式下不采用回调。 */
const FAULT_FAILING_MODES = [
  'fal-submit-response-lost',
  'fal-provider-error',
  'fal-timeout',
  'fal-failover-job-failed',
]
/** 服务商在运行时已停用或缺凭据：尚未提交的尝试可切换。 */
const providerUnavailable = (error: unknown) =>
  error instanceof AppError &&
  (error.code === 'AI_PROVIDER_NOT_CONFIGURED' || error.code === 'MODEL_UNAVAILABLE')
const terminal = (task: AiTask) => ['succeeded', 'failed', 'canceled'].includes(task.status)
// 同步提交中以 NonRetryableError 带出的业务错误码（两目标的 step adapter 都会跨 step 还原 code）。
const carriedCode = (error: unknown) =>
  error instanceof NonRetryableError &&
  'code' in error &&
  typeof error.code === 'string' &&
  error.code !== 'MEDIA_SUBMISSION_UNCERTAIN'
    ? error.code
    : null
const errorOf = (error: unknown): MediaError => ({
  code:
    error instanceof AppError
      ? error.code
      : (carriedCode(error) ??
        (error instanceof Error && error.message === 'MEDIA_SUBMISSION_UNCERTAIN'
          ? 'MEDIA_SUBMISSION_UNCERTAIN'
          : 'MEDIA_GENERATION_FAILED')),
  message:
    error instanceof AppError || (carriedCode(error) && error instanceof Error)
      ? error.message
      : error instanceof Error && error.message === 'MEDIA_SUBMISSION_UNCERTAIN'
        ? 'Submission outcome is uncertain; credits were returned'
        : 'Media generation failed',
})
const UNCERTAIN = 'MEDIA_SUBMISSION_UNCERTAIN'
const UNCERTAIN_WAITING = 'Submission outcome is uncertain; waiting for provider callback'

/** 提交结果不确定：保留预扣，任务保持 running 并打标记，等待已验签回调写入作业 ID（D3）。 */
async function markSubmissionUncertain(db: Database, task: AiTask) {
  await scoped(db, task.workspaceId).update(
    aiTask,
    {
      status: 'running',
      startedAt: sql`coalesce(${aiTask.startedAt}, now())`,
      errorCode: UNCERTAIN,
      errorMessage: UNCERTAIN_WAITING,
    },
    and(
      eq(aiTask.id, task.id),
      inArray(aiTask.status, ['queued', 'running']),
      isNull(aiTask.providerJobId),
    ),
  )
}

const SYNC_SUBMIT_RETRIES = { limit: 2, delayMs: 10_000, backoff: 'exponential' } as const

/** 同步提交只重试 Provider 标明的瞬时失败；其余失败带原错误码直接终止，不再推理。 */
function syncSubmitFailure(taskId: string, error: unknown): Error {
  const app = error instanceof AppError ? error : null
  const retryable = app?.details?.retryable === true
  // 非业务错误只记录错误名，原异常经 cause 交给观测，不写入任务。
  const errorName = error instanceof Error ? error.name : typeof error
  log.warn('ai.media.sync_submit_failed', {
    taskId,
    errorName,
    code: app?.code ?? 'MEDIA_GENERATION_FAILED',
    upstreamName: app?.details?.upstreamName ?? null,
    upstreamCode: app?.details?.upstreamCode ?? null,
    retryable,
  })
  if (retryable && app) return app
  if (error instanceof NonRetryableError) return error
  return app
    ? Object.assign(new NonRetryableError(app.message), { code: app.code })
    : new NonRetryableError(`Media generation failed (${errorName})`, { cause: error })
}

/** 无幂等能力时，进程在受理/落库间崩溃后也不能再次提交。 */
export async function submitMediaOnce(
  task: AiTask,
  deps: MediaRunnerDeps,
  options: {
    /** 明确未受理且分类可切换时是否改用下一候选（由调用方按候选与剩余时间判断）。 */
    canFailover?: (kind: FailureKind) => boolean
  } = {},
): Promise<{
  jobId: string
  sync: StepData<MediaResult> | null
  stopped: boolean
  uncertain?: boolean
  failover?: StepData<SubmitFailover>
}> {
  const { db } = deps
  if (!deps.callbackSecret)
    throw new AppError('MEDIA_WEBHOOK_NOT_CONFIGURED', 'Media callback is not configured', {
      status: 503,
    })
  const provider = deps.provider(task)
  if (isSyncMediaProvider(provider))
    throw new AppError('INVALID_MEDIA_PROVIDER', 'Async submission requires an async provider')
  const fresh = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
    )
    const tenant = scoped(tx, task.workspaceId)
    const current = (
      await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
    )[0]
    if (!current) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    if (terminal(current) || current.providerJobId) return current
    // 上次提交可能已被受理（进程中断或步骤重放）：不重提，转入等待回调。
    if (current.output?.submissionAttempted && !provider.capabilities.idempotentSubmit)
      return { ...current, errorCode: UNCERTAIN }
    const fault = readMediaFault(current)
    await tenant.updateById(aiTask, task.id, {
      output: { submissionAttempted: true },
      ...(fault
        ? {
            input: {
              ...current.input,
              acceptanceFaultProof: {
                ...(current.input?.acceptanceFaultProof as Record<string, unknown>),
                submitAttempts: 1,
              },
            },
          }
        : {}),
    })
    return current
  })
  if (terminal(fresh)) return { jobId: '', sync: null, stopped: true }
  if (!fresh.providerJobId && fresh.errorCode === UNCERTAIN) {
    await markSubmissionUncertain(db, task)
    return { jobId: '', sync: null, stopped: false, uncertain: true }
  }
  if (fresh.providerJobId)
    return {
      jobId: fresh.providerJobId,
      sync: (fresh.callbackPayload as Callback | null)?.result ?? null,
      stopped: false,
    }
  const params = await deps.params(task)
  // 回调地址签名包含当前尝试序号，旧尝试的晚到回调可被识别并忽略（D4）。
  const webhookUrl = await mediaCallbackUrl(
    readMediaTaskInput(task).callbackOrigin ?? deps.callbackOrigin,
    deps.callbackSecret,
    { id: task.id, provider: task.provider, attempt: mediaAttemptIndex(task) },
  )
  try {
    const result = await provider.submit({
      modelId: mediaAttemptRequest(task).providerModelId,
      params,
      webhookUrl,
      idempotencyKey: task.providerRequestKey,
    })
    // jobId 第一时间持久化；回调可能先到，核对它已记录的原始作业 ID。
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${task.workspaceId}`}, 0))`,
      )
      const tenant = scoped(tx, task.workspaceId)
      const current = (
        await tenant.select(aiTask, { where: eq(aiTask.id, task.id) }).for('update')
      )[0]
      if (!current) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
      const callback = current.callbackPayload as Callback | null
      if (callback && callback.jobId !== result.jobId)
        throw new AppError('MEDIA_JOB_MISMATCH', 'Callback job does not match submission')
      await tenant.updateById(aiTask, task.id, {
        providerJobId: result.jobId,
        providerAttempts: attemptsWithJobId(current, result.jobId),
        ...(terminal(current)
          ? {}
          : {
              status: 'running',
              startedAt: new Date(),
              ...(result.sync && !callback
                ? { callbackPayload: { jobId: result.jobId, result: result.sync } }
                : {}),
            }),
      })
    })
    const after = await scoped(db, task.workspaceId).findById(aiTask, task.id)
    if (terminal(after) && provider.cancel) {
      try {
        await provider.cancel(result.jobId)
      } catch {
        // HTTP 取消可能早于 jobId 落库；补取消失败必须留下可重试标记。
        if (after.status === 'canceled')
          await scoped(db, task.workspaceId).updateById(aiTask, task.id, {
            errorCode: 'MEDIA_CANCEL_PENDING',
            errorMessage: 'Task canceled; external cancellation needs retry',
          })
        log.warn('ai.media.cancel_pending', { taskId: task.id })
      }
    }
    return { jobId: result.jobId, sync: result.sync ?? null, stopped: terminal(after) }
  } catch (error) {
    const rejected =
      typeof error === 'object' &&
      error !== null &&
      'submissionOutcome' in error &&
      error.submissionOutcome === 'rejected'
    // 「提交结果不确定」优先：fal、kie 与 Replicate 对 5xx / 408 / 网络异常 / 无法解析的回包都标记 ambiguous，
    // 不进入此分支，走下方「提交确认中」，不重提也不切换。只有明确未受理（rejected）才可能切换。
    if (rejected) {
      // 切换后的尝试状态已是 running；未取得作业 ID 时清除提交标记，允许重试或切换。
      await scoped(db, task.workspaceId).update(
        aiTask,
        { output: null },
        and(
          eq(aiTask.id, task.id),
          inArray(aiTask.status, ['queued', 'running']),
          isNull(aiTask.providerJobId),
        ),
      )
      const kind = failureKindOf(error)
      if (options.canFailover?.(kind)) {
        const code = error instanceof AppError ? error.code : 'MEDIA_SUBMIT_REJECTED'
        log.warn('ai.media.submit_rejected', { taskId: task.id, errorCode: code, kind })
        return {
          jobId: '',
          sync: null,
          stopped: false,
          failover: {
            kind,
            code,
            message: error instanceof AppError ? error.message : 'Media submission was rejected',
          },
        }
      }
      // 明确拒绝且非限流（如 401 密钥失效、400 参数错误）：重试不会成功，带原错误码直接终止。
      // 普通异常跨 Workflow step 只保留 name/message，须经 NonRetryableError 携带 code 才能写入任务。
      const httpStatus =
        typeof error === 'object' && error !== null && 'httpStatus' in error
          ? error.httpStatus
          : undefined
      if (
        error instanceof AppError &&
        typeof httpStatus === 'number' &&
        httpStatus >= 400 &&
        httpStatus < 500 &&
        httpStatus !== 429
      ) {
        log.warn('ai.media.submit_rejected', { taskId: task.id, errorCode: error.code, httpStatus })
        throw Object.assign(new NonRetryableError(error.message), { code: error.code })
      }
      throw error
    }
    if (!provider.capabilities.idempotentSubmit) {
      // 转成 UNCERTAIN 前保留原因；只记录错误名、代码与 HTTP 状态，不含上游正文或参数。
      log.warn('ai.media.submit_uncertain', {
        taskId: task.id,
        errorName: error instanceof Error ? error.name : typeof error,
        errorCode: error instanceof AppError ? error.code : undefined,
        httpStatus:
          typeof error === 'object' && error !== null && 'httpStatus' in error
            ? error.httpStatus
            : undefined,
        causeName:
          typeof error === 'object' && error !== null && 'causeName' in error
            ? error.causeName
            : undefined,
      })
      await markSubmissionUncertain(db, task)
      return { jobId: '', sync: null, stopped: false, uncertain: true }
    }
    throw error
  }
}

async function submitSynchronousMedia(
  task: AiTask,
  deps: MediaRunnerDeps,
  provider: SyncMediaProvider,
): Promise<string[]> {
  const fresh = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
  if (terminal(fresh)) return []
  await scoped(deps.db, task.workspaceId).update(
    aiTask,
    { status: 'running', startedAt: new Date() },
    and(eq(aiTask.id, task.id), eq(aiTask.status, 'queued')),
  )
  const generated = await provider.run({
    modelId: mediaAttemptRequest(task).providerModelId,
    params: await deps.params(task),
    idempotencyKey: task.providerRequestKey,
  })
  const files = await deps.persist(task, generated)
  // 字节不跨 step；保存可供现有结算及回收器使用的文件描述与用量。
  const result: MediaResult = {
    outputs: files.map((file) => ({
      url: `/api/files/${file.id}`,
      mime: file.mime,
      ...(file.width != null ? { width: file.width } : {}),
      ...(file.height != null ? { height: file.height } : {}),
      ...(file.duration != null ? { durationSec: file.duration } : {}),
    })),
    ...(generated.usage ? { usage: generated.usage } : {}),
  }
  await scoped(deps.db, task.workspaceId).update(
    aiTask,
    { output: { files, result, usage: result.usage ?? null } },
    and(eq(aiTask.id, task.id), inArray(aiTask.status, ['queued', 'running'])),
  )
  return files.map((file) => file.id)
}

/**
 * 事件只唤醒，结果始终以先落库的 callback 为准；每次轮询使用独立持久步骤。
 * 服务商切换（add-media-provider-fallback D5）：每个尝试走一遍提交 → 等回调 → 轮询；尝试序号 0 的步骤名
 * 与升级前相同（在途任务可安全重放），之后的尝试在步骤名后加 `-a<n>`，切换本身是 `failover-a<n>` 步骤。
 */
export async function runMediaTask(taskId: string, step: WorkflowStep, deps: MediaRunnerDeps) {
  const observer = deps.observer ?? logJobObserver
  const snapshot = await step.do('load-task', async () => {
    // 内部 Workflow taskId 用于定位租户，之后业务查询一律 scoped。
    // biome-ignore lint/plugin: 内部绑定创建的 taskId 用于定位租户，后续读写均 scoped。
    const task = await deps.db.query.aiTask.findFirst({ where: eq(aiTask.id, taskId) })
    if (!task) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    return JSON.stringify(task)
  })
  const task = JSON.parse(snapshot) as AiTask
  setLogContext({ workspaceId: task.workspaceId, userId: task.userId })
  observer.tagContext()
  const now = deps.now ?? Date.now
  const deadline = new Date(task.deadlineAt).getTime()
  let currentStatus = task.status
  let cancellationAttempted = false
  let fault: MediaAcceptanceFault | undefined
  let providerAccessAllowed = false
  // 当前尝试：切换步骤返回新的任务快照，序号随之前进；故障注入只作用于序号 0。
  let current = task
  let attempt = mediaAttemptIndex(task)
  const attemptFault = () => (attempt === 0 ? fault : undefined)
  const named = (name: string) => (attempt === 0 ? name : `${name}-a${attempt}`)
  const faultEnabled = isAiFaultInjectionEnabled(deps.faultEnv ?? {})
  const proof = (patch: Parameters<typeof updateMediaFaultProof>[2]) =>
    updateMediaFaultProof(deps.db, task, patch)
  const faultFails = () => fault && FAULT_FAILING_MODES.includes(fault.mode)
  const attemptFaultFails = () => attempt === 0 && faultFails()
  const stopIfTerminal = async () => {
    const fresh = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
    currentStatus = fresh.status
    if (!terminal(fresh)) return false
    if (!providerAccessAllowed || (fault && !isAiFaultInjectionEnabled(deps.faultEnv ?? {})))
      return true
    if (faultFails() && fresh.status === 'failed' && !cancellationAttempted) {
      cancellationAttempted = true
      await step.do('fault-cancel-original', async () => {
        const originalId = (
          fresh.input?.acceptanceFaultProof as { realRequestId?: string } | undefined
        )?.realRequestId
        if (!originalId) return null
        // 原作业属于首个尝试（fal），切换后当前服务商可能已不同。
        const first = fresh.providerAttempts?.[0]
        const original = deps.provider(
          first
            ? {
                ...fresh,
                provider: first.provider,
                input: { ...fresh.input, providerModelId: first.providerModelId },
              }
            : fresh,
        )
        if (isSyncMediaProvider(original)) return null
        let cancellation: Parameters<typeof updateMediaFaultProof>[2]['cancellation'] = {
          status: 'unconfirmed',
        }
        try {
          if (!original.cancel) throw new Error('Cancellation unavailable')
          await original.cancel(originalId)
          cancellation = { status: 'cancellation-requested' }
        } catch {
          // 包装后的 queued/failed 不是外部真实状态；取消失败只能查询原 Provider。
          try {
            const status = await original.getStatus(originalId)
            cancellation = {
              status: ['succeeded', 'failed'].includes(status.status)
                ? 'already-terminal'
                : 'unconfirmed',
              providerStatus: status.status,
            }
          } catch {
            // 查询失败无法确认外部作业已停止，证据保留未确认状态。
          }
        }
        await proof({ cancellation })
        return null
      })
    } else if (fresh.providerJobId && !cancellationAttempted) {
      cancellationAttempted = true
      try {
        const provider = deps.provider(fresh)
        if (!isSyncMediaProvider(provider)) await provider.cancel?.(fresh.providerJobId)
      } catch {
        log.warn('ai.media.terminal_cancel_failed', { taskId, status: fresh.status })
      }
    }
    return true
  }
  const stopped = () => ({ taskId, status: currentStatus })
  const active = async () => {
    if (fault && !isAiFaultInjectionEnabled(deps.faultEnv ?? {})) {
      providerAccessAllowed = false
      throw new AppError('ACCEPTANCE_FAULT_DISABLED', 'Acceptance fault execution is disabled')
    }
    if (await stopIfTerminal()) return false
    if (now() >= deadline) throw new AppError('MEDIA_TIMEOUT', 'Media generation timed out')
    return true
  }
  const readCallback = async (): Promise<Callback | null> =>
    (await scoped(deps.db, task.workspaceId).findById(aiTask, task.id))
      .callbackPayload as Callback | null
  /**
   * 记录当前尝试的失败并切到下一候选；不可切换（无候选、分类不可切换或距硬超时不足 20 分钟）时抛出原错误。
   * 是否切换在持久步骤内判断，重放时沿用首次结果。返回 false 表示任务已终止。
   */
  const failOver = async (failure: { kind: FailureKind; code: string }, error: unknown) => {
    const result = await step.do(
      `failover-a${attempt}`,
      async (): Promise<
        { status: 'switched'; task: string } | { status: 'exhausted' | 'stopped' }
      > => {
        if (!(await active())) return { status: 'stopped' }
        const switched = await switchMediaTaskAttempt(deps.db, task, {
          attempt,
          failure,
          now: now(),
        })
        return switched.status === 'switched'
          ? { status: 'switched', task: JSON.stringify(switched.task) }
          : switched
      },
    )
    if (!('task' in result)) {
      if (result.status === 'stopped') return false
      throw error
    }
    current = JSON.parse(result.task) as AiTask
    attempt = mediaAttemptIndex(current)
    return true
  }
  // 配置了备用的任务进入切换步骤（记录本次失败，并在步骤内判断能否切换）；没有备用的任务步骤与升级前一致。
  const hasChain = () => readMediaFailover(current) !== undefined
  try {
    fault = readMediaFault(task)
    if (fault && !faultEnabled)
      throw new AppError('ACCEPTANCE_FAULT_DISABLED', 'Acceptance fault execution is disabled')
    providerAccessAllowed = true
    // 持久步骤可能直接返回缓存，外围自检也必须执行，避免晚到重放继续业务步骤。
    if (!(await active())) return stopped()
    while (true) {
      const af = attemptFault()
      let original: TaskMediaProvider
      try {
        original = deps.provider(current)
      } catch (error) {
        // 尚未提交的尝试遇到服务商停用或缺凭据：按 unavailable 切换。
        if (
          providerUnavailable(error) &&
          !current.providerJobId &&
          !current.output?.submissionAttempted &&
          nextMediaCandidate(current) !== undefined
        ) {
          if (!(await failOver({ kind: 'unavailable', code: (error as AppError).code }, error)))
            return stopped()
          continue
        }
        throw error
      }
      const provider = af ? wrapMediaFaultProvider(original, af, { proof, now }) : original
      if (af?.mode === 'workers-timeout') {
        await step.do('fault-stalled', async () => {
          if (!(await active())) return null
          await scoped(deps.db, task.workspaceId).update(
            aiTask,
            { status: 'running', startedAt: new Date(now()) },
            and(eq(aiTask.id, task.id), eq(aiTask.status, 'queued')),
          )
          await proof({
            injected: true,
            injectedAt: new Date(now()).toISOString(),
            realProviderCalled: false,
          })
          return null
        })
        if (!(await active())) return stopped()
        await step.sleep('fault-stalled-deadline', Math.max(1, deadline - now()))
        if (!(await active())) return stopped()
        throw new AppError('ACCEPTANCE_FAULT_INVALID', 'Stalled task has not reached its deadline')
      }
      if (isSyncMediaProvider(provider)) {
        const target = current
        const fileIds = await step.do(
          named('submit'),
          { retries: SYNC_SUBMIT_RETRIES, timeoutMs: 900_000 },
          async () => {
            try {
              return (await active()) ? await submitSynchronousMedia(target, deps, provider) : []
            } catch (error) {
              throw syncSubmitFailure(taskId, error)
            }
          },
        )
        if (!(await active())) return stopped()
        const status = await step.do(named('settle-and-notify'), async () => {
          if (!(await active())) return currentStatus
          const fresh = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
          const stored = fresh.output as { result?: MediaResult; files?: MediaTaskFile[] } | null
          if (!stored?.result || !stored.files || !fileIds.length)
            throw new AppError('INVALID_MEDIA_RESULT', 'Synchronous task has no persisted result')
          return (
            await settleMediaTask(deps.db, {
              workspaceId: task.workspaceId,
              taskId,
              outcome: 'succeeded',
              result: stored.result,
              files: stored.files,
            })
          ).status
        })
        return { taskId, status }
      }
      const target = current
      const submitted = await step.do(
        named('submit'),
        { retries: { limit: 3, delayMs: 10_000, backoff: 'exponential' }, timeoutMs: 120_000 },
        async () => {
          if (!(await active())) return { jobId: '', sync: null, stopped: true }
          return submitMediaOnce(target, af ? { ...deps, provider: () => provider } : deps, {
            canFailover: (kind) => canSwitchMediaAttempt(target, kind, now()),
          })
        },
      )
      if (submitted.stopped) {
        await stopIfTerminal()
        return stopped()
      }
      if (submitted.failover) {
        const { kind, code, message } = submitted.failover
        if (!(await failOver({ kind, code }, new AppError(code, message)))) return stopped()
        continue
      }
      if (!(await active())) return stopped()
      let jobId = submitted.jobId
      if (submitted.uncertain) {
        // 等待时限为运行时设置；验收故障沿用其初始等待，且都不超过任务期限。
        const waitUntil = await step.do(named('uncertain-wait-until'), async () => {
          const seconds = af
            ? af.initialWaitMs / 1000
            : await getSetting({ store: dbSettingStore(deps.db) }, 'ai.mediaUncertainWaitSeconds')
          return Math.min(deadline, now() + Math.max(0, seconds) * 1000)
        })
        // 回调路由已验签并写入作业 ID；这里只补写先于标记到达的回调并清除标记。
        const adopt = async () => {
          if (!(await active())) return null
          if (attemptFaultFails()) return null
          const fresh = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
          const callback = fresh.callbackPayload as Callback | null
          if (!callback?.jobId) return null
          await scoped(deps.db, task.workspaceId).update(
            aiTask,
            {
              providerJobId: callback.jobId,
              providerAttempts: attemptsWithJobId(fresh, callback.jobId),
              errorCode: null,
              errorMessage: null,
            },
            and(
              eq(aiTask.id, task.id),
              eq(aiTask.status, 'running'),
              eq(aiTask.errorCode, UNCERTAIN),
            ),
          )
          return callback.jobId
        }
        let adopted = await step.do(named('uncertain-check-callback'), adopt)
        if (!adopted && now() < waitUntil) {
          await step
            .waitForEvent(named('wait-uncertain-callback'), {
              type: MEDIA_DONE_EVENT,
              timeoutMs: Math.max(1, waitUntil - now()),
            })
            .catch(() => null)
          if (!(await active())) return stopped()
          adopted = await step.do(named('uncertain-recheck-callback'), adopt)
        }
        if (!(await active())) return stopped()
        // 不确定的提交不切换：服务商可能已受理，切换会重复生成（D5）。
        if (!adopted)
          throw new AppError(UNCERTAIN, 'Submission outcome is uncertain; credits were returned')
        jobId = adopted
      }
      if (af?.mode === 'fal-callback-early') {
        const barrierMs = af.barrierMs
        const barrierDeadline = await step.do('fault-early-barrier-deadline', async () =>
          Math.min(deadline, now() + barrierMs),
        )
        let barrier = 0
        while (true) {
          if (!(await active())) return stopped()
          const observed = await step.do(`fault-early-barrier-${barrier}`, async () => {
            if (!(await active())) return false
            const callback = await readCallback()
            if (!callback?.result && !callback?.error) return false
            await proof({ injected: true, injectedAt: new Date(now()).toISOString() })
            return true
          })
          if (observed) break
          if (now() >= barrierDeadline)
            throw new AppError(
              'MEDIA_CALLBACK_EARLY_NOT_OBSERVED',
              'Early callback was not observed',
            )
          await step.sleep(
            `fault-early-barrier-delay-${barrier}`,
            Math.min(2_000, barrierDeadline - now()),
          )
          barrier++
        }
      }
      const checkCallback = async () => {
        if (!(await active())) return null
        if (af) await proof({ callbackCheckedAt: new Date(now()).toISOString() })
        // 丢失模式必须轮询恢复；失败注入也不能被迟到成功回调抢先恢复。
        return attemptFaultFails() || af?.mode === 'fal-callback-lost' ? null : readCallback()
      }
      let callback: Callback | null = submitted.sync
        ? { jobId, result: submitted.sync }
        : await step.do(named('check-callback'), checkCallback)
      if (!callback?.result && !callback?.error) {
        if (!(await active())) return stopped()
        if (!callback)
          await step
            .waitForEvent(named('wait-media-done'), {
              type: MEDIA_DONE_EVENT,
              timeoutMs: Math.max(1, Math.min(af?.initialWaitMs ?? 15 * 60_000, deadline - now())),
            })
            .catch(() => null)
        if (!(await active())) return stopped()
        callback = await step.do(named('recheck-callback'), checkCallback)
      }
      let poll = 0
      let delay = 30_000
      while (!callback?.result && !callback?.error) {
        if (!(await active())) return stopped()
        const status = await step.do(
          named(`poll-${poll}`),
          async (): Promise<StepData<MediaStatus> | { status: 'stopped' }> => {
            if (!(await active())) return { status: 'stopped' } as const
            if (af) {
              const fresh = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
              const previous = fresh.input?.acceptanceFaultProof as
                | { pollCount?: number }
                | undefined
              await proof({ pollCount: (previous?.pollCount ?? 0) + 1 })
            }
            return provider.getStatus(jobId)
          },
        )
        if (status.status === 'stopped') return stopped()
        if (status.status === 'succeeded') callback = { jobId, result: status.result }
        else if (status.status === 'failed') callback = { jobId, error: status.error }
        else {
          if (!(await active())) return stopped()
          const remaining = deadline - now()
          if (remaining <= 0) throw new AppError('MEDIA_TIMEOUT', 'Media generation timed out')
          await step.sleep(named(`poll-delay-${poll}`), Math.min(delay, remaining))
          delay = Math.min(delay * 2, 5 * 60_000)
          poll++
        }
      }
      if (!(await active())) return stopped()
      if (callback.error) {
        const error = new AppError(callback.error.code, callback.error.message)
        // 未标分类的作业失败按 provider_error（D3）；内容审核与参数问题不切换。
        const kind = callback.error.kind ?? 'provider_error'
        if (!hasChain()) throw error
        if (!(await failOver({ kind, code: callback.error.code }, error))) return stopped()
        continue
      }
      const result = callback.result as MediaResult
      const files = await step.do(
        named('persist'),
        { retries: { limit: 3, delayMs: 10_000, backoff: 'exponential' }, timeoutMs: 900_000 },
        async () => {
          if (!(await active())) return null
          const files = await deps.persist(target, result)
          // 转存后、结算前中断时，回收器可据已持久化结果补结算。
          await scoped(deps.db, task.workspaceId).update(
            aiTask,
            { output: { files, result, usage: result.usage ?? null } },
            and(eq(aiTask.id, task.id), inArray(aiTask.status, ['queued', 'running'])),
          )
          return files
        },
      )
      if (!files) return stopped()
      if (!(await active())) return stopped()
      // 切换不改变结算：按任务创建时主模型的定价快照与 unitsLimit（D4）。
      const status = await step.do(named('settle-and-notify'), async () => {
        if (!(await active())) return currentStatus
        return (
          await settleMediaTask(deps.db, {
            workspaceId: task.workspaceId,
            taskId,
            outcome: 'succeeded',
            result,
            files,
          })
        ).status
      })
      return { taskId, status }
    }
  } catch (error) {
    observer.captureException(error)
    if (await stopIfTerminal()) return stopped()
    const status = await step.do('fail-and-notify', async () => {
      if (await stopIfTerminal()) return currentStatus
      return (
        await settleMediaTask(deps.db, {
          workspaceId: task.workspaceId,
          taskId,
          outcome: 'failed',
          error: errorOf(error),
        })
      ).status
    })
    await stopIfTerminal()
    return { taskId, status }
  }
}
