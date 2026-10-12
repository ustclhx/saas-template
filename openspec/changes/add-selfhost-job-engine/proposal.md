# Proposal

## Why

可选的 Docker Compose 自托管目标需要在 Node jobs 中运行与现有 Cloudflare 业务一致的后台任务，并支撑每日新加坡时间 02:00 启动、持续 1–2 小时的采集流水线。Postgres 任务引擎必须证明事务入队、双实例调度与重启恢复语义，才能避免丢任务、重复外部调用和重复结算。

## What Changes

- 采用两个阶段：先用 2–3 个 worker 工作日比较 **DBOS Transact** 与 **pg-boss + 自研 Postgres 持久 step 引擎**，再依据证据实施。当前暂推荐 DBOS，以减少自研工作流状态机；这不是最终选型或实测结论。
- 新增 Node 队列实现：Q1 至少一次投递、按队列重试/退避、死信记录、批量消费；Q2 同一业务事务入队或等价 outbox，回滚不发出任务；Q3 按队列控制消费并发及速率。
- 新增 Node 调度实现：J1 jobs 内 cron 与 IANA 时区（含 Asia/Singapore）；J2 双 jobs 实例不并发重复执行同一定时任务，停机补跑可配置为跳过或补跑一次；J3 保留 heartbeat 与健康检查的最近运行时间。
- 新增 Node 持久工作流实现：W1 步骤结果、步骤重试、sleep、带超时 waitForEvent、不可重试错误、外部 sendEvent；W2 重启从最后成功步骤恢复；W3 早到事件至少保留 60 分钟。
- 通过 change A `add-selfhost-foundation` 定义的 `packages/platform` queue/workflow/scheduler 接口提供实现，迁移 email/events、现有五条 Cron 与 AiMediaWorkflow 到 Node，保持业务幂等、回调落库与结算行为。
- Phase 1 仅提交隔离 spike 的证据与选型建议，原型和独立依赖不进入合并；Phase 2 等协调者确认后实施，未实际完成的实现和部署验收保持未完成。

## Capabilities

### New Capabilities

- `job-queues`：Postgres 支撑的自托管队列、事务投递、重试死信、批量消费与队列级流控（Q1–Q3）。
- `job-scheduling`：自托管 jobs 的时区调度、双实例互斥与停机补跑（J1–J3），沿用既有 `system-health` 心跳契约。
- `durable-workflows`：自托管持久步骤、等待与事件、崩溃恢复及现有媒体工作流的行为一致性（W1–W3）。

### Modified Capabilities

无。`user-auth` 的认证邮件异步发送、`system-health` 的 `jobs.lastCronAt` 和 `runtime-config` 的配置校验契约继续适用；本 change 不重新定义这些已有要求。A 负责跨平台接口与其 Cloudflare 包装；本 change 的新增规格限定 Node 目标。

## Impact

后续实施涉及 `packages/platform` 的 Node 实现、`apps/jobs` 的 Node 入口及消费者/定时任务/workflow、web 的任务生产与事件通知、`packages/db` 的引擎/outbox schema 与迁移接入，以及 `packages/config` 的任务参数校验。最终依赖和 schema 由 spike 决定，DDL 仅由 migrator 执行，worker 遵守并行计划，不自行提交迁移 SQL。

依赖 A 提供 Node 生命周期、数据库连接池与平台接口，并与 A 对齐事务能力、队列 ack/retry、workflow create/get/status/sendEvent、step 配置和 scheduler 的时区/补跑参数。本 change 不修改 Cloudflare 实现、现有 CI/staging 发布，不涵盖缓存、对象存储、镜像/Compose、备份或运营平台安装；Docker Compose 为新增可选目标，Dokploy 为推荐的运维方式而非运行依赖。

验收覆盖自托管需求第 6 节的第 4、5、6 项：时区与双实例调度、重试死信与回滚不执行、重启断点恢复，分别在本地 Docker 和新加坡 Linux 服务器执行。提案 PR 只包含本 change 目录。
