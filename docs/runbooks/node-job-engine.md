# Node 任务引擎运维

本 runbook 对应 DBOS SDK **5.2.11**（MIT）及 `job_engine` 自有事务消息 inbox。精确版本锁定于 `packages/platform/package.json` 与 lockfile；生产不使用范围版本自动升级。Cloudflare 队列不受本 runbook 影响。

## 初始化与迁移

使用一次性 migrator 进程，顺序是：版本控制的业务迁移 → `DBOS.migrate` 公共 API 与权限 → app/jobs 启动。运行时 `runMigrations: false`，app 只有必要 DML 权限，不能授予 CREATE/ALTER 解决启动失败。

1. 协调者在 main 统一生成业务迁移：`pnpm --filter @saas/db exec drizzle-kit generate --name node_job_engine`。该命令读取 `src/schema/index.ts`，覆盖 `job_engine` pgSchema；本地已确认生成该 namespace 的 5 张表。审阅 SQL 与 metadata，再在隔离数据库验收；worker 不提交迁移。
2. 配置该环境的 `MIGRATION_DATABASE_URL`（migrator 凭据）后，运行 `pnpm --filter @saas/db db:migrate`。不要把连接串粘贴到终端命令或报告。
3. 在仓库根执行公共迁移入口：`node --experimental-strip-types packages/platform/src/node/job-engine-migrate.ts`。它调用 `DBOS.migrate`；`DBOS_APPLICATION_ROLE` 默认 `app`，按需配置 `DBOS_READONLY_ROLE=readonly`。该进程使用 migrator URL，只输出固定结构化事件。
4. 业务/schema 与 native schema 均成功后才启动 jobs，app 使用独立 DML URL。迁移入口失败必须停止发布，不以 app 自动迁移兜底。

升级在隔离库复制备份后，固定新 SDK 版本，重复迁移、事务提交/回滚、批次混合结果、双实例限额、重启恢复和保留期边界验证。使用未迁移的旧 native schema 启动必须明确失败；SDK 启动成功不代表业务表兼容。回滚前停止领取并保留 inbox/checkpoint；旧代码不兼容新 schema 时恢复匹配版本备份或继续使用匹配版本引擎。跨代码版本热重放尚未承诺：先完成/暂停旧运行，或保留旧 handler 与稳定 step 次序、`applicationVersion`。

## 连接、轮询与 ownership

当前默认 web 业务池 10；每个 jobs 业务池 10，native `pg` 池 4。ownership 专用连接从这 4 个 native 连接中借出，不另加 1；双 jobs 默认上限为 **10 + 2 × (10 + 4) = 38**。native 池最少 3。迁移额外使用独立 max=1 池及公共迁移 API 的临时连接，安排在 app 启动前；health 复用已建业务池。PG 管理、备份和运维连接另留余量，38 不是整机资源验收结论。改业务/native 池大小时重新预算并观察 `pg_stat_activity`。

队列默认 250ms 轮询；每队列最多 10 条、最长 5 秒聚合窗口。并发/滑动速率按消息计额，批内成员与重试都计入，各队列独立。默认初次加最多 5 次重试，共 6 次；30 秒指数退避，封顶 900 秒。业务事务直接写 `job_engine.message`，提交前不发布；普通 `send` 不提供业务事务原子保证。批次发布 ID 固定为 `queue-batch:<batch UUID>`，不另建 outbox。

每个 jobs 必须有稳定且互异的 `executorId`。所有 jobs 共享同一个本机 `ownershipDirectory`、相同主机名和 PID namespace；Linux 分离容器必须显式满足这些条件，不能根据其他 namespace 的同号 PID 判断旧进程退出。DB advisory 会话锁与 exclusive 本机 owner 文件共同保护启动；文件记录每个 incarnation 的 PID、host、namespace 和 token。目录必须持久、受限，不能在进程仍活着时删锁。

SIGTERM 先停止领取，受控排空，然后关闭 DBOS/native 池。超时 callback 可能仍执行外部副作用；`close()` 返回、DB 锁释放、网络中断或固定 TTL 均不能证明旧进程退出。**真正退出后**才能复用相同 executor ID 或回收其 batch/permit。外部调用仍使用业务幂等键。

## 只读排查

用 readonly 凭据执行以下查询。查询只取 metadata，禁止 `SELECT *`，不读 `message.body` 或 DBOS inputs/output/error；正文仅供获授权业务重放工具在受控路径读取。

```sql
-- 未完成消息、尝试及原始接收时间；created_at 不随重试改变。
SELECT id, queue, request_id, created_at, available_at,
       state, attempts, batch_id, finished_at
FROM job_engine.message
WHERE state IN ('pending', 'claimed', 'running')
ORDER BY available_at, id LIMIT 100;

SELECT id, queue, state, size, executor_id, executor_token,
       created_at, finished_at
FROM job_engine.batch
ORDER BY created_at DESC LIMIT 100;

SELECT message_id, queue, attempts, code, retryable, created_at
FROM job_engine.dead_letter
ORDER BY created_at DESC LIMIT 100;

SELECT queue, message_id, batch_id, attempt, started_at
FROM job_engine.start
ORDER BY started_at DESC LIMIT 100;

-- native 状态只读，不修改第三方表。
SELECT workflow_uuid, status, name, executor_id, application_version,
       created_at, updated_at, recovery_attempts, queue_name
FROM dbos.workflow_status
WHERE workflow_uuid LIKE 'queue-batch:%'
ORDER BY created_at DESC LIMIT 100;
```

`acked/dead` 是消息终态，`completed/failed` 是批次终态；DBOS SUCCESS 只表示 workflow 返回，不能代替业务成功。批次失败后仍有 claimed/running 消息时先排查 ownership 与恢复器，不修改状态使列表“变绿”。错误摘要是机器码；日志输出 `messageId/queue/attempt/requestId/jobId` 与计数，不输出邮件验证码、payload、驱动异常、连接串或 SDK error。

## 手动处置

- 死信重放：先查业务副作用是否已经成功以及失败原因，修正原因后，经获授权重放工具读取原消息并用 producer/业务事务重新入队。创建**新的消息 UUID**，保留原业务 `idempotencyKey` 与 `requestId`，记录新旧身份映射；保留原死信直到保留期结束。不要把原死信行改回 pending 或 reset attempts，也不要为规避去重生成新业务幂等键。
- 卡住批次：核对 native 状态、batch executor/token 及对应 incarnation 文件。先停止该实例并确认记录 PID 在相同 host/namespace 已退出，再让 adapter 的恢复器按原消息与批次身份修复。禁止直接释放仍可能活着的 permit、删除 active batch/start、根据年龄或心跳缺失进行 TTL 接管。
- `.recovering` guard 残留：读取 guard 的 PID/host/namespace/token，证明对应进程已退出后才人工删除该 guard；保留 owner 与 incarnation 记录。记录确认依据与操作者，不清空整个 ownership 目录。
- 清理与重放/DBOS resume 操作互斥；清理期间不复活终态 native workflow。SDK 公共查询与删除不是跨系统原子事务，必须维持终态不被人工恢复的运维约束。

## 保留期与清理

已启动的独立 jobs 维护路径调用 `cleanupNodeQueues(db, options)`（`packages/platform/src/node/job-maintenance.ts`），使用已建业务池和初始化后的 DBOS；只允许一个维护调用在途，低峰运行。不要运行全 schema DELETE、TRUNCATE 或 SDK-wide 清理命令。

| 数据 | 默认与删除条件 |
|---|---|
| 终态消息 | 7 天；finished_at 达到保留期、所属 batch 已安全终态、没有仍保留的 DLQ |
| 死信 | 30 天；created_at 达到死信保留期且原消息满足终态消息清理条件 |
| start 日志 | 至少 `max(60 分钟, startRetentionMs, 队列 rateLimit.periodMs)`；所属业务/native batch 都已终态至少 60 分钟 |
| batch 与 owned native journal | 7 天；业务 finished_at 与 native updatedAt 都达到终态保留期；batch 无剩余 message/start 引用才删除 |

三个可配置保留期均不得小于 60 分钟。未终态、缺 finished_at、未知 native 更新时间或 native 仍 active 时保留；未发布或此前已删除的 native 状态可为空，但业务终态与引用检查仍必须通过。active batch 及其关联消息/start 永不清理，长任务超过保留期也不例外。清理按 queue 行锁与领取/速率统计串行化，不能提前删除滑动窗口 start 计数；大积压可能增加领取延迟，应观察耗时。

native 删除仅使用 `DBOS.deleteWorkflow('queue-batch:<UUID>', false)` 公共 API，先核对 owned handler `saas-queue-batch-v1`、终态和更新时间；不递归删 child workflows，不写第三方内部表。公共删除会删该 workflow 的 native journal/消息/事件，故本入口仅用于不接受外部早到事件的 queue-batch，不涉及其他 workflow、scheduler 或未来 event inbox。

协调者确认 2.5 只验收队列域清理与其他事件数据的保留保护；自有 FIFO event inbox 的终态清理归 3.3。本入口不访问其事件数据，后续清理必须独立遵守：active 实例永不删，未消费早到事件至少保留 60 分钟；不得仅凭 native 终态删除未来事件，需确认事件归属、消费状态、发送时间及保留期。清理结果仅输出计数；public native 删除与业务 tx 分离，后续业务 tx 失败时下一次清理继续，不能重新发布已终态 queue batch。

本批以模拟清理时钟验证 60 分钟边界、active batch、30 天 DLQ 连带消息保留，以及其他 workflow/native 早到事件未删除。这不代替 3.3 的真实 60+ 分钟等待；整机预算与新加坡服务器验收保留为后续独立门槛。

## 最小装配与本地验证

业务数据库由 A 的 `createDb(url, { max })` 创建并拥有，engine/queue 只借用 `Database` facade。composition 先注册固定版本 handler，再启动 DBOS 和 publisher：

```ts
let queues: ReturnType<typeof createNodeQueueAdapter>
const engine = await createNodeJobEngine({
  database: db, databaseUrl, executorId, applicationVersion, ownershipDirectory,
  register(engine) {
    queues = createNodeQueueAdapter({
      db, executorId, ownershipToken: engine.ownershipToken,
      assertOwnership: () => engine.assertOwnership(),
      isExecutorStopped: (id, token) => engine.isExecutorStopped(id, token),
    })
    queues.register('email', consumeEmail)
  },
  async start() { await queues.prepare(); queues.start() },
  stopReceiving() { queues.stopReceiving() },
})
```

A shutdown 的 `stopReceiving` 先调用 `engine.stopReceiving()`；`closeResources` 调用 `engine.close()`，最后关闭业务池。业务生产端用 `createNodeQueueProducer<T>(db, 'email')`，取 `producer.send/sendBatch` 或 `transactionalEnqueue.enqueue(tx, body)`。消息体沿用 requestId/idempotencyKey，消息 ID 和初始 timestamp 由 inbox 分配且重试不改变。

handler 的 Promise 必须涵盖整批全部在途工作；并行消费使用 allSettled 等待所有成员，不把未完成外部调用留在 detached Promise 中。`ack/ackAll` 与 `retry/retryAll` 使用先到决定；`await sink.failed(...)` 成功后才确认有效终态失败。全部业务副作用仍需幂等。

本地只使用独立测试 PG，先在该库迁移。`db:push` 默认只检查 public；测试 job_engine 时使用临时 Drizzle 配置 `schemaFilter: ['job_engine']` 与 `schema: './src/schema/job-engine.ts'`，发布时仍使用版本控制的迁移。配置 `TEST_JOB_DATABASE_URL`、`TEST_JOB_MIGRATOR_URL`、`TEST_JOB_READONLY_DATABASE_URL` 后运行 `pnpm --filter @saas/platform test:job-engine`。生产退避测试真实等待约 16 分钟，不使用 fake timers；单独快验可用 Vitest 的 `-t` 筛选。`job-schema-probe.ts` 使用隔离旧库的 `TEST_JOB_OLD_DATABASE_URL`，在升级前输出 rejected、升级后输出 started，只输出安全状态码。结束后仅停止自己启动的测试进程与容器。

所有 jobs 必须注册相同 `applicationVersion` 的完整 handler 集与队列策略。DBOS 恢复会进入全局内部队列，不能让缺少对应 handler 或无法读取同一 ownership 目录的实例接走恢复任务；不同注册集的测试运行使用不同逻辑数据库，不并发复用同一 DBOS 应用版本。

## 本批验证记录（2026-10-12）

本地 Node 23.11.0（满足仓库 >=22）与独立 Postgres 17 容器，app/migrator/readonly 分权；没有请求外部业务 API 或 staging。

- 业务迁移本地生成并在全新隔离库应用：`pnpm --filter @saas/db exec drizzle-kit generate --name node_job_engine` → 5 张 `job_engine` 表；`db:migrate` → `pnpm --filter @saas/platform dbos:migrate`，重复执行成功。生成的 SQL/meta 不提交，由协调者在 main 重生成。
- 5.1.10 CLI 初始化旧 native schema；5.2.11 app probe 返回 `JOB_ENGINE_DATABASE_NOT_READY`；公共 migrate 升级及重复执行后 probe 返回 started。app CREATE/ALTER 和 readonly 正文读取/写入均拒绝，readonly 摘要查询通过。
- caller Drizzle 的未提交/回滚/提交、10 条真实批次、发布前/接受后未标记/副作用后确认前 SIGKILL、双 jobs 消息级并发 2 与滑动 10 秒最多 3 次、独立队列及不可重试 DLQ 均有真实 PG 用例。
- 六次真实生产退避测试耗时 956.43 秒，9 条成功成员各 1 次，失败成员 6 次后 DLQ，机器日志不含正文。5 次等待没有达到 900 秒封顶，不宣称实测了 900 秒等待。

| 尝试 | UTC 时间 | 距前一次 |
|---|---|---|
| 1 | 11:42:04.863 | — |
| 2 | 11:42:39.900 | 35.037 秒 |
| 3 | 11:43:45.002 | 65.102 秒 |
| 4 | 11:45:50.040 | 125.038 秒 |
| 5 | 11:49:55.152 | 245.112 秒 |
| 6 | 11:58:00.196 | 485.044 秒 |

间隔为 30/60/120/240/480 秒退避加真实 5 秒聚合窗；该长跑之后的 ownership 修复由独立取消等待批次/同 ID 重启回归验证。清理时钟边界、active 数据与未消费 native 事件保护、30 天 DLQ 保留、close 后活进程拒绝同 ID、已退出 owner 的失败批次恢复和执行权丢失均由独立 PG 测试覆盖。模拟清理时钟不替代后续工作流的真实 60+ 分钟等待验收。
