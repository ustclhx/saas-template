import type { DeletionContext, DeletionKind, DeletionStep, DeletionTransaction } from '@saas/auth'
import { log } from '@saas/shared/log'
import { type AgentInstanceCleaner, purgeAgentInstances } from './lifecycle.ts'

// 删号 / 删空间时清理 agent 对话（openspec add-ai-agents 决策 7，任务 7.2；spec account-deletion）。
// 在删除事务中删除轮次与对话行（ai_agent_turn → ai_conversation 为 restrict 外键，先删轮次），
// 事务提交后逐个清理实例。实例清理失败不影响删除结果：PG 行已不存在，实例 alarm 到期时自清理；
// 重复执行只会删除仍存在的行，幂等。积分预扣与流水只以 ref_id 指向轮次，按财务记录保留；
// 仍为 held 的预扣由 agentTurnHoldSweeper 发现轮次不存在后释放。

/**
 * 在删除事务中删除范围内的 agent 轮次与对话行，返回被删除的对话 id。
 * 删号：该用户在所有空间中的 agent 对话（对话只对创建者可见）；删空间：该空间的全部 agent 对话。
 */
export async function deleteAgentConversationRows(
  sql: DeletionTransaction,
  scope: { readonly userId: string } | { readonly workspaceIds: readonly string[] },
): Promise<string[]> {
  const filter =
    'userId' in scope
      ? sql`user_id=${scope.userId}`
      : scope.workspaceIds.length > 0
        ? sql`workspace_id in ${sql(scope.workspaceIds)}`
        : undefined
  if (!filter) return []
  const conversations = await sql<{ id: string }[]>`
    select id from ai_conversation where kind='agent' and ${filter} order by id for update`
  const ids = conversations.map((row) => row.id)
  if (ids.length === 0) return []
  await sql`delete from ai_agent_turn where conversation_id in ${sql(ids)}`
  await sql`delete from ai_conversation where id in ${sql(ids)}`
  return ids
}

export function createAgentDeletionStep(
  kind: DeletionKind,
  cleaner: () => AgentInstanceCleaner | undefined,
): DeletionStep {
  // 同一次删除的 execute 与 after 收到同一个 context 对象；按它传递待清理的实例，不放模块级状态
  const pending = new WeakMap<DeletionContext, string[]>()
  return {
    async execute(context, sql) {
      const ids = await deleteAgentConversationRows(
        sql,
        kind === 'account'
          ? { userId: context.actorUserId }
          : { workspaceIds: context.workspaceIds },
      )
      pending.set(context, ids)
    },
    async after(context) {
      const ids = pending.get(context) ?? []
      pending.delete(context)
      if (ids.length === 0) return
      const { purged, failed } = await purgeAgentInstances(cleaner(), ids)
      log.info('agents.deletion.instances_purged', {
        kind,
        purged: purged.length,
        failed: failed.length,
      })
    },
  }
}
