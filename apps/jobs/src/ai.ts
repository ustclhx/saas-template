// AI 对话预扣的超时兜底（design 决策 7）：模块加载时向 hold sweep 注册 `ai_message` 处理器，
// BILLING_RETRY_CRON 中的 runHoldSweep 据此结算超过 10 分钟未结算的对话预扣。
import { chatHoldSweeper, mediaTaskHoldSweeper } from '@saas/ai'
import { registerHoldSweeper } from '@saas/billing'
import templateConfig from '../../../template.config.ts'

export const unregisterChatHoldSweeper = registerHoldSweeper(
  'ai_message',
  chatHoldSweeper({ overage: templateConfig.billing.overage }),
)

export const unregisterMediaTaskHoldSweeper = registerHoldSweeper('ai_task', mediaTaskHoldSweeper())
