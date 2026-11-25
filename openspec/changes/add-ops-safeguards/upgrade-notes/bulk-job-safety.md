# 升级说明草稿：定时删除与群发防护（第 1 组）

发版时由协调者并入 `docs/upgrades/<版本>.md`。

## 必须执行

- **插件 cron 新增必填 `safety` 字段**（`apps/jobs/src/plugins/module.ts` 的 `PluginCronTask`）。
  衍生项目自有插件声明了 `crons` 时，typecheck 会失败，按下列方式补齐：
  - 只读或只写自身状态：`safety: { kind: 'none', reason: '<为什么不涉及删除或发送>' }`；
  - 会删除数据、销毁积分、调用外部写或批量发送：
    `safety: { kind: 'delete' | 'destroy-credit' | 'external-write' | 'send', cap, capUnit, order, timeGuard }`，
    在 `docs/bulk-jobs.md` 登记表加一行，并让 `run` 返回 `{ guard }`（`@saas/shared/bulk-job` 的
    `checkBulkJobTime` / `bulkJobOutcome`），由 jobs 记录 `job.cap_reached` 并发送防护告警。
  模板内置插件都没有 `crons`，不受影响。
- 衍生项目自行新增的删除 / 群发任务同样需要登记，否则 `apps/jobs/test/bulk-jobs.guard.unit.test.ts` 失败。

## 行为变化

- 以下任务改为每轮有上限，超出部分留到下一轮（最早到期先处理）：文件清理（500 个对象 / 20 个空间）、
  删号凭据清单（200）、个人空间分享卡（20 个空间）、过期空间清理（20 个空间）、积分过期（200 个空间）、
  预扣结算（500）、PayPal 到期取消（50 次）、退款联系邮箱清理（500）。积压只会延迟删除。
- 删除类任务以数据库时钟为基准；应用与数据库时钟偏差超过 5 分钟、截止时间或保留期异常时整轮不执行；
  时间列早于 `2024-01-01T00:00:00Z`（或在未来）的行不再被删除，只计数告警，需要人工处理。
- 新增运维通知事件 `ops.bulk_job.guard_tripped`（Telegram / Discord），同一任务同一原因每个 UTC 日最多一条。
- 对账失败告警改为每轮最多 10 条明细 + 1 条汇总，sourceId 为 `reconciliation:<UTC 日>:<序号>`，当天重跑不重复发送。
- agents 保留期（`retentionDays`）检查改用数据库时钟；时间异常时不删除，6 小时后重查。

## 上线后观察

staging 观察一周：jobs 日志中的 `job.cap_reached`、`job.guard_tripped` 与运维通知渠道（tasks 6.1）。
