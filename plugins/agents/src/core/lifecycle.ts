import { aiAgentTurn, aiConversation, type Database, scoped } from '@saas/db'
import { AppError } from '@saas/shared'
import { log } from '@saas/shared/log'
import { and, eq, lt, notExists, type SQL } from 'drizzle-orm'

// agent 对话的删除、自清理与保留期（openspec add-ai-agents 决策 7，任务 7.1–7.3），与 Agents SDK 无关。
// 清理与枚举以 PG 对话表为唯一依据；实例清理经 AgentInstanceCleaner（web 内的 Durable Object 绑定）
// 发起，失败不回滚 PG：实例自己的 alarm 发现对话已不存在时自清理。

const DAY_MS = 86_400_000
/** 空闲检查的最长间隔：未开启保留期时每个实例最多每 30 天查一次 PG（Neon 成本基线） */
export const LIFECYCLE_CHECK_MAX_DAYS = 30
/** 超出保留期但仍有 running 轮次时，下次检查的间隔 */
export const RUNNING_TURN_RECHECK_MS = 3_600_000
/** alarm 最短间隔，避免时钟误差造成连续唤醒 */
const MIN_RECHECK_MS = 60_000

/** 实例清理：清空对话实例的全部存储（Durable Object 中用 alarm 执行 destroy，见 worker/agent.ts） */
export type AgentInstanceCleaner = (conversationId: string) => Promise<void>

/**
 * 下次空闲检查时间 = 最近活动 + min(retentionDays, 30) 天；已过去时从现在起算。
 * 开启保留期时不晚于保留期到期时刻，到期后的第一次检查即可删除。
 */
export function nextLifecycleCheck(input: {
  now: Date
  lastActivity: Date
  retentionDays?: number | undefined
}): Date {
  const now = input.now.getTime()
  const last = input.lastActivity.getTime()
  const window = Math.min(input.retentionDays ?? LIFECYCLE_CHECK_MAX_DAYS, LIFECYCLE_CHECK_MAX_DAYS)
  let at = last + window * DAY_MS
  if (at <= now) at = now + window * DAY_MS
  if (input.retentionDays !== undefined) {
    const due = last + input.retentionDays * DAY_MS
    if (due > now) at = Math.min(at, due)
  }
  return new Date(Math.max(at, now + MIN_RECHECK_MS))
}

export type LifecycleReview =
  /** PG 中对话不存在或已删除（归档）：清空实例 */
  | { readonly action: 'purge'; readonly reason: 'missing' | 'archived' }
  /** 超出保留期，已按用户删除对话的语义删除 PG 行：清空实例 */
  | { readonly action: 'expired' }
  | { readonly action: 'reschedule'; readonly at: Date; readonly reason: 'active' | 'running' }

/**
 * 实例 alarm 到期时的检查（7.2 自清理兜底、7.3 保留期）。未设置 `retentionDays` 时只检查对话是否存在；
 * 开启后超期且没有 running 轮次的对话在同一条语句中被删除（`archived = true`，与 7.1 一致），
 * 有 running 轮次时跳过并在稍后重查。
 */
export async function reviewAgentConversation(
  db: Database,
  input: {
    workspaceId: string
    conversationId: string
    retentionDays?: number | undefined
    now?: Date | undefined
  },
): Promise<LifecycleReview> {
  const now = input.now ?? new Date()
  const tenant = scoped(db, input.workspaceId)
  const own = and(
    eq(aiConversation.id, input.conversationId),
    eq(aiConversation.kind, 'agent'),
  ) as SQL
  const [row] = await tenant
    .select(aiConversation, {
      where: own,
      fields: { archived: aiConversation.archived, updatedAt: aiConversation.updatedAt },
    })
    .limit(1)
  if (!row) return { action: 'purge', reason: 'missing' }
  if (row.archived) return { action: 'purge', reason: 'archived' }
  const { retentionDays } = input
  if (retentionDays !== undefined) {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS)
    if (row.updatedAt < cutoff) {
      const expired = await tenant
        .update(
          aiConversation,
          { archived: true },
          and(
            own,
            eq(aiConversation.archived, false),
            lt(aiConversation.updatedAt, cutoff),
            notExists(
              db
                .select({ id: aiAgentTurn.id })
                .from(aiAgentTurn)
                .where(
                  and(
                    eq(aiAgentTurn.conversationId, input.conversationId),
                    eq(aiAgentTurn.status, 'running'),
                  ),
                ),
            ),
          ) as SQL,
        )
        .returning({ id: aiConversation.id })
      if (expired.length > 0) return { action: 'expired' }
      return {
        action: 'reschedule',
        at: new Date(now.getTime() + RUNNING_TURN_RECHECK_MS),
        reason: 'running',
      }
    }
  }
  return {
    action: 'reschedule',
    at: nextLifecycleCheck({ now, lastActivity: row.updatedAt, retentionDays }),
    reason: 'active',
  }
}

/** 逐个清理实例；单个失败只记日志，不阻塞其余对话（由实例 alarm 兜底） */
export async function purgeAgentInstances(
  cleaner: AgentInstanceCleaner | undefined,
  conversationIds: readonly string[],
): Promise<{ purged: string[]; failed: string[] }> {
  const purged: string[] = []
  const failed: string[] = []
  if (!cleaner) return { purged, failed: [...conversationIds] }
  for (const conversationId of conversationIds) {
    try {
      await cleaner(conversationId)
      purged.push(conversationId)
    } catch (error) {
      failed.push(conversationId)
      log.warn('agents.instance.purge_failed', {
        conversationId,
        errorName: error instanceof Error ? error.name : typeof error,
      })
    }
  }
  return { purged, failed }
}

/**
 * 用户删除对话（7.1）：沿用文本对话的删除语义（`archived = true` 软删），只删除本人的未删除 agent 对话；
 * 之后前置处理与实例都视同不存在（404 并自清理）。PG 写入后再清理实例，实例失败不回滚 PG。
 */
export async function deleteOwnAgentConversation(
  db: Database,
  input: { workspaceId: string; userId: string; conversationId: string },
  cleaner: AgentInstanceCleaner | undefined,
): Promise<{ id: string; instancePurged: boolean }> {
  const rows = await scoped(db, input.workspaceId)
    .update(
      aiConversation,
      { archived: true },
      and(
        eq(aiConversation.id, input.conversationId),
        eq(aiConversation.userId, input.userId),
        eq(aiConversation.kind, 'agent'),
        eq(aiConversation.archived, false),
      ) as SQL,
    )
    .returning({ id: aiConversation.id })
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Not found', { status: 404 })
  const { failed } = await purgeAgentInstances(cleaner, [input.conversationId])
  return { id: input.conversationId, instancePurged: failed.length === 0 }
}
