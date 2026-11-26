# 定时删除与群发任务登记表

会删除数据、销毁积分、调用外部平台写操作或批量对外发送的后台任务都登记在这里
（openspec `add-ops-safeguards`，能力 `bulk-job-safety`）。守卫测试
`apps/jobs/test/bulk-jobs.guard.unit.test.ts` 从实际注册的任务枚举，与下方「登记表」双向核对：
任务 ID、每轮上限与代码位置不一致，或新增任务没有登记时 `pnpm test` 失败。

## 规则

- **声明**：核心任务的防护写在 `apps/jobs/src/bulk-job-registry.ts`，计费子任务写在
  `apps/jobs/src/billing.ts` 的 `BILLING_JOBS`，插件 cron 写在 `PluginCronTask.safety`（必填）。
  只读或只写入自身状态的任务声明 `{ kind: 'none', reason }`，不进登记表。
- **每轮上限**：代码常量，不做运行时设置。超出部分留到下一轮，并记录 `job.cap_reached` 警告日志。
- **顺序**：候选按到期时间（或进入待处理状态的时间）升序，同一时间再按 ID，积压时不饿死最早的记录。
- **整轮时间防护**（`@saas/shared/bulk-job` 的 `checkBulkJobTime`）：删除类任务以数据库时钟为基准，
  应用时钟只作对照；两者相差超过 5 分钟，或截止时间无效、早于下限 `2024-01-01T00:00:00Z`、
  晚于基准、换算出的保留期低于该任务的最小保留期时，本轮不执行。
- **行时间防护**：候选只取时间列在「下限 … 基准时间」之间的行；区间外的行不处理，只计数告警。
- **告警**：防护触发时记录 `job.guard_tripped` 错误日志，并经运维通知发送
  `ops.bulk_job.guard_tripped`。sourceId 为 `bulk_job:<任务>:<原因>:<UTC 日>`，同一任务同一原因每天最多一条；
  载荷只含任务标识、原因与计数，不含用户数据。
- **新增任务**：在对应声明处写明上限、顺序与时间防护，在下表加一行；不经 cron 的删除入口
  （Durable Object alarm、手动运维入口等）同时加入 `NON_CRON_BULK_JOBS`。

## 登记表

「每轮上限」列以数字开头，守卫测试据此与代码常量核对。触发列中「心跳组」默认 `*/5`，
staging / production 的 `CRON_PROFILE=reduced` 合并为 `*/30`；「十分钟组」默认 `*/10`，reduced 下同样并入 `*/30`。

| 任务 | 触发 | 动作 | 每轮上限 | 时间防护 | 代码位置 |
|---|---|---|---|---|---|
| `deletion-cleanup` | 心跳组 | 删除过期的删号凭据清单，重试未过期清单对应的 KV 键删除 | 200 个清单（过期删除与重试合计） | 数据库时钟基准、偏差 ≤5 分钟；`expires_at` 早于下限的清单保留并告警 | `packages/auth/src/deletion.ts` |
| `files-cleanup` | 十分钟组 | 删除 R2 对象与 `file` 行：未确认上传、过期空间文件、废弃或已删除的 AI 产出 | 500 个对象，且 ≤20 个空间（先到为准） | 未确认上传保留 1 小时（最小 10 分钟）、空间保留 30 天（最小 1 天）；仍关联作品的文件暂缓，创建 / 删除时间早于下限或废弃时间在未来的不删除并告警 | `packages/storage/src/cleanup.ts` |
| `personal-share-cards-cleanup` | 每日 03:00 | 删号后个人空间的分享卡 R2 list + delete | 20 个空间 | 无保留期；偏差 ≤5 分钟；`deleted_at` 不在下限与基准之间的空间不处理并告警 | `packages/auth/src/ai-content-cleanup.ts` |
| `workspace-cleanup` | 每日 03:00 | 过期空间的分享卡、消息、轮次、对话、媒体任务（各类每批 ≤500 行、≤200 批）、通知与邀请；作品及举报按每批 ≤500 个待删媒体任务的输出清理 | 20 个空间 | 截止 = 数据库时钟 − 30 天（最小 1 天）；偏差 ≤5 分钟；`deleted_at` 早于下限的空间不清理并告警 | `packages/auth/src/workspace-lifecycle.ts` |
| `deleted-user-ai-cleanup` | 每日 03:00 | 已删号用户在团队空间中的消息、轮次、对话和媒体任务；清理每批 ≤500 个待删媒体任务的输出对应的作品，另按作品 ID 清理 ≤500 条由该用户发布的作品，举报随作品删除 | 200 批（消息、轮次、对话、媒体任务各每批 ≤500 行） | 按身份删除无截止时间；偏差 ≤5 分钟；一天内仍在生成的行以数据库时钟跳过 | `packages/auth/src/ai-content-cleanup.ts` |
| `admin-confirmations-cleanup` | 每日 03:00 | 到期的待确认记录（admin MCP 发起）置为过期并清空密文，删除 30 天前结束的终态记录 | 500 条待确认记录（两步合计） | 截止 = 数据库时钟 − 30 天（最小 1 天）；偏差 ≤5 分钟；结束时间早于下限的记录不删除并告警 | `packages/db/src/admin-pending-actions.ts` |
| `credit_expiration` | 每小时 | 积分批次置过期并记账 | 200 个空间 | 偏差 ≤5 分钟；`expires_at` 早于下限的批次不过期并告警 | `packages/billing/src/cron.ts` |
| `hold_sweep` | 十分钟组 | 超时预扣交给登记的结算器 | 500 条预扣 | 偏差 ≤5 分钟；`expires_at` 早于下限的预扣不结算并告警 | `packages/billing/src/cron.ts` |
| `compensation` | 十分钟组 | 调支付平台取消订阅 / 退款 | 25 个补偿任务 | 只领取 `created_at` 在下限与数据库当前时间之间的任务；区间外保留并告警；租约沿用应用时钟围栏 | `packages/billing/src/compensation.ts` |
| `refund_notifications` | 十分钟组 | 退款结果邮件入队 | 100 封邮件 | 只发送 `updated_at` 在下限与数据库当前时间之间的申请；区间外保留并告警；按审计标记去重 | `packages/billing/src/notifications.ts` |
| `subscription_reconciliation` | 每日 04:00 | PayPal 到期订阅调平台取消（同步本身不限） | 50 次外部取消 | 偏差超过 5 分钟时只同步不取消；`current_period_end` 早于下限的订阅不取消并告警 | `packages/billing/src/cron.ts` |
| `credit_reconciliation` | 每日 04:00 | 对账失败的运维告警（与 `subscription_reconciliation` 共用） | 10 条明细告警，其余合并为 1 条汇总 | sourceId 为 `reconciliation:<UTC 日>:<序号>` 与 `…:summary`，当天重跑不重复发送 | `apps/jobs/src/billing.ts` |
| `refund_contact_cleanup` | 每日 04:00 | 清空已结束退款申请的联系邮箱（PII） | 500 条联系邮箱 | 截止 = 数据库时钟 − 30 天（最小 1 天）；完成时间早于下限的行不清空并告警 | `packages/billing/src/cron.ts` |
| `agents-retention` | Durable Object alarm（web，每个 agent 对话实例） | 超过保留期的 agent 对话归档并 `destroy()` 实例存储 | 1 个会话（每次 alarm） | `retentionDays` 最小 1 天；数据库时钟基准、偏差 ≤5 分钟；`updatedAt` 早于下限或在未来的不删除，6 小时后重查并告警 | `plugins/agents/src/core/lifecycle.ts` |
| `node-queue-cleanup` | **未调度**（Node 运维入口占位） | 删除终态队列批次、消息、死信与 workflow 事件 | 1000 个终态批次（workflow 事件清理另限 1000 个 workflow） | 保留期 ≥1 小时（参数校验）；`finished_at` 早于下限的批次不删除；接入调度时补整轮防护 | `packages/platform/src/node/job-maintenance.ts` |

## 不在守卫范围的删除

| 项目 | 现状 | 位置 |
|---|---|---|
| 自托管备份保留 | WAL-G 删除旧备份，参数有界并有独立的证明链；不纳入本守卫，规则见 [备份保留 runbook](runbooks/selfhost-backup-retention.md) | `deploy/selfhost/backup/retention.py` |
| 邮件队列消费者 | 每批 10 条，由平台投递控制 | `apps/jobs/src/queues/email.ts` |
| 运维事件队列 | 已按渠道去重 | `apps/jobs/src/notifications/operations.ts` |
| 按请求触发的惰性删除 | 由用户操作触发，不是批量任务 | — |

newsletter 目前只有导出，没有群发任务；将来新增群发必须在上表登记。

## 平台限制（核对日期 2026-11-25）

- Workers 每次调用的子请求上限：Free 50、Paid 10,000；另有「Subrequests to internal services」一行，
  Free 1,000、Paid 与已配置上限一致（默认 10,000）。原文：「A subrequest is any request a Worker makes using the
  Fetch API or to Cloudflare services like R2, KV, or D1.」每次调用最多 6 个连接同时等待响应头，
  R2 的 `get` / `put` / `delete` 等计入。Cron Trigger 每次调用最长 15 分钟。
  出处：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。
- R2 `delete()` 单次最多 1000 个键：「Up to 1000 keys may be deleted per call.」
  出处：[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。

文件清理逐个删除对象，每轮 500 个对象即 ≤500 个 R2 子请求，与同一触发器上的计费任务合计仍低于 Paid 的 10,000；
Free 计划的 internal services 上限为 1,000，同样不超出。上限不因此调整。
