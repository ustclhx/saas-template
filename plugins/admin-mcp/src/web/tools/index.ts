import { adminMcpToolPlugins } from '@web/plugins.admin-mcp.gen.ts'
import { businessTools } from './business.ts'
import { confirmationsGet } from './confirmations.ts'
import { creditsAdjust } from './credits.ts'
import { defineAdminTool } from './define.ts'
import { modelTools } from './models.ts'
import { pingTool } from './ping.ts'
import { refundsReview } from './refunds.ts'
import { settingTools } from './settings.ts'

const builtInTools = [
  pingTool,
  ...settingTools,
  ...modelTools,
  ...businessTools,
  creditsAdjust,
  refundsReview,
  confirmationsGet,
] as const

/** 分发与后台确认执行共用此登记表。插件名称由生成器校验。 */
export const adminTools = [
  ...builtInTools,
  ...adminMcpToolPlugins.flatMap((tools) =>
    Object.entries(tools()).map(([name, factory]) =>
      factory((definition) => defineAdminTool({ ...definition, name })),
    ),
  ),
]
