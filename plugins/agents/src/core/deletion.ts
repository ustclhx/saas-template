import {
  type DeletionContext,
  type DeletionStep,
  type DeletionTransaction,
  registerDeletionStep,
} from '@saas/auth'
import { log } from '@saas/shared/log'
import { type AgentInstanceCleaner, purgeAgentInstances } from './lifecycle.ts'

// 删号时清理 agent 对话（openspec add-ai-agents 决策 7，任务 7.2；spec account-deletion）。
// 删号不等保留期（与 packages/auth 的 ai-content-cleanup 规则一致）：在删除事务中删除该用户在所有空间
// （个人空间与团队空间）的 agent 轮次与对话行（ai_agent_turn → ai_conversation 为 restrict 外键，先删轮次），
// 事务提交后逐个清理实例。实例清理失败不影响删除结果：PG 行已不存在，实例 alarm 到期时自清理；
// 重复执行只会删除仍存在的行，幂等。积分预扣与流水只以 ref_id 指向轮次，按财务记录保留；
// 仍为 held 的预扣由 agentTurnHoldSweeper 发现轮次不存在后释放。
//
// 删团队空间不注册步骤：空间软删、保留期内可恢复（WORKSPACE_RETENTION_DAYS），与文本对话一致。
// 软删期间前置处理按成员资格拒绝访问；保留期满由 jobs 的过期空间清理（purgeAiBatch）先删轮次再删对话，
// 实例在下一次 alarm 检查（≤ 30 天）时发现对话不存在并自清理。

/**
 * 在删号事务中删除该用户在所有空间中的 agent 轮次与对话行（对话只对创建者可见），返回被删除的对话 id。
 */
export async function deleteUserAgentConversationRows(
  sql: DeletionTransaction,
  userId: string,
): Promise<string[]> {
  const conversations = await sql<{ id: string }[]>`
    select id from ai_conversation where kind='agent' and user_id=${userId} order by id for update`
  const ids = conversations.map((row) => row.id)
  if (ids.length === 0) return []
  await sql`delete from ai_agent_turn where conversation_id in ${sql(ids)}`
  await sql`delete from ai_conversation where id in ${sql(ids)}`
  return ids
}

/** Worker 启动时调用：只注册删号步骤（删团队空间按保留期处理，见文件头） */
export function registerAgentDeletionSteps(
  cleaner: () => AgentInstanceCleaner | undefined,
): () => void {
  return registerDeletionStep('account', createAgentAccountDeletionStep(cleaner))
}

export function createAgentAccountDeletionStep(
  cleaner: () => AgentInstanceCleaner | undefined,
): DeletionStep {
  // 同一次删除的 execute 与 after 收到同一个 context 对象；按它传递待清理的实例，不放模块级状态
  const pending = new WeakMap<DeletionContext, string[]>()
  return {
    async execute(context, sql) {
      pending.set(context, await deleteUserAgentConversationRows(sql, context.actorUserId))
    },
    async after(context) {
      const ids = pending.get(context) ?? []
      pending.delete(context)
      if (ids.length === 0) return
      const { purged, failed } = await purgeAgentInstances(cleaner(), ids)
      log.info('agents.deletion.instances_purged', {
        purged: purged.length,
        failed: failed.length,
      })
    },
  }
}
