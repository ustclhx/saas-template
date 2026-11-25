// jobs 侧插件扩展点（openspec add-plugin-system 决策 5）。插件 jobs / jobsNode 入口的 default 导出符合下面的接口，
// 由 scripts/plugins/generate.mjs 生成的 plugins*.gen.ts 汇总；Cloudflare 入口的具名导出（Workflow 类）由
// index.ts 原样导出。核心只从生成文件读取，不直接导入插件。Node 入口的约定见 node/plugins.ts。

import type { HoldSweepHandler, registerHoldSweeper } from '@saas/billing'
import type { TemplateConfig } from '@saas/config'
import type { QueueBatch } from '@saas/platform'
import type { BulkJobOutcome, BulkJobSafety } from '@saas/shared/bulk-job'
import type { JobsContext } from '../handlers.ts'

/**
 * 插件定时任务挂在已有触发器上（不新增 wrangler cron）：heartbeat 每 5 分钟，ten-minute 每 10 分钟，
 * daily 每天；与同组核心任务并行执行，任一失败都让本次触发记为失败。
 */
export type PluginCronGroup = 'heartbeat' | 'ten-minute' | 'daily'

export interface PluginCronTask {
  readonly id: string
  readonly group: PluginCronGroup
  /**
   * 必填（openspec add-ops-safeguards）：会删除数据、销毁积分、调用外部写或批量发送时声明每轮上限、
   * 处理顺序与时间防护，并在 docs/bulk-jobs.md 登记；否则写 `{ kind: 'none', reason }`。
   */
  readonly safety: BulkJobSafety
  /** 返回 `{ guard }` 时由 jobs 记录到达上限与防护告警（见 @saas/shared/bulk-job） */
  // biome-ignore lint/suspicious/noConfusingVoidType: 不涉及防护结果的任务沿用无返回值写法。
  run(context: JobsContext, scheduledAt: Date): Promise<void | { guard?: BulkJobOutcome }>
}

/**
 * 队列消费者：name 为基础队列名。Cloudflare 按 `name`、`name-staging`、`name-production` 匹配
 * （与 email / events 相同的命名约定），Node 以 `name` 注册到持久队列。
 */
export interface PluginQueueHandler {
  readonly name: string
  handle(batch: QueueBatch<unknown>, context: JobsContext): Promise<void>
}

/** 积分预扣清理器：按预扣来源登记，到期预扣由 runHoldSweep 交给它结算 */
export interface PluginHoldSweeper {
  readonly refType: Parameters<typeof registerHoldSweeper>[0]
  create(template: TemplateConfig): HoldSweepHandler | undefined
}

/** 两目标共用的部分 */
export interface JobsPluginModule {
  readonly crons?: readonly PluginCronTask[]
  readonly queues?: readonly PluginQueueHandler[]
  readonly holdSweepers?: readonly PluginHoldSweeper[]
}
