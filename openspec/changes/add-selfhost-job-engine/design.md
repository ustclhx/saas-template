# Design

## Context

动机见 [proposal.md](proposal.md)。本设计将 2026-10-12 确认的自托管需求作为新增 Node 目标的输入，Cloudflare 仍是主目标。复述本 change 所需需求，保留原编号：

| ID | 优先级 | 本 change 必须交付的行为 |
|---|---|---|
| Q1 | P0 | 至少一次投递，按队列配置重试次数/退避，死信记录，批量消费 |
| Q2 | P0 | 与业务写入同事务入队，或等价 outbox；回滚绝不产生可执行任务 |
| Q3 | P0 | 每队列消费并发和速率上限，满足外部 API 配额节奏 |
| J1 | P0 | jobs 内 cron 调度，可配置时区，覆盖 Asia/Singapore |
| J2 | P0 | 同一定时任务不并发重复执行；停机错过运行可配置跳过或补跑一次 |
| J3 | P0 | 保留 heartbeat，健康检查能看到最近定时任务成功时间 |
| W1 | P1 | 步骤结果持久化、按步骤重试、sleep、带超时 waitForEvent、不可重试错误、外部 sendEvent |
| W2 | P1 | jobs 重启后从最后成功步骤继续执行未完成任务 |
| W3 | P1 | 早于等待到达的事件保留至少 60 分钟 |

验收来源第 6 节第 4–6 项在此自包含重述：本地 Docker 与新加坡 Linux 服务器上，按时区准时调度且两个 jobs 不重复执行；队列失败按策略重试后进入死信，事务回滚不执行；多步任务中途重启 jobs 后断点恢复并完成。代表场景为每日 Asia/Singapore 02:00 开始的 1–2 小时采集、事务内预扣 API 额度后投递、详情补全/商品簇归并批量任务；只模拟该业务形状，不加入具体采集业务。

### 已观察到的实现

- `apps/jobs/src/index.ts` 分发 email/events，导出 `AiMediaWorkflow`；`wrangler.jsonc` 两队列均批量最多 10、等待最多 5 秒、最多重试 5 次。
- `queues/email.ts` 单条 ack/retry，首次加重试共 6 次，30 秒指数退避封顶 900 秒。不可重试失败确认并告警；耗尽仍确认并记录 `email.dropped`，**没有 Cloudflare 死信队列**。events 实际由 `queues/billing.ts` 消费，涵盖计费后处理与 operations 通知，按消息确认/重试。
- `workflows/media-runner.ts` 已将持久 step 编排与 Worker 外壳分开，但仍引用 Cloudflare step 类型及 jobs 的 Cloudflare Sentry。`ai-media.ts` 外壳负责 Provider、数据库、存储依赖。直接导入整个 Worker 入口不能作为 Node 入口。
- web `features/ai/media-tasks.ts` 在 task+hold 提交后 create，失败退款；回调先落库再 sendEvent，通知失败仍返回 200；取消先落库释放再尝试 Provider cancel 与 workflow status/terminate。
- `packages/db/src/client.ts` 当前使用 Drizzle + postgres.js，按事件创建客户端。A 负责 Node 进程级连接池，B 不继续复制 Worker 的“不关闭连接”模式。
- 主规格已有 `user-auth` 邮件异步契约、`system-health` 心跳与 `runtime-config` 配置校验，没有可复用的队列、调度、持久步骤 capability；本 change 新增三个 capability，不改现有 Cloudflare 规格。

## Goals / Non-Goals

**Goals:** 以 Postgres 17 为事实来源，用可复现故障实验选引擎；让两种目标共用现有业务处理器和幂等边界；将第三方 API 差异限制在平台 Node 实现；支持单机多 jobs 进程的互斥与全局队列限额。

**Non-Goals:** Phase 2 业务实现代码；开发采集业务；引入 Redis 队列、Kubernetes、跨机器高可用；配置或付费使用托管工作流服务；改变 Cloudflare 引擎/发布。Docker Compose 与推荐运维方式 Dokploy、Node 宿主、缓存/存储适配、镜像和部署编排由其他 change 负责，B 提供集成需求及验收证据。

## Decisions

### 1. Spike 推荐：DBOS 5.2.11 + 事务消息 inbox

Phase 1 已在隔离 PG17/Linux Docker 运行，原型不进入本 PR。两个候选固定为 DBOS SDK **5.2.11**（`3f36908f58fd8b3079cbf5372203c7a2d0ba06cc`）与 pg-boss **12.37.1**（`9bdce7c360d33bd43ec927671851c8f9136fcec6`），均为 MIT；Node **22.22.2**、Postgres **17.11**。发行包、许可、依赖和原型摘要见 [版本](spike/versions.json)、[证据入口](spike/README.md)。发行时间及升级记录属于维护评估，不能推导任意未来版本兼容。

推荐 **DBOS + 调用方 Drizzle 事务写消息 inbox + Node 批量发布/确认适配 + 自有事件 inbox/等待日志 + 持久 schedule ledger**。这是提交协调者审阅的推荐，1.10 未签收前不得启动 Phase 2。事务消息 inbox 已承担待发布和逐消息终态，**不再额外建一张业务 outbox**。pg-boss 原生事务队列可行，作为比较候选保留在独立原型归档，不进入生产依赖。

| 门槛 | DBOS 实测与补齐 | pg-boss + step 引擎实测与补齐 | 证据 / 判定边界 |
|---|---|---|---|
| Q2 事务 | postgres.js / 实际 Drizzle tx 写自有 inbox；未提交不可见、回滚零执行、提交执行 | custom db 经调用方 tx.execute 入原生队列；同样满足提交/回滚 | `*-drizzle-transaction.json`、`*.json:Q2.transaction`；真正 outbox-only 接受后发布器退出88、重复同 ID 的补测见 `*-extras.json` |
| Q1 batch/ack | 真批次10/5s；自有消息状态逐条 ack/retry、6次耗尽写 DLQ | 原生 batch10、独立 complete/fail + 应用 DLQ 摘要 | `*.json:Q1.batch-start`、`*-extras.json:Q1.success-peers-durable-ack`；9条成功消息各1次，确认前退出后重投且最终确认 |
| Q1 退避 | 30/60/120/240/480s；上限900为策略配置 | 首轮误用 active update 得到固定30s，已修为同 tx fail → update retry 的 startAfter | `*-retry-recheck.json` 是修正后的六次真实尝试；旧 `boss.json` 的失败保留。5次重试数学上未到900s，不宣称实测了900s等待 |
| Q3 全局限制 | 自有持久 permit；limited 真批次最多2，滑动10s最多3 | 原生 groupConcurrency + 持久 slot/启动窗口；limited 真批次2 | `*.json:Q3.global-limits` + `*-extras.json:Q3.actual-two-worker-contention`；后者要求两 worker 实际同时消费，暂停短于租约并恢复 |
| J1/J2 | 两候选使用完全相同的 cron-parser + 唯一 slot/活动 run ledger，调用各引擎稳定 workflow ID | 同左，不把共享补齐的效果算成库原生调度优势 | `*.json:J1.J2.scheduler`；Asia/Singapore 02:00 为前 UTC 日18:00；跨 slot 无重叠、skip/once、已有 skip 运行恢复见 `*-postchecks.json` |
| J3 | 五分钟成功写 heartbeat；前置失败不更新；停止调度601s仍为旧值 | 同左 | `*.json:J3.heartbeat`；独立实验 `/api/health` 返回 no-store，陈旧时503。不是尚未接入 B 的生产 web health 验收 |
| W1/W3 | 原生 do/retry/sleep；linear 用原生单次持久 step + durable sleep；自有 FIFO inbox + 原 deadline/原子消费结果 | 自研实例/step journal、retryAt、sleep/wait deadline、FIFO inbox | `*.json:W1.basic/W3.FIFO`、`*-postchecks.json`、`*-formal-contract.json`、`*-extras.json:late-event-after-deadline-restart` |
| W2 / 60+min 事件 | 真实采集流水线3706704ms（61.78min），早到事件3706679ms；两段sleep重启，成功步骤各1次 | 3716550ms（61.94min），早到事件3716514ms；同业务ID/检查点/结果，观察器错误独立保留 | `*-pipeline.json`均passed=true；10条限流详情、并发2、滑动窗口2≤3、归并总数10；第一中止/观察器异常不抹除 |
| Schema / 最小权限 | migrator 初始化、重跑、5.1.10 CLI →5.2.11 public migrate；app runMigrations:false | 12.37.0→12.37.1，migrate/createSchema:false；自研 schema 单独迁移 | `*-upgrade.json`、`permissions.json`；app 无 schema CREATE、readonly写被拒；升级仅证明迁移，不证明跨代码版本重放 |
| 资源 / 连接 / WAL | PG + 两候选4 jobs + drivers 共用**一个**2 vCPU/4GiB cgroup | 同左，按进程 RSS/CPU 与各 DB 连接/存储分别归因 | `resources.jsonl` 与各报告 resources；负载形状和最终峰值见 `resource-summary.json`。A 全服务预算待协调者提供，不能据此宣称整机验收完成 |
| 维护成本 | 候选 adapter 约293行，原生 durable step/sleep；仍需队列/事件/调度补齐 | 候选 adapter 约352行，另需维护完整 workflow journal/恢复所有权 | 代码行数只计原型 adapter，不是生产估算；共享 scheduler187行。许可/版本事实见 `maintenance.json` |

资源结果：169个Docker样本，最大CPU42.01%（Docker100%为一核，约为2核限额的21.0%），working set峰值662.1MiB；kernel memory.peak为964587520B（920MiB，包含page cache），swap/oom/oom_kill均0。两DB分别采样连接峰值18/10，数据库各增长约1MiB；集群WAL增长约34.6MiB，包含两候选/升级/控制器，不能归因给单个引擎。结束后idle working set约349MiB。此测量不包含A web/Valkey/代理，预算建议见 [resource-budget.md](spike/resource-budget.md)，故1.9仍未勾。

**排除 pg-boss 为本期首选的理由**：原生队列更贴近 Q1/Q2，但本项目同时需要 W1–W3。其自研 journal 没有版本/ownership epoch；SIGKILL 实验通过不等于仍存活的租约失效 worker 被 fencing。sleep/wait 持续轮询并占 worker，回调与 journal 之间所有异常、事件原子消费及升级约束都需自行维护。实际还遇到 postgres.js 显式 BEGIN、Date/JSON 编码以及 active job 不能 update 的桥接成本。修正后可继续比较，不把原型错误算成 pg-boss 库缺陷。

**DBOS 的代价与边界**：原生 recv 只按毫秒时间排序，不能据此承诺同毫秒 FIFO；已使用自有序号 inbox，禁止修改第三方内部表。发送为原子终态检查读取/锁定固定版 `dbos.workflow_status`，存在内部 schema 读耦合；升级必须验证此处。限额按消息实现，不能以 native workflow 限额冒充批内消息限额。恢复依赖稳定、互不重复的 executorID；停住但未退出的 worker 不应被另一个同 ID incarnation 接管。failed batch 的 claim/permit 恢复、消费 readiness 与保留期清理须在 Phase 2 交付，不能使用盲目 TTL 放行造成旧执行者重叠。两个候选的 step timeout 都不能强制终止不合作的外部副作用，业务幂等和取消信号仍必需。

### 2. 实验协议、失败记录与 DR-B-001

共享 driver 与两个候选使用相同消息、workflow 和故障点。实验容器无宿主端口，不接真实 API、云资源或 staging。Node 镜像拉取停滞后，从固定 npm `node-linux-arm64@22.22.2` 取运行时，放入 PG17 镜像；PG、两个候选的四个 jobs 与实验控制器共享2核4GiB限制，避免各容器分别限额后误称整机2核。原型只在 `spikes/job-engine/`，独立 lockfile；可复现快照链接见证据入口。

实验与异常均保留：

- 首轮 pg-boss wait 检查被 supervisor 在 RPC 中重启打断，记录 worker-exit；定向复测比较重启前后的持久 deadline 与成功步骤调用计数，而不是把恢复耗时误当等待时长重置。
- pg-boss 首轮六次重试全部约30s：public update 只处理 pre-active 状态，故 active update 无效。修为同事务先 fail 再更新 retry 时间，并断言更新1条，重跑真实六次时间轴。
- Drizzle 构建会改变借用 postgres.js client 的 Date/JSON codecs，不能将同一 client 当未经 ORM 装配的裸驱动。隔离原型 raw engine SQL 与 business Drizzle client，所有事务发送仍用调用方 tx；生产 adapter 的自有 schema 查询应经 A 的 Database/Drizzle facade，DBOS native pg pool单独计预算。桥接准备长跑已中止，最终验收使用修正后的同一采集定义。
- DBOS 等待曾遗漏“到达时间≤原 deadline”的筛选；增加后验证截止后事件不会在重启时被错误消费。
- 初次旧版 DBOS 升级脚本误用尚不存在的 static migrate；保留 TypeError，改用固定5.1.10的 CLI migrate入口后，初始化、重跑和升级均通过。
- 10:16:05实验控制器使用旧PID，误杀本容器PG后端3059；PG在约103ms后完成恢复。pg-boss观察器因恢复期SQL异常退出，业务workflow仍waiting且检查点完整。保留 `boss-pipeline-observer-error.json`，观察器以原ID重新挂接，不重新create、不重发业务任务；后续结论仍需原始计数和最终断言。控制器交接改为验证 `/proc`可执行文件、worker ID和live RPC，禁止只凭旧PID认定进程所有权。该控制器错误不归因于候选引擎。
- 早期 postchecks 的单项 end 在 await 前记录，单项耗时无效；断言与整份报告 start/end有效。最终关键耗时取 pipeline/重试/进程 timeline，不从该错误字段推算。

**DR-B-001（spike 推荐，待协调者确认）**

- 状态：指定本地Q/J/W实验完成、正式接口已对齐；不是经审阅的最终选择；1.10保持未勾。
- 推荐：固定 DBOS5.2.11 + 同业务 Drizzle tx 写消息 inbox；真实批次、逐条确认/DLQ、消息级全局配额；自有 FIFO event inbox/wait日志；持久 schedule ledger。
- 取舍：删除额外 outbox 路径，保留稳定消息/批次 ID；复用原生 step/sleep/recovery，减少自研工作流状态机。没有选择第三候选。
- 审阅证据：本节矩阵和 [spike 索引](spike/README.md)，保留首轮失败与定向复测，不以源码/类型检查冒充运行通过。
- A 签收点：main `8c21cd20a48e0db3a696681a14b57766397d78d5`（#107），`packages/platform/src/{queue,workflow,scheduler,capabilities}.ts`、`docs/platform-capabilities.md`、`test/contracts.ts`。独立镜像快照的合同类型检查通过；Drizzle事务、字符串 ID、Date事件、linear退避分别有运行证据。Controller RPC不是业务接口。
- 待确认：A 全服务资源预算；稳定 executorID 与退出后才复用的生命周期约束；Phase2 claim/permit fencing及保留期验证。协调者确认矩阵、边界与2.x–6.x后才能更新为最终选择。

### 3. 与 A 对齐的接口假设与文件边界

A `add-selfhost-foundation` 负责 `packages/platform` 的 **接口定义和 Cloudflare 包装**；B 只提供 Node 实现。正式合同已由 A #107 合并；签收文件和 SHA 见 DR-B-001。下表描述职责，精确参数/返回类型以该合同为准；本 change 不另建竞争性接口包。

| 能力 | 假设合同（模型来自现有 Cloudflare 使用） | 责任与限制 |
|---|---|---|
| Queue producer | `QueueProducer.send(body,{delaySeconds?})`、`sendBatch([{body,delaySeconds?}])`；消息内保留 requestId/idempotencyKey；独立 `TransactionalEnqueue.enqueue(tx,body)` | A 定义平台中性类型，B 的 Node producer/发布器实施 Q2；不宣称 Cloudflare 原生 send 与 PG 事务原子 |
| Queue consumer | queue name、batch.messages、message id/body/attempts、单条 `ack()` / `retry({delaySeconds})`；批次最大条数/等待窗；终止丢弃原因可交给 Node dead-letter recorder | B 按消息记录终态，ack 不等于“成功”时必须显式记录耗尽原因，避免邮件最后一次确认绕过 DLQ |
| Queue policy | maxRetries 与初次投递明确区分、backoff/上限、batchSize/batchTimeout、全队列 concurrency/rate limit | A 定义目标能力差异，B 在双实例间全局执行；CF 未有等价配置不自动扩展行为 |
| Workflow binding | `create({id?,params})`、`get(id)`；instance.id、`status()`、`sendEvent({type,payload})`、`terminate()`；中立状态 queued/running/paused/waiting/completed/failed/terminated | 必须覆盖取消/开发探针所需 status/terminate；不存在、终态发送错误明确映射；业务 task 状态仍独立 |
| Workflow step | `do(name, callback)` 和 `do(name,{retries:{limit,delayMs,backoff:constant/linear/exponential},timeoutMs},callback)`；`sleep(name,durationMs)`；`waitForEvent(name,{type,timeoutMs})`；共享 NonRetryableError | A 的中立单位为毫秒，CF wrapper 转换原 delay/timeout 字符串与毫秒；B 不重新暴露旧绑定类型，统一序列化/重试数/超时语义；JSON 结果；事件 type 沿用合法字符集，`media-done` 无点 |
| Scheduler | `register({id,cron,timeZone,missedRun:'skip'\|'once'},handler)`，handler 获得原 `scheduledAt:Date`；`health()`，启动/停止属 Node lifecycle | A 定义注册模型和 CF Cron Triggers 映射，B 提供 jobs 内持久调度和互斥 |
| Lifecycle / health | A 的 Node pool、启动配置验证、优雅退出及 health 扩展点；B 暴露 queue `{status:'up'\|'down'\|'unavailable'}` 与 scheduler `{status,lastCronAt}`、run ledger，写既有 heartbeat | A 负责配置和 HTTP/容器接入，B 不重建 web 服务或 Compose；SIGTERM 停止领取，超时未完成保持可恢复 |

文件所有权：B 实施限定 `packages/platform` 的 Node job adapter 文件、`apps/jobs` 对应 Node 入口及业务 runner 解耦、web 任务调用点、job-engine/message/event inbox 数据领域；A 拥有平台公共接口、Cloudflare wrapper、runtime/config/Compose 基础。公共导出、依赖 manifest/lockfile、迁移入口及 schema 导出需协调者分配后串行集成。packages 不依赖 apps；platform 适配器接收 app 注册的 handler，不从 platform 导入 AiMediaWorkflow。

### 4. 队列与事务：同事务消息 inbox，避免第二张 outbox

DBOS native enqueueInTransaction 使用 node-postgres Client；正式 A 的 `DatabaseTransaction` 是现有 Drizzle/postgres.js tx，不能另开引擎连接冒充原事务。spike 已证明用调用方 `tx.execute` 写自有消息 inbox，并由提交后发布器归并真实批次、以稳定批次 ID 启动 DBOS workflow。消息 inbox 同时记录延迟、尝试次数、claim、逐消息确认和死信终态；回滚没有消息，不再增加一张冗余业务 outbox。

`QueueProducer<T>` 对业务保持 send(body,options)/sendBatch([...])返回void；消息 ID由 adapter产生 UUIDv7，消息中保留 requestId/idempotencyKey。`TransactionalEnqueue.enqueue(tx,body)`是独立能力，使用同一业务事务；正式实现用 Drizzle schema/query，避免把裸 postgres.js的 codecs假设带到 A pool。普通 send不能用作事务保证。

批量按每队列最大10条/5秒窗口真实聚合，limited场景为满足并发2而一次最多2条；逐消息 ack/retry，成功同批成员不被失败成员拖累。批内每条及重试都计全局配额；permit状态、claim发布及终态恢复要在两实例间协调。DBOS成功 workflow/checkpoint不是消息已确认的同义词；发布后崩溃、callback副作用后checkpoint前崩溃分别验证稳定ID与业务幂等。持久记录耗尽失败必须先于确认，使用 A `DeadLetterSink.failed(message,{code,retryable})`；无效消息仍按现有业务确认/告警，CF不新增死信策略。

spike 的 outbox-only 对照证明另一条可靠路径可行，但没有改变最终单一事务 inbox方案。Phase2必须补 failed batch/失去执行权的处理和查询清理 runbook，不手工修改 DBOS-owned内部表，不靠“fire-and-forget”或日志丢弃消息。

### 5. 定时任务：UTC 保存、时区计算、全程互斥

cron 在配置时区计算，运行记录以 UTC `timestamptz` 存 `(scheduleId, scheduledTime)` 唯一 slot 和执行状态。两个实例对同一 slot 的领取原子化；同一 schedule 从开始直到完成不能重叠，跨下一 slot 仍被串行/合并处理。优先复用候选持久调度与单例队列，若不足则添加最小 run ledger 和 ownership/fencing；不能持有跨 1–2h 外部调用的业务事务。失去执行权的旧 worker 不能继续写完成，外部副作用仍要幂等。

catch-up 默认 `skip`；`once` 在恢复时按持久游标合并为最近一个错过 slot，历史多次不逐个回放。两实例恢复仍只生成一个补跑。未完成的已有运行按故障恢复继续，不能被 catch-up 跳过；运行时间跨下一 slot 时按同一策略 skip/合并一次，防止 backlog 爆发。仅有 cron 去重键不能证明长任务不并发执行。DBOS automaticBackfill 的“补全部”不可直接映射 once，须适配且实测。

五条既有任务默认保持 **UTC**（避免 silently 将每日 03/04 时改为新加坡时刻），用户可显式配置 Asia/Singapore；示例采集 schedule 使用该时区 02:00。

| Cron | 必须保留的业务映射 |
|---|---|
| `*/5 * * * *` | 删除凭据缓存补偿成功后写 heartbeat；失败不推进成功心跳 |
| `0 * * * *` | 积分过期、年付按月发放 |
| `*/10 * * * *` | hold 回收（注册 ai_message/ai_task 处理器）、webhook 后处理恢复、退款补偿/通知，独立执行文件清理 |
| `0 3 * * *` | 空间软删除清理与 daily metrics 独立执行；指标继续按原 scheduledTime 的前一 UTC 日 upsert |
| `0 4 * * *` | 订阅/积分对账、退款联系人清理与 operations 告警 |

保留独立任务各自尝试、任一失败最终报告 Cron 失败的行为。J3 使用 `jobs.lastCronAt`、ISO UTC、无缓存读取，继续五分钟 heartbeat 成功路径；每条 schedule 的成功/失败另有 run ledger。现有 system-health 的“每次执行”描述比代码实际五分钟路径宽，此处明确记录差异并保持既有路径，避免其他 Cron 覆盖心跳掩盖删除缓存补偿失败。停机超过两个周期（10 分钟）观察陈旧心跳；Cloudflare 继续既有 DB 探测状态策略；Node 按 A 的 O2 扩展在 queue/scheduler 未装配、异常或 heartbeat 超过两个周期时 readiness 返回 503。B 提供真实队列/消费与调度探测，不能把 DB 可达推断为引擎就绪，也不以“进程活着”刷新成功时间。

### 6. 工作流：检查点、持久等待与事件 inbox

DBOS 推荐把 stable named steps 映射到持久调用，不重跑已完成 step 的 callback。工作流体重放必须维持稳定步骤次序/版本，随机值、时间和外部副作用在 step 中记录；已有 runner 的 deadline/终态自检需保留可更新的数据库观察，不能把实时取消状态永久缓存。step 成功结果限定可序列化数据/文件 ID，不跨 step 存流或 Provider 实例。

sleep 持久存唤醒时刻；wait 持久存 type/deadline，重启不重新计算整段等待时间。sendEvent 在实例存在后进入持久 inbox，queued 或 sleep 中早到也可读，至少保留 60 分钟；匹配 type FIFO、消费与 wait 完成的 checkpoint 需原子一致。spike 使用自有 event inbox/wait日志保证 FIFO、原截止与原子消费结果；deadline 后到达的事件不得完成该等待。底层缓存结果恢复后，API metadata的 timestamp还原为 Date；持久结果本身保持JSON。NonRetryableError 禁止该 step 重试，错误仍进入现有 fail-and-notify 的业务结算，而非跳过退款。

pg-boss 比较原型使用自研最小 journal：workflow instance/version/state、step name/结果/attempt/下一可运行时间、wait deadline、event inbox/消费标记及执行权。该方案未被推荐；pg-boss 仅负责可运行任务投递，**不能通过重跑整个函数冒充 W2**；step 执行与结果提交之间可能重复副作用，仍遵守业务幂等。表的唯一约束与故障恢复均须从 spike 证据推导，不提前扩成通用 DAG 平台。

AiMediaWorkflow 保持 task.id 为 instance ID、2h 硬截止、回调先落库、check/recheck、15min 等待后轮询、submit/persist 重试配置、确定性对象 key、结算与通知幂等。非幂等 Provider 的 submissionAttempted 不确定窗口仍禁止重提；引擎成功只表示 runner 返回，业务 ai_task 可能 failed，两个状态不混淆。取消先释放/落终态，再尝试引擎 terminate；取消失败保持可重试标记。Node 对象存储由配套存储 change（C）提供；A 只隔离 CF 专用入口并将尚未支持的 Node 媒体能力标为不可用，B 不实现存储后端。媒体产出端到端验收依赖 C，Node 不要求 Workers AI 绑定。

### 7. Schema 与生命周期

引擎 schema 与业务 schema 位于同 PG17 实例，优先同逻辑数据库的独立 namespace，隔离业务、事务消息/event inbox 和引擎 metadata。不手工改第三方内部表；migrator 在一次性迁移流程先跑受版本控制的业务迁移和引擎迁移/权限，再启动 app。app 无 CREATE/ALTER 权限，运行时关闭自动迁移；readonly 仅查询必要状态。库内部 ID 不强行改表，对外业务/消息 ID 保持 UUIDv7。

spike 证明 migrator 的版本升级、幂等重跑、app 无 DDL 启动。DBOS5.2.11 public migrate 与版本化引擎迁移 需要纳入现有迁移入口；worker 不提交 SQL，由协调者按 `docs/09-parallel-plan.md` 统一生成/集成，不能因库默认自动建表给 app 提权。连接预算包含引擎可能自带的 pg pool、A 的业务 pool、web/两个 jobs，总量必须在 PG 资源内。

SIGTERM 停止接收新任务，等待受控在途任务；超过 A 的退出上限后保存/保留未完成状态，以重启恢复。等待、sleep 不靠内存 setTimeout 单独承载。引擎日志经 `@saas/shared/log` 保留 requestId/workspaceId/jobId/attempt，健康数据不暴露 payload 或凭据。

## Risks / Trade-offs

- [DBOS batch/DLQ 与 Cloudflare MessageBatch 不完全一致] → spike 把混合批次与消息级额度列为硬门槛，成本过大改推荐候选。
- [事务驱动与引擎不同、确认窗口重复] → 事务消息 inbox 用现有业务 tx，稳定 ID 和消费者幂等；用故障注入证明恢复。
- [锁丢失/网络分区导致两个执行者] → 实测候选 ownership 与 fencing，外部 API 使用业务幂等键，不承诺任意副作用 exactly-once。
- [日志和死信可能带邮件内容] → 受控持久数据、最小读取权限及保留期；stdout/健康/验收报告仅输出脱敏摘要。
- [1–2h 工作流跨版本重放不兼容] → 同版本恢复为本期验收；升级时完成/暂停旧工作流或保留旧 handler/version，不热改旧 step 顺序。
- [2核4GB CPU/连接/WAL 压力] → 两实例峰值及全套服务预算实测，显式并发/速率/pool 限制，报告 journal/DLQ 清理成本。
- [A 与 B 并发修改共享边界] → 对齐接口后按文件分配，公共文件由协调者串行集成，CF 回归与 staging 自动发布保持既有流程。

## Migration Plan

1. 先执行 spike、回填矩阵与 DR-B-001、对齐 A；只选择一个候选实施，移除失效任务假设。
2. A 的接口、Node 宿主/池和适配能力合并可用后，集成 B Node adapter 与共有业务 runner；媒体存储完整链路需 C 可用。Cloudflare 仍使用其 wrapper。
3. 协调者集成业务/事务消息 inbox 与引擎迁移；先 migrator、再 app；持久卷与备份覆盖引擎 metadata（备份实现属其他 change）。
4. 在隔离本地 Docker 验收后，在新加坡服务器重做第 4–6 项；先单 jobs 再双 jobs。不得部署分支到共享 Cloudflare staging；CF 回归使用现有自动发布。
5. 回滚 Node 代码前停止领取并保留 PG/message inbox/checkpoint/event inbox，不删除任务表；确认旧版本可读 schema，不能兼容时恢复匹配版本备份或继续匹配版本引擎。切回 Cloudflare 不自动转移 Node 未完成任务；迁移目标需另行协调。

## Open Questions

spike 后在不改变行为门槛的范围内确定具体版本/参数：引擎 polling/pool 和保留期预算、readonly 运维查询范围、死信与已完成 journal 的默认保留时长。最终库选择和 A 接口签字属于前述阶段门槛，不是可绕过的开放问题。
