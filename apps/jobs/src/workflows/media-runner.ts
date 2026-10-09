import type { WorkflowStep } from 'cloudflare:workers'
import {
  type MediaError,
  type MediaProvider,
  type MediaResult,
  mediaCallbackUrl,
  readMediaTaskInput,
  settleMediaTask,
} from '@saas/ai'
import { type AiTask, aiTask, type Database, scoped } from '@saas/db'
import { AppError, MEDIA_DONE_EVENT } from '@saas/shared'
import { log } from '@saas/shared/log'
import { and, eq, inArray, sql } from 'drizzle-orm'

export interface MediaRunnerDeps {
  db: Database
  provider(task: AiTask): MediaProvider
  params(task: AiTask): Promise<Record<string, unknown>>
  callbackOrigin: string
  callbackSecret: string
  persist(
    task: AiTask,
    result: MediaResult,
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
  nonRetryable(message: string): Error
  now?: () => number
}
type Callback = { jobId: string; result?: MediaResult; error?: MediaError }
const terminal = (task: AiTask) => ['succeeded', 'failed', 'canceled'].includes(task.status)
const errorOf = (error: unknown): MediaError => ({
  code:
    error instanceof AppError
      ? error.code
      : error instanceof Error && error.message === 'MEDIA_SUBMISSION_UNCERTAIN'
        ? 'MEDIA_SUBMISSION_UNCERTAIN'
        : 'MEDIA_GENERATION_FAILED',
  message:
    error instanceof AppError
      ? error.message
      : error instanceof Error && error.message === 'MEDIA_SUBMISSION_UNCERTAIN'
        ? 'Submission outcome is uncertain; credits were returned'
        : 'Media generation failed',
})

/** 无幂等能力时，进程在受理/落库间崩溃后也不能再次提交。 */
export async function submitMediaOnce(task: AiTask, deps: MediaRunnerDeps) {
  const { db } = deps
  if (!deps.callbackSecret)
    throw new AppError('MEDIA_WEBHOOK_NOT_CONFIGURED', 'Media callback is not configured', {
      status: 503,
    })
  const provider = deps.provider(task)
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
    if (current.output?.submissionAttempted && !provider.capabilities.idempotentSubmit)
      throw deps.nonRetryable('MEDIA_SUBMISSION_UNCERTAIN')
    await tenant.updateById(aiTask, task.id, { output: { submissionAttempted: true } })
    return current
  })
  if (terminal(fresh)) return { jobId: '', sync: null, stopped: true }
  if (fresh.providerJobId)
    return {
      jobId: fresh.providerJobId,
      sync: (fresh.callbackPayload as Callback | null)?.result ?? null,
      stopped: false,
    }
  const params = await deps.params(task)
  const webhookUrl = await mediaCallbackUrl(
    readMediaTaskInput(task).callbackOrigin ?? deps.callbackOrigin,
    deps.callbackSecret,
    task,
  )
  try {
    const result = await provider.submit({
      modelId: readMediaTaskInput(task).providerModelId,
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
            errorMessage: 'Credits returned; external cancellation needs retry',
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
    if (rejected) {
      await scoped(db, task.workspaceId).update(
        aiTask,
        { output: null },
        and(eq(aiTask.id, task.id), eq(aiTask.status, 'queued')),
      )
      throw error
    }
    if (!provider.capabilities.idempotentSubmit)
      throw deps.nonRetryable('MEDIA_SUBMISSION_UNCERTAIN')
    throw error
  }
}

/** 事件只唤醒，结果始终以先落库的 callback 为准；每次轮询使用独立持久步骤。 */
export async function runMediaTask(taskId: string, step: WorkflowStep, deps: MediaRunnerDeps) {
  const snapshot = await step.do('load-task', async () => {
    // 内部 Workflow taskId 用于定位租户，之后业务查询一律 scoped。
    // biome-ignore lint/plugin: 内部绑定创建的 taskId 用于定位租户，后续读写均 scoped。
    const task = await deps.db.query.aiTask.findFirst({ where: eq(aiTask.id, taskId) })
    if (!task) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    return JSON.stringify(task)
  })
  const task = JSON.parse(snapshot) as AiTask
  const now = deps.now ?? Date.now
  const deadline = new Date(task.deadlineAt).getTime()
  const active = async () => {
    const fresh = await scoped(deps.db, task.workspaceId).findById(aiTask, task.id)
    if (terminal(fresh)) return false
    if (now() >= deadline) throw new AppError('MEDIA_TIMEOUT', 'Media generation timed out')
    return true
  }
  const readCallback = async (): Promise<Callback | null> =>
    (await scoped(deps.db, task.workspaceId).findById(aiTask, task.id))
      .callbackPayload as Callback | null
  try {
    const submitted = await step.do(
      'submit',
      { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      async () => {
        if (!(await active())) return { jobId: '', sync: null, stopped: true }
        return submitMediaOnce(task, deps)
      },
    )
    if (submitted.stopped) return { taskId, status: 'canceled' }
    let callback: Callback | null = submitted.sync
      ? { jobId: submitted.jobId, result: submitted.sync }
      : await step.do('check-callback', readCallback)
    if (!callback?.result && !callback?.error) {
      if (!callback)
        await step
          .waitForEvent('wait-media-done', {
            type: MEDIA_DONE_EVENT,
            timeout: Math.max(1, Math.min(15 * 60_000, deadline - now())),
          })
          .catch(() => null)
      callback = await step.do('recheck-callback', readCallback)
    }
    let poll = 0
    let delay = 30_000
    while (!callback?.result && !callback?.error) {
      const status = await step.do(`poll-${poll}`, async () => {
        if (!(await active())) return { status: 'stopped' } as const
        return deps.provider(task).getStatus(submitted.jobId)
      })
      if (status.status === 'stopped') return { taskId, status: 'canceled' }
      if (status.status === 'succeeded')
        callback = { jobId: submitted.jobId, result: status.result }
      else if (status.status === 'failed')
        callback = { jobId: submitted.jobId, error: status.error }
      else {
        const remaining = deadline - now()
        if (remaining <= 0) throw new AppError('MEDIA_TIMEOUT', 'Media generation timed out')
        await step.sleep(`poll-delay-${poll}`, Math.min(delay, remaining))
        delay = Math.min(delay * 2, 5 * 60_000)
        poll++
      }
    }
    if (callback.error) throw new AppError(callback.error.code, callback.error.message)
    const result = callback.result as MediaResult
    const files = await step.do(
      'persist',
      { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
      async () => {
        if (!(await active())) return null
        const files = await deps.persist(task, result)
        // 转存后、结算前中断时，回收器可据已持久化结果补结算。
        await scoped(deps.db, task.workspaceId).update(
          aiTask,
          { output: { files, result, usage: result.usage ?? null } },
          and(eq(aiTask.id, task.id), inArray(aiTask.status, ['queued', 'running'])),
        )
        return files
      },
    )
    if (!files) return { taskId, status: 'canceled' }
    const status = await step.do('settle-and-notify', async () => {
      if (!(await active())) return 'canceled'
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
  } catch (error) {
    const status = await step.do(
      'fail-and-notify',
      async () =>
        (
          await settleMediaTask(deps.db, {
            workspaceId: task.workspaceId,
            taskId,
            outcome: 'failed',
            error: errorOf(error),
          })
        ).status,
    )
    return { taskId, status }
  }
}
