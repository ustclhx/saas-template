import type { TemplateConfig } from '@saas/config'
import { agentTurnHoldSweeper } from '../core/sweeper.ts'

// agents 插件的 jobs 入口（openspec add-ai-agents 任务 4.4）：只注册 `agent_turn` 预扣清理器，复用现有
// 清理 Cron，不新增定时任务，也不持有 Durable Object 绑定（决策 12）。
// 只有 default 导出：jobs Worker 会原样导出入口的具名导出（用于 Workflow 类）
const holdSweepers = [
  {
    refType: 'agent_turn',
    create(template: TemplateConfig) {
      if (!template.plugins.agents) return undefined
      return agentTurnHoldSweeper({
        overage: template.billing.overage,
        failedReplyRefund: template.ai.text.failedReplyRefund,
      })
    },
  },
] as const

export default { holdSweepers }
