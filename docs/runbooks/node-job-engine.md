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

## 工作流装配、恢复与停机（B 3.1–3.4）

在 `createNodeJobEngine` 的 `register(engine)` 内调用
`createNodeWorkflow({ engine, name: 'media-v1', handler })`，handler 接收
`(params, step)`，只能返回 JSON。通过 Node 入口取得适配器；业务仍使用中立
`Workflow` / `WorkflowStep`。所有 jobs 必须注册同一版本的完整 handler 集，不能让缺少
handler 的实例领取恢复任务。`applicationVersion` 由发布版本固定，handler 名包含版本；
同版本重启沿用稳定且互异的 executor ID，并且必须确认旧进程已退出。

业务 ID 是合法非空字符串（含 Unicode），内部 ID 为
`workflow:<handler 名的 base64url>:<业务 ID 的 base64url>`，不与 queue-batch 身份混用。
省略 ID 时生成 UUIDv7；重复 create 复用同一身份，首次持久输入与结果保持不变。
SDK completed 只表示 handler 返回，返回的业务状态仍可能 failed，不据此更新 ai_task。
实例缺失报 `WORKFLOW_NOT_FOUND`，终态事件报 `WORKFLOW_TERMINAL`。

命名步骤在一个流程中唯一，顺序稳定；随机值、当前时间和副作用在 `step.do` 内获取并
保存 JSON 结果。`retries.limit` 不包含首次，所有时间单位为毫秒；linear 为
`delayMs / 2×delayMs / 3×delayMs`，exponential 为 `delayMs / 2×delayMs / 4×delayMs`。
每次失败结果与重试 sleep 分别持久保存，成功 callback 在恢复时不再调用。
`NonRetryableError` 不重试，handler 仍可捕获它完成失败结算。
`WORKFLOW_STEP_TIMEOUT` 表示尝试超时，不能强行停止不合作 callback；其迟到结果被
丢弃，但外部副作用仍可能发生，必须依靠业务幂等或底层取消信号。副作用已提交而 step
checkpoint 未提交时，恢复可重试；不要宣称任意副作用 exactly-once。

`sleep` 使用原生持久唤醒时刻。`waitForEvent` 使用自有 wait 日志保存首次 deadline，
重启不延长；超时报可捕获的 `WORKFLOW_EVENT_TIMEOUT`，随后可按既有业务策略轮询。
事件可在 queued 或 sleep 中发送，按 type/单调序号 FIFO，事件消费与 wait JSON 结果
在同一事务提交。事件时间持久为 UTC ISO 字符串，API 还原为 `Date`。截止后到达的事件
不完成原等待，仍可用于后续等待。不要使用 DBOS native recv 替代这一 FIFO 语义。

停机先由 A 的 stopReceiving hook 调用每个 workflow adapter 的 `stopReceiving()` 和
队列 publisher 的停止入口，再发起 `engine.close()`；DBOS shutdown 先停止 native
队列领取与恢复接收，再在配置的 `shutdownTimeoutMs` 内排空。之后关闭业务池。
超时的 sleep/wait/未完成 step 保留在 PG，真正退出后由相同版本恢复；不要通过
terminate、清空事件或删除 journal 来模拟停机。停止接收后新 create 报
`WORKFLOW_STOPPING`，在途业务请求应先排空，再关闭其使用的资源。

本期只承诺同版本恢复；升级前先完成旧任务，或保留旧版本 handler 与兼容的步骤次序。
不能原地修改旧 handler 的 do/sleep/wait 顺序或持久结果形状并热重放旧实例。
回滚时也保留 native checkpoint、event inbox 和 wait 日志，确认 schema/代码版本匹配。

### 事件 schema、权限与清理

协调者合并后生成新增两张表的迁移：
`pnpm --filter @saas/db exec drizzle-kit generate --name node_workflow_events`。
先应用业务迁移，再运行 `pnpm --filter @saas/platform dbos:migrate`，最后启动 jobs。
app 拥有事件表 DML 和序号 sequence USAGE；readonly 仅能读以下摘要列，不能读 payload
或 wait result。初始化/升级须复验固定版 `dbos.workflow_status` 的
`workflow_uuid/status/name/updated_at` 及行锁：发送和消费只读取/锁定该表，从不手写第三方表。

```sql
SELECT id, sequence, workflow_id, type, created_at, consumed_at
FROM job_engine.workflow_event
ORDER BY sequence LIMIT 100;

SELECT id, workflow_id, name, type, deadline, state, created_at, finished_at
FROM job_engine.workflow_wait
ORDER BY created_at DESC LIMIT 100;
```

维护路径单独调用 `cleanupNodeWorkflowEvents(db, { terminalRetentionMs })`，默认 7 天，
最短 60 分钟。只删自有 event/wait；native journal 由另行获授权的运维流程管理。
实例必须是本模块的已知 native 终态且 updated_at 已达到保留期，事件/wait 自身创建时间
也达到保留期，才可删；未消费事件同样至少保留 60 分钟。active、缺失 native 状态或
未知更新时间均保留，长任务不因年龄被删。清理与人工 resume 互斥，不修改终态使其复活。
每实例短事务与发送/消费使用同一 native 行锁，日志只报告删除计数，不输出 payload。

本地快验：配置隔离的 `TEST_JOB_DATABASE_URL`、`TEST_JOB_MIGRATOR_URL` 与
`TEST_JOB_READONLY_DATABASE_URL` 后，执行
`pnpm --filter @saas/platform exec vitest run --config vitest.workflow.config.ts`。
真实长跑另设 `TEST_WORKFLOW_LONG=1` 并筛选 `-t 'real 61-minute'`；同一逻辑数据库不能并发跑
注册集不同的 DBOS suite，长跑与快验使用独立数据库。长跑使用真实时钟，不用 fake timers
或把数据库时间改老来冒充 60+ 分钟事件/1–2 小时流水线验收。

### 本批工作流验证记录（2026-10-12）

独立 worktree 命名的 Postgres 17.11 容器，Node 23.11.0、DBOS 固定 5.2.11；
不同注册集使用不同隔离逻辑库，没有请求外部业务 API 或 staging。
工作流快验 10 项通过（113.17 秒）；媒体 submit/persist 使用真实 10 秒 delay，
persist 三次重试依次等待 10/20/30 秒，首次不计入 limit。
消费事务提交后/native checkpoint 前 SIGKILL 验证结果仍可读取且事件不再次消费；
另有副作用后/checkpoint 前 SIGKILL 验证幂等结果只产生一次。
SIGTERM 定向回归 7.35 秒：受控排空后未完成 sleep 仍为 PENDING，同 ID 退出后
重启使用原唤醒时刻与成功 step 结果，不用 terminate 冒充停机。

单独升级库通过 5.1.10 CLI 初始化与重复初始化；5.2.11 app probe 明确返回
`JOB_ENGINE_DATABASE_NOT_READY`。执行当前公共 migrate 两次后 app probe 返回 started，
再运行 FIFO、原 wait deadline/晚到事件、原子消费恢复和 readonly 权限 4 项回归，
14.40 秒全部通过。固定版 native 状态的读取/行锁路径在升级后实际运行；未来版本
升级仍须重跑上述场景，不能从本次推导任意未来版本兼容。

新增事件表及权限后，既有 `test:job-engine` 回归 2 个文件、13 项全部通过，
耗时 1124.61 秒；覆盖真实六次生产退避/DLQ、caller tx、双 jobs 消息级限额、
发布/确认窗口、ownership 与队列域清理。事件/wait 域的清理仍独立于队列入口。

初版真实长跑在中段 resume 的 JSON `null` 载荷触发 SQL NOT NULL 约束而失败，
该轮不作为通过证据。Drizzle 会跳过 JS null 的 JSON codec；适配器已在事件写入边界
显式编码 JSON 并转换 jsonb，使 JSON null 与 SQL NULL 区分。
补强原子消费测试使用 null 载荷，4.26 秒通过；修复后的完整工作流快验 10 项
再次通过（112.22 秒），根目录检查/类型/测试/构建也再次通过。
真实长跑把短 sleep/wait/中间成功步骤的三次退出注入前置，再使用 3661 秒的
第二段真实 sleep 等待早到事件；仍验证原唤醒时间、同业务身份、1–2h 总时长
与超过 60 分钟的原始事件时间，不修改数据库时钟或回填事件时间。

最终真实长跑通过：测试耗时 **3668.08 秒**（约 61.1 分钟），同业务身份的 native
运行记录为 **2026-10-12 13:07:17.213 UTC → 14:08:24.594 UTC**，
`application_version = workflow-integration-v1`、状态 SUCCESS、recovery_attempts=4
（首次执行加三次同版本重启）。列表、五次事务配额、十个详情、归并、汇总共
**18 个 callback 全部各 1 次**，配额/详情 **15 个幂等副作用**完整。

早到事件接收于 **13:07:17.227521 UTC**，在 **14:08:24.536766 UTC** 原子消费，
真实保留 **3667.309 秒**，超过 60 分钟；API Date 还原后的 ISO 时间仍等于原发送时间。
resume 等待的原 deadline 为 **13:08:21.247422 UTC**，重启后不改变；七个 native
sleep 日志的原唤醒结果与重启前快照完全一致。两个等待结果均 completed，事件只消费一次。
以上为正式 Node adapter 的隔离 PG 验收，失败旧轮不计入通过时长，也不替代服务器
部署、跨代码版本热重放或整机资源验收。
