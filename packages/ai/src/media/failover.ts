import { type CreditsExecutor, withCreditsTransaction } from '@saas/credits'
import { type AiProviderAttemptJson, type AiTask, aiTask, scoped } from '@saas/db'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { canFailover, FAILURE_KINDS, type FailureKind } from '../failover/failure.ts'
import { readMediaTaskInput } from './input.ts'

/**
 * 媒体任务的服务商切换（add-media-provider-fallback 决策 D4、D5）。
 *
 * - `ai_task.provider_attempts` 只记录真正执行的尝试，最后一项即当前尝试，其下标就是回调地址里的尝试序号；
 *   升级前创建的任务没有尝试记录，视为只有序号 0（由 `provider` 与 `input.providerModelId` 描述）。
 * - `input.failover` 在受理时冻结可用候选（按备用顺序、已按 paramMap 改名并通过各自 schema 校验的参数）
 *   与受理时就被跳过的候选；`input.params` / `unitsLimit` 始终是主模型的，供结算使用。
 */

/** 距硬超时不足此时长时不再切换：新作业来不及完成，只会多花费服务商成本。 */
export const MEDIA_FAILOVER_MIN_REMAINING_MS = 20 * 60_000

/** 「提交确认中」标记，与 media-runner 的 UNCERTAIN 相同。 */
const MEDIA_SUBMISSION_UNCERTAIN = 'MEDIA_SUBMISSION_UNCERTAIN'

const candidateSchema = z.object({
  modelKey: z.string().min(1),
  provider: z.string().min(1),
  providerModelId: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  fileParams: z.array(z.string().min(1)),
})
export type MediaFailoverCandidate = z.infer<typeof candidateSchema>

const failureSchema = z.object({ kind: z.enum(FAILURE_KINDS), code: z.string() })
/** 尝试失败的记录：分类与错误码，不含上游正文。 */
export interface MediaAttemptFailure {
  kind: FailureKind
  code: string
}

const snapshotSchema = z.object({
  candidates: z.array(candidateSchema).min(1),
  skipped: z
    .array(
      z.object({
        modelKey: z.string().min(1),
        provider: z.string().min(1),
        failure: failureSchema,
      }),
    )
    .default([]),
})
export type MediaFailoverSnapshot = z.infer<typeof snapshotSchema>

type AttemptTask = Pick<AiTask, 'input' | 'provider' | 'modelKey' | 'providerAttempts'>

/** 读取冻结的候选；没有备用的任务返回 undefined。 */
export function readMediaFailover(task: Pick<AiTask, 'input'>): MediaFailoverSnapshot | undefined {
  if (task.input.failover === undefined) return undefined
  const parsed = snapshotSchema.safeParse(task.input.failover)
  if (!parsed.success)
    throw new AppError('MEDIA_INPUT_INVALID', 'Invalid media failover snapshot', { status: 500 })
  return parsed.data
}

const attemptsOf = (task: Pick<AiTask, 'providerAttempts'>): AiProviderAttemptJson[] =>
  Array.isArray(task.providerAttempts) ? task.providerAttempts : []

/** 当前尝试的序号（回调地址与步骤名使用）。 */
export function mediaAttemptIndex(task: Pick<AiTask, 'providerAttempts'>): number {
  return Math.max(0, attemptsOf(task).length - 1)
}

/** 指定序号的尝试；旧任务只有序号 0。 */
export function mediaAttemptAt(
  task: AttemptTask,
  attempt: number,
): Pick<AiProviderAttemptJson, 'provider' | 'providerModelId' | 'modelKey'> | undefined {
  const attempts = attemptsOf(task)
  if (attempts.length === 0)
    return attempt === 0
      ? {
          provider: task.provider,
          providerModelId: readMediaTaskInput(task).providerModelId,
          modelKey: task.modelKey,
        }
      : undefined
  return attempts[attempt]
}

/** 当前尝试实际提交的模型与参数；没有候选快照时即主模型的参数。 */
export function mediaAttemptRequest(task: AttemptTask): {
  providerModelId: string
  params: Record<string, unknown>
  fileParams: string[]
} {
  const input = readMediaTaskInput(task)
  const modelKey = attemptsOf(task).at(-1)?.modelKey ?? task.modelKey
  const candidate = readMediaFailover(task)?.candidates.find((item) => item.modelKey === modelKey)
  return candidate
    ? {
        providerModelId: candidate.providerModelId,
        params: candidate.params,
        fileParams: candidate.fileParams,
      }
    : { providerModelId: input.providerModelId, params: input.params, fileParams: input.fileParams }
}

/** 尚未尝试过的下一个候选；服务商互不相同，按 modelKey 判断即可。 */
export function nextMediaCandidate(task: AttemptTask): MediaFailoverCandidate | undefined {
  const attempts = attemptsOf(task)
  const used = new Set(attempts.length ? attempts.map(({ modelKey }) => modelKey) : [task.modelKey])
  return readMediaFailover(task)?.candidates.find(({ modelKey }) => !used.has(modelKey))
}

/** 每次尝试使用新的服务商请求键：序号 0 保持原值，之后为 `<原值>:a<n>`。 */
export function mediaAttemptRequestKey(requestKey: string, attempt: number): string {
  const base = requestKey.replace(/:a\d+$/, '')
  return attempt === 0 ? base : `${base}:a${attempt}`
}

/** 失败可切换、还有候选且距硬超时至少 20 分钟。 */
export function canSwitchMediaAttempt(
  task: AttemptTask & Pick<AiTask, 'deadlineAt'>,
  kind: FailureKind,
  now: number,
): boolean {
  return (
    canFailover(kind) &&
    nextMediaCandidate(task) !== undefined &&
    new Date(task.deadlineAt).getTime() - now >= MEDIA_FAILOVER_MIN_REMAINING_MS
  )
}

/** 作业 ID 写入当前尝试；旧任务没有尝试记录时保持为空。 */
export function attemptsWithJobId(
  task: Pick<AiTask, 'providerAttempts'>,
  jobId: string,
): AiProviderAttemptJson[] {
  const attempts = attemptsOf(task)
  return attempts.map((attempt, index) =>
    index === attempts.length - 1 ? { ...attempt, jobId } : attempt,
  )
}

export type MediaSwitchResult =
  | { status: 'switched'; task: AiTask }
  | { status: 'exhausted' }
  /** 上报的失败与数据库中的尝试状态不一致（如 unavailable 但该尝试已提交），拒绝切换。 */
  | { status: 'refused' }
  | { status: 'stopped' }

const terminal = (task: AiTask) => ['succeeded', 'failed', 'canceled'].includes(task.status)

/**
 * 在空间 → 任务锁内把序号 `attempt` 的失败记入尝试记录，并按条件切到下一候选：
 * 当前服务商、作业 ID、请求键、回调与提交标记都换成新尝试；定价快照、预扣与 `input.params` 不变。
 * 步骤重放时（当前序号已大于 `attempt`）直接返回已切换的任务，不重复切换。
 */
export function switchMediaTaskAttempt(
  db: CreditsExecutor,
  target: Pick<AiTask, 'workspaceId' | 'id'>,
  input: { attempt: number; failure: MediaAttemptFailure; now: number },
): Promise<MediaSwitchResult> {
  return withCreditsTransaction(db, undefined, async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${target.workspaceId}`}, 0))`,
    )
    const tenant = scoped(tx, target.workspaceId)
    const [task] = await tenant.select(aiTask, { where: eq(aiTask.id, target.id) }).for('update')
    if (!task) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
    if (terminal(task)) return { status: 'stopped' }
    const current = mediaAttemptIndex(task)
    if (current > input.attempt) return { status: 'switched', task }
    // 「服务商不可用」只适用于从未提交的尝试：已有作业、已尝试提交或提交确认中时，原作业可能仍在生成，
    // 切换会重复生成；由调用方按原错误失败。
    if (
      input.failure.kind === 'unavailable' &&
      (task.providerJobId ||
        task.output?.submissionAttempted ||
        task.errorCode === MEDIA_SUBMISSION_UNCERTAIN)
    ) {
      log.warn('ai.media.failover_refused', {
        taskId: task.id,
        attempt: current,
        kind: input.failure.kind,
      })
      return { status: 'refused' }
    }
    const at = new Date(input.now).toISOString()
    const attempts = attemptsOf(task).length
      ? attemptsOf(task)
      : [
          {
            provider: task.provider,
            modelKey: task.modelKey,
            providerModelId: readMediaTaskInput(task).providerModelId,
            ...(task.providerJobId ? { jobId: task.providerJobId } : {}),
            at: task.createdAt.toISOString(),
          },
        ]
    const failed = attempts.map((attempt, index) =>
      index === current && !attempt.failure ? { ...attempt, failure: input.failure } : attempt,
    )
    const next = nextMediaCandidate(task)
    if (!next || !canSwitchMediaAttempt(task, input.failure.kind, input.now)) {
      await tenant.updateById(aiTask, task.id, { providerAttempts: failed })
      return { status: 'exhausted' }
    }
    const nextAttempt = failed.length
    const switched = await tenant.updateById(aiTask, task.id, {
      provider: next.provider,
      providerJobId: null,
      providerRequestKey: mediaAttemptRequestKey(task.providerRequestKey, nextAttempt),
      providerAttempts: [
        ...failed,
        {
          provider: next.provider,
          modelKey: next.modelKey,
          providerModelId: next.providerModelId,
          at,
        },
      ],
      input: { ...task.input, providerModelId: next.providerModelId },
      callbackPayload: null,
      output: null,
      errorCode: null,
      errorMessage: null,
    })
    // 只记录服务商、模型与失败分类，不含参数与提示词。
    log.info('ai.media.failover', {
      taskId: task.id,
      from: `${task.provider}:${attempts[current]?.modelKey ?? task.modelKey}`,
      to: `${next.provider}:${next.modelKey}`,
      kind: input.failure.kind,
    })
    return { status: 'switched', task: switched }
  })
}
