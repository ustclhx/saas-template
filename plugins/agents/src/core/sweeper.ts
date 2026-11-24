import type { CreditsTransaction, OveragePolicy } from '@saas/credits'
import { release } from '@saas/credits'
import { aiAgentTurn, type CreditHold, type Database, scoped } from '@saas/db'
import { log } from '@saas/shared/log'
import { eq } from 'drizzle-orm'
import { type FailedReplyRefund, settleTurnFromCheckpoint } from './turn.ts'

/**
 * `agent_turn` 预扣的超时兜底（openspec add-ai-agents 决策 3、5，任务 4.4），由插件 jobs 入口注册到
 * 现有清理 Cron。只访问 PG，不访问 Durable Object（jobs 不持有该绑定，决策 12）：在 hold sweep 的事务中
 * 读取 turn 的定价快照与检查点，按已记录用量结算并标记 expired（等待确认超时也走这里）。
 * 实例下次唤醒时发现开放轮次已是终态，清除开放轮次并把等待确认中的调用标记过期（见 src/worker/agent.ts）。
 * 找不到 turn 行时释放预扣。
 */
export function agentTurnHoldSweeper(options: {
  overage: OveragePolicy
  failedReplyRefund: FailedReplyRefund
}) {
  return async ({
    db,
    tx,
    hold,
  }: {
    db: Database
    tx: CreditsTransaction
    hold: CreditHold
  }): Promise<void> => {
    const [turn] = await scoped(tx, hold.workspaceId)
      .select(aiAgentTurn, { where: eq(aiAgentTurn.holdId, hold.id) })
      .limit(1)
    if (turn?.status !== 'running') {
      await release(tx, { workspaceId: hold.workspaceId, holdId: hold.id }, tx)
      return
    }
    const snapshot = (turn.usageCheckpoint as { failedReplyRefund?: FailedReplyRefund } | null)
      ?.failedReplyRefund
    await settleTurnFromCheckpoint(
      db,
      { ...turn, holdId: hold.id },
      {
        status: 'expired',
        overage: options.overage,
        failedReplyRefund: snapshot ?? options.failedReplyRefund,
        errorCode: 'HOLD_EXPIRED',
      },
      tx,
    )
    log.warn('agents.turn.expired', {
      workspaceId: hold.workspaceId,
      conversationId: turn.conversationId,
      turnId: turn.id,
      steps: turn.steps,
    })
  }
}
