import { z } from 'zod'

// `plugins.agents` 配置段（openspec add-ai-agents 任务 2.3）。清单与运行时共用，只依赖 zod，
// 便于生成器以 Node 去类型方式直接加载。

const AGENT_ID = /^[a-z][a-z0-9-]*$/

export const agentsConfigSchema = z
  .object({
    /** 每轮最多步数（模型调用次数）；预扣额 = 单步预算 × maxSteps */
    maxSteps: z.number().int().min(1).max(50).default(8),
    /** 单轮预扣封顶（积分）；不设置时只按单步预算 × maxSteps 预扣 */
    maxTurnCredits: z.number().int().positive().optional(),
    /** 每个对话实例保留的消息条数上限（AIChatAgent.maxPersistedMessages） */
    maxPersistedMessages: z.number().int().min(1).default(200),
    /** 对话保留期（天）；不设置即关闭，开启后由各对话实例的 alarm 删除超期无活动的对话（不新增 Cron） */
    retentionDays: z.number().int().positive().optional(),
    /** 新建对话的默认 agent id（agents.project.ts 中定义） */
    defaultAgent: z
      .string()
      .regex(AGENT_ID, 'must be a lowercase kebab-case agent id')
      .default('assistant'),
  })
  .strict()

export type AgentsConfig = z.output<typeof agentsConfigSchema>
