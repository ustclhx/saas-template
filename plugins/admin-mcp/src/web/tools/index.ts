import { businessTools } from './business.ts'
import { confirmationsGet } from './confirmations.ts'
import { creditsAdjust } from './credits.ts'
import { modelTools } from './models.ts'
import { pingTool } from './ping.ts'
import { refundsReview } from './refunds.ts'
import { settingTools } from './settings.ts'

/** MCP 暴露的全部工具；后台确认执行按记录中的工具名在这里查找执行器 */
export const adminTools = [
  pingTool,
  ...settingTools,
  ...modelTools,
  ...businessTools,
  creditsAdjust,
  refundsReview,
  confirmationsGet,
] as const
