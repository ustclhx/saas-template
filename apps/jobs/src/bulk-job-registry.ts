// 核心定时任务的防护声明（openspec add-ops-safeguards D1）。纯数据模块：handlers.ts 按这里的
// 任务组成执行，test/bulk-jobs.guard.test.ts 从这里、BILLING_JOBS 与插件 crons 枚举全部任务，
// 与 docs/bulk-jobs.md 双向核对，并核对上限与各 package 中的常量一致。
// 上限写成数字而不是从 package 导入：单元测试会整体 mock 这些 package。

import type { BulkJobSafety } from '@saas/shared/bulk-job'

const SKEW = '数据库时钟为基准、应用时钟偏差 ≤5 分钟'

export interface BulkJobDescriptor {
  readonly id: string
  readonly safety: BulkJobSafety
}

export const CORE_JOBS = {
  'deletion-cleanup': {
    id: 'deletion-cleanup',
    safety: {
      kind: 'delete',
      cap: 200,
      capUnit: '个清单（过期删除与 KV 重试合计）',
      order: 'expires_at 升序，再按 ID',
      timeGuard: `${SKEW}；expires_at 早于下限的清单不删除并告警`,
    },
  },
  heartbeat: {
    id: 'heartbeat',
    safety: { kind: 'none', reason: '只写入最近一次运行时间' },
  },
  billing: {
    id: 'billing',
    safety: {
      kind: 'none',
      reason: '只分派计费子任务；子任务逐个登记在 billing.ts 的 BILLING_JOBS',
    },
  },
  'files-cleanup': {
    id: 'files-cleanup',
    safety: {
      kind: 'delete',
      cap: 500,
      capUnit: '个对象（且 ≤20 个空间，先到为准）',
      order: '空间按最早到期文件升序，再按空间 ID；空间内按时间升序',
      timeGuard: `${SKEW}；未确认上传保留 ≥10 分钟、空间保留 ≥1 天；行时间早于下限或废弃时间在未来的不删除并告警`,
    },
  },
  'workspace-maintenance': {
    id: 'workspace-maintenance',
    safety: {
      kind: 'none',
      reason: '依次运行三个空间清理子任务，各子任务独立声明防护并独立失败',
    },
    children: [
      {
        id: 'personal-share-cards-cleanup',
        safety: {
          kind: 'delete',
          cap: 20,
          capUnit: '个空间',
          order: 'deleted_at 升序，再按 ID',
          timeGuard: `${SKEW}；删号即清理无保留期；deleted_at 不在下限与基准之间的空间不处理并告警`,
        },
      },
      {
        id: 'workspace-cleanup',
        safety: {
          kind: 'delete',
          cap: 20,
          capUnit: '个空间（AI 内容另限 500 行 × 200 批）',
          order: 'deleted_at 升序，再按 ID',
          timeGuard: `截止时间 = 数据库时钟 − 30 天（最小保留期 1 天），${SKEW}；deleted_at 早于下限的空间不清理并告警`,
        },
      },
      {
        id: 'deleted-user-ai-cleanup',
        safety: {
          kind: 'delete',
          cap: 200,
          capUnit: '批（每批 ≤500 行）',
          order: '用户 ID 升序',
          timeGuard: `按身份删除无截止时间；${SKEW}；一天内仍在生成的行以数据库时钟跳过`,
        },
      },
    ],
  },
  'admin-confirmations-cleanup': {
    id: 'admin-confirmations-cleanup',
    safety: {
      kind: 'delete',
      cap: 500,
      capUnit: '条待确认记录（到期置为过期与删除终态记录合计）',
      order: '到期记录按 expires_at 升序，终态记录按结束时间升序，再按 ID',
      timeGuard: `截止时间 = 数据库时钟 − 30 天（最小保留期 1 天），${SKEW}；结束时间早于下限的记录不删除并告警`,
    },
  },
  'metrics-daily': {
    id: 'metrics-daily',
    safety: { kind: 'none', reason: '只汇总前一日指标并覆盖写 metrics_daily' },
  },
} as const satisfies Record<string, BulkJobDescriptor & { children?: readonly BulkJobDescriptor[] }>

export type CoreJobId = keyof typeof CORE_JOBS

/** 核心任务组：键为任务组 cron（与 CRON_TASK_GROUPS 的值对应），值为组内任务 */
export const CORE_TASK_GROUP_JOBS: Readonly<Record<string, readonly CoreJobId[]>> = {
  '*/5 * * * *': ['deletion-cleanup', 'heartbeat'],
  '*/10 * * * *': ['billing', 'files-cleanup'],
  '0 3 * * *': ['workspace-maintenance', 'admin-confirmations-cleanup', 'metrics-daily'],
  '0 * * * *': ['billing'],
  '0 4 * * *': ['billing'],
}

/**
 * 不经 cron 的删除入口（D1 第 4 条）：新增这类入口时同时更新此列表与 docs/bulk-jobs.md，
 * 守卫测试核对两者一致，并核对上限与对应 package 的常量。
 */
export const NON_CRON_BULK_JOBS: readonly (BulkJobDescriptor & { readonly trigger: string })[] = [
  {
    id: 'agents-retention',
    trigger: 'Durable Object alarm（web，每个对话实例）',
    safety: {
      kind: 'delete',
      cap: 1,
      capUnit: '个会话（每次 alarm）',
      order: '各实例自己的 alarm',
      timeGuard: `retentionDays ≥1 天；${SKEW}；updatedAt 早于下限或在未来的会话不删除并记错误`,
    },
  },
  {
    id: 'node-queue-cleanup',
    trigger: '未调度（Node 运维入口占位）',
    safety: {
      kind: 'delete',
      cap: 1000,
      capUnit: '个终态批次（接入调度时生效）',
      order: 'finished_at 升序',
      timeGuard: '保留期 ≥1 小时（参数校验）；finished_at 早于下限的批次不删除',
    },
  },
]
