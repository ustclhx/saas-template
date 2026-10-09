import {
  type CreditsExecutor,
  type CreditsTransaction,
  capture,
  lockWorkspaceCredits,
  release,
  withCreditsTransaction,
} from '@saas/credits'
import { type AiTask, aiTask, file, notFound, notification, organization, scoped } from '@saas/db'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { actualCredits, PricingError, parsePricing } from '../pricing.ts'
import type { MediaTaskInput } from './input.ts'
import type { MediaError, MediaResult } from './provider.ts'

export const MEDIA_TASK_TTL_MS = 2 * 60 * 60 * 1000

export interface MediaTaskFile {
  id: string
  mime: string
  size: number
  width?: number | null
  height?: number | null
  duration?: number | null
}

/** 只读取提交时的快照，服务商用量不能突破请求参数决定的上限。 */
export function mediaTaskCredits(
  task: Pick<AiTask, 'id' | 'workspaceId' | 'kind' | 'pricing' | 'input'>,
  result: MediaResult,
): number {
  const pricing = parsePricing(task.pricing, task.kind)
  const input = task.input as unknown as MediaTaskInput
  if (pricing.mode === 'token') {
    throw new PricingError('INVALID_PRICING', 'Media tasks cannot use token pricing')
  }
  if (pricing.mode === 'per_call') return actualCredits(pricing, { params: input.params })
  const limit = input.unitsLimit
  // 未单独回报用量时，只从实际产出计数或时长推导，不能把请求上限或推理耗时当作实际用量。
  const durations = result.outputs.map((output) => output.durationSec)
  const reported =
    pricing.unit === 'image'
      ? (result.usage?.images ?? result.outputs.length)
      : (result.usage?.seconds ??
        (durations.length > 0 && durations.every((duration) => duration !== undefined)
          ? durations.reduce<number>((total, duration) => total + (duration ?? 0), 0)
          : undefined))
  if (reported === undefined) {
    throw new AppError('MEDIA_USAGE_MISSING', 'Provider did not report video duration')
  }
  if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(reported) || reported < 0) {
    throw new PricingError('INVALID_USAGE', 'Media units and limit must be non-negative numbers')
  }
  if (reported > limit) {
    log.warn('ai.media.usage_exceeds_limit', {
      taskId: task.id,
      workspaceId: task.workspaceId,
      unit: pricing.unit,
      reportedUnits: reported,
      unitsLimit: limit,
    })
  }
  return actualCredits(pricing, { params: input.params, units: Math.min(reported, limit) })
}

export function loadMediaTask(
  db: CreditsExecutor,
  input: { workspaceId: string; taskId: string },
): Promise<AiTask> {
  return scoped(db, input.workspaceId).findById(aiTask, input.taskId)
}

export interface SettleMediaTaskInput {
  workspaceId: string
  taskId: string
  outcome: 'succeeded' | 'failed' | 'canceled'
  result?: MediaResult
  files?: MediaTaskFile[]
  error?: MediaError
}

/**
 * 统一锁顺序：credits → ws → task；转存持有 ws → task 且不操作积分，避免与回收器反序死锁。
 * 终态是结算与通知的幂等门；状态、账本、通知及失败产出的软删除在同一事务提交。
 */
export function settleMediaTask(
  db: CreditsExecutor,
  input: SettleMediaTaskInput,
  tx?: CreditsTransaction,
): Promise<AiTask> {
  return withCreditsTransaction(db, tx, async (tx) => {
    await lockWorkspaceCredits(tx, input.workspaceId)
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`ws:${input.workspaceId}`}, 0))`,
    )
    const tenant = scoped(tx, input.workspaceId)
    const [task] = await tenant.select(aiTask, { where: eq(aiTask.id, input.taskId) }).for('update')
    if (!task) throw notFound()
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'canceled') {
      return task
    }

    const success = input.outcome === 'succeeded'
    if (success && (!input.result || !input.files)) {
      throw new AppError(
        'INVALID_MEDIA_RESULT',
        'Successful task requires persisted files and result',
      )
    }
    const charged = success && input.result ? mediaTaskCredits(task, input.result) : 0
    if (task.holdId) {
      const reservation = { workspaceId: input.workspaceId, holdId: task.holdId }
      if (success) await capture(tx, { ...reservation, actualAmount: charged }, tx)
      else await release(tx, reservation, tx)
    } else if (charged > 0) {
      throw new AppError('MEDIA_HOLD_MISSING', 'Paid media task has no reservation', {
        status: 500,
      })
    }
    if (!success) {
      await tenant.update(
        file,
        { deletedAt: sql`now()`, publicToken: null, updatedAt: sql`now()` },
        and(eq(file.sourceTaskId, task.id), isNull(file.deletedAt)),
      )
    }
    const settled = await tenant.updateById(aiTask, task.id, {
      status: input.outcome,
      creditsCharged: charged,
      output: success
        ? { files: input.files, usage: input.result?.usage ?? null, result: input.result }
        : input.outcome === 'canceled' && task.output?.submissionAttempted
          ? { submissionAttempted: true }
          : null,
      errorCode: success ? null : (input.error?.code ?? null),
      errorMessage: success ? null : (input.error?.message ?? null),
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    if (input.outcome !== 'canceled') {
      const [workspace] = await tx
        .select({ slug: organization.slug })
        .from(organization)
        .where(eq(organization.id, input.workspaceId))
      if (!workspace) throw notFound()
      await tenant.insert(notification, {
        userId: task.userId,
        type: `ai_task.${input.outcome}`,
        title: success ? 'Media generation completed' : 'Media generation failed',
        body: success ? null : (input.error?.message ?? null),
        link: `/app/${encodeURIComponent(workspace.slug)}/tasks/${task.id}`,
      })
    }
    return settled
  })
}
