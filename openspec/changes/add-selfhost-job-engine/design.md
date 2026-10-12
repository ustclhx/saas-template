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

**Non-Goals:** 本轮运行 spike 或实现代码；开发采集业务；引入 Redis 队列、Kubernetes、跨机器高可用；配置或付费使用托管工作流服务；改变 Cloudflare 引擎/发布。Docker Compose 与推荐运维方式 Dokploy、Node 宿主、缓存/存储适配、镜像和部署编排由其他 change 负责，B 提供集成需求及验收证据。

## Decisions

### 1. 分阶段选型，DBOS 是暂定推荐

决定范围已固定为 **DBOS Transact** 或 **pg-boss + 自研 Postgres 持久 step 引擎**。两个候选必须接受同一套接口和故障场景验证；不能以库宣称的 exactly-once 替代业务幂等，也不能只测正常流程。

提案阶段依据官方文档的初评如下，全部实测列仍为“待 spike”，不宣称已通过。文档在 2026-10-12 查阅，spike 须固定具体发行版本、Node LTS、PG17 版本及源码 SHA，再用对应版本的文档复核。

| 评价维度/门槛 | DBOS 初评 | pg-boss + step 引擎初评 | 实测证据/结论（spike 回填） |
|---|---|---|---|
| Q2 回滚、提交、提交后投递崩溃 | 提供事务客户端；现有 postgres.js 接口不直接兼容，优先 outbox | custom db 可在调用方事务发送；仍须验证 Drizzle tx 桥接 | 待 spike：DB 行、任务执行计数、故障窗口 |
| Q1 retry/backoff/DLQ/batch | 队列单位为 workflow，batch/逐条 ack 与 DLQ 需兼容实现 | 原生队列、重试、死信和批量 API 较贴近 | 待 spike：尝试次数、时间序列、混合批次终态 |
| Q3 双实例共享并发/速率 | 队列有全局并发与启动速率配置；batch 必须按消息计额 | 核对固定版本的全局 flow control，不能仅用进程本地上限 | 待 spike：两实例峰值并发、窗口内调用数 |
| J1 Asia/Singapore | 文档提供 cronTimezone | 文档提供 tz | 待 spike：本地时间/UTC scheduledTime 对照 |
| J2 双实例、长任务互斥、catch-up | 调度有持久运行，自动 backfill 不等于补跑一次 | 调度自带去重不等于业务长任务互斥；补跑策略需核实/补齐 | 待 spike：唯一 slot、最大活跃数、skip/once |
| J3 heartbeat/health | 接入既有 setting/health，库本身不替代业务心跳 | 同左 | 待 spike：成功、失败、停机读数 |
| W1/W3 持久 step/事件 | 原生 step/sleep/send/recv，需转换超时与不可重试错误、验证缓冲 | 需自行实现 step journal、等待状态和 inbox | 待 spike：重试、超时、FIFO、早到 60+ 分钟 |
| W2 1–2h 流水线重启 | 文档提供 checkpoint 恢复；需验证版本和双执行者恢复 | 队列重投不等于 step 恢复，依赖自研正确性 | 待 spike：已成功 step 不重做、最终输出 |
| 2核4GB/连接/存储 | 无新增常驻引擎服务，需实测轮询/连接池开销 | 同为库嵌入，额外 step journal 维护成本 | 待 spike：RSS/CPU/连接/WAL/存储增长 |
| schema/migrator/升级 | 官方 CLI 和禁用运行时迁移配置可供验证 | 自带 schema/迁移管理可供验证 | 待 spike：仅 migrator DDL、app 无 DDL 启动、重复迁移/升级 |
| 许可/成熟度/维护 | 官方仓库 MIT；验证发行节奏、问题响应、破坏性升级和依赖许可 | 官方仓库 MIT；队列库成熟度与自研 step 风险分别评估 | 待 spike：固定版本 LICENSE、维护证据、升级成本 |
| Cloudflare 语义差距 | 工作流较近，队列 batch/ack 与重放限制是主要补齐面 | 队列较近，持久多步/事件是主要补齐面 | 待 spike：适配代码量、剩余差异、测试/维护成本 |

**暂定推荐 DBOS**：W1–W3 是跨重启正确性最复杂的部分，优先复用持久编排，避免维护自研执行状态机。若 Q1 的批量适配、Q2 的迁移/事务边界或最小权限无法在时间盒内满足，而 pg-boss 方案全部门槛通过，则推荐后者。两者均有核心语义缺口时停止进入实施，由协调者处理范围决策；不得无证据转第三候选。

官方依据（仅用于初评，不构成通过证据）：[DBOS workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)、[queues](https://docs.dbos.dev/typescript/reference/queues)、[client 事务 API](https://docs.dbos.dev/typescript/reference/client)、[send/recv](https://docs.dbos.dev/typescript/tutorials/workflow-communication)、[scheduling](https://docs.dbos.dev/typescript/tutorials/scheduled-workflows)、[migration CLI](https://docs.dbos.dev/typescript/reference/cli)、[源码/许可](https://github.com/dbos-inc/dbos-transact-ts)；[pg-boss 项目与许可](https://github.com/timgit/pg-boss)、[transaction send](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md)、[batch workers](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md)、[scheduling](https://github.com/timgit/pg-boss/blob/master/docs/api/scheduling.md)。

### 2. Spike 实验协议与决策记录

时间盒为 **合计 2–3 个 worker 工作日**，不是每候选各 3 天。约半天准备共享测试/隔离 PG17、一天候选验证、一天长跑/故障/资源与决策收敛。长跑和 60 分钟事件实验可以并行等待，但不能用 fake timer 替代全部实时时长证据。

仅在 `spikes/job-engine/` 或临时目录实现可丢弃原型，独立依赖/数据库，不 import 到业务代码、不合并原型与 spike lockfile。可复现命令、版本、脱敏报告纳入本 change 的 `evidence/`，结论回填本设计；本轮没有 evidence，不创建伪结果。

两个候选各自执行以下相同实验：

1. 同一真实业务事务模拟“额度预扣 + 入队”，分别提交、回滚、保持事务未提交；仅提交后执行。若采用 outbox，杀死发布器于“引擎已接受但 outbox 未标记”窗口，再启动，证明可恢复且副作用幂等。
2. 10 条批次混合成功/失败，成功条不被失败条拖累；失败按 30s 起指数退避封顶 900s，首次 + 5 次重试后有死信。验证消费者执行后、确认前中断的重投；记录 queue/job ID、attempts、nextRunAt 与脱敏失败摘要。
3. 两 jobs 同时消费同一队列，设置并发 2、速率每 10 秒最多启动 3 条，含批量及重试，验证合计限额；另队列正常执行，限额不相互占用。启动限额不自动保证一个消息内多个 API 调用的配额，业务须按调用粒度投递或显式获取额度。
4. Asia/Singapore cron，短周期观察及次日 02:00 slot 计算；两 jobs 同时启动。让处理时长跨越下一 slot，验证同一 schedule 无重叠；停止多个周期再恢复，分别 skip、once，后者只执行最近一个错过 slot。恢复/补跑仍保留原 scheduledTime。
5. 写 heartbeat 后读 `/api/health`；失败不前移成功时间；停机超过 10 分钟可观察到旧时间。区分探测 DB 可达与后台任务停摆。
6. 仿 AiMediaWorkflow 的 named do、step retry、sleep、wait timeout、NonRetryableError、外部 sendEvent；create 后立即发、sleep 中发、先发多同 type 再等待，确认 FIFO/消费一次/不同 type 不相互阻塞；事件存放至少 3600 秒后仍可读，在此期间重启 jobs；不存在/终态实例的事件被明确拒绝。
7. 1–2 小时模拟采集：拉取列表 → 事务预扣/API 分批 → 详情补全 → 商品簇归并 → 产出汇总，全部外部服务替身。成功步骤后强制重启 jobs，再在 sleep/wait 中重启；相同版本从 checkpoint 恢复，完成步骤调用计数不增加，未完成步骤允许安全重试。另验证副作用完成但 step checkpoint 未写的崩溃窗口。
8. 2 vCPU / 4 GiB 受限 Linux Docker 环境测 idle、backlog、双 jobs、长工作流 CPU/RSS/连接峰值/队列延迟/WAL 和 journal 增长；与 A 的 web/PG/cache 预算合并评估整机余量，不能把“jobs 单独低于 4GiB”当通过。不 OOM、无连接耗尽，记录负载与剩余预算；达不到则调低限额再测，不编造吞吐目标。
9. 固定版本初始化、再次执行迁移、版本升级；用 migrator 管理引擎 schema，app 仅 DML、readonly 只读，app 无 DDL 启动仍能工作。评估 schema/扩展要求、源码迁移如何纳入一次性迁移容器、许可和维护风险。

**DR-B-001（提案阶段决策记录）**

- 状态：暂定，等待 spike；已确认部分是 Postgres 与双候选范围。
- 暂定选择：DBOS + postgres.js 业务事务 outbox；兼容层补齐 Queue batch/ack、DLQ、Cron catch-up-once、Cloudflare step API。
- 依据：复用持久 step 能减少自研崩溃恢复面，队列差异需实测成本。
- 最终决策门槛：Q1–Q3/J1–J3/W1–W3、迁移最小权限全部具备实测证据；比较资源余量与适配/维护成本，解释未选择候选的具体缺口。
- spike 回填：版本/日期/执行者、矩阵证据链接、最终推荐、排除理由、遗留限制、A 接口签字对齐及 tasks 2.x–6.x 调整。协调者审阅后才能进入实施；本轮不把暂定标记为已通过。

### 3. 与 A 对齐的接口假设与文件边界

A `add-selfhost-foundation` 负责 `packages/platform` 的 **接口定义和 Cloudflare 包装**；B 只提供 Node 实现。已核对 2026-10-12 同波 A 的 design 草案（任务契约与健康边界），其并行提案尚非已合并合同。下表按该草案收敛假设，实施前仍须由协调者确认两份 design 的最终版本；本 change 不另建竞争性接口包。

| 能力 | 假设合同（模型来自现有 Cloudflare 使用） | 责任与限制 |
|---|---|---|
| Queue producer | `QueueProducer.send(body,{delaySeconds?})`、`sendBatch([{body,delaySeconds?}])`；消息内保留 requestId/idempotencyKey；独立 `TransactionalEnqueue.enqueue(tx,body)` | A 定义平台中性类型，B 的 Node producer/发布器实施 Q2；不宣称 Cloudflare 原生 send 与 PG 事务原子 |
| Queue consumer | queue name、batch.messages、message id/body/attempts、单条 `ack()` / `retry({delaySeconds})`；批次最大条数/等待窗；终止丢弃原因可交给 Node dead-letter recorder | B 按消息记录终态，ack 不等于“成功”时必须显式记录耗尽原因，避免邮件最后一次确认绕过 DLQ |
| Queue policy | maxRetries 与初次投递明确区分、backoff/上限、batchSize/batchTimeout、全队列 concurrency/rate limit | A 定义目标能力差异，B 在双实例间全局执行；CF 未有等价配置不自动扩展行为 |
| Workflow binding | `create({id?,params})`、`get(id)`；instance.id、`status()`、`sendEvent({type,payload})`、`terminate()`；中立状态 queued/running/waiting/completed/failed/terminated | 必须覆盖取消/开发探针所需 status/terminate；不存在、终态发送错误明确映射；业务 task 状态仍独立 |
| Workflow step | `do(name, callback)` 和 `do(name,{retries:{limit,delayMs,backoff},timeoutMs},callback)`；`sleep(name,durationMs)`；`waitForEvent(name,{type,timeoutMs})`；共享 NonRetryableError | A 的中立单位为毫秒，CF wrapper 转换原 delay/timeout 字符串与毫秒；B 不重新暴露旧绑定类型，统一序列化/重试数/超时语义；JSON 结果；事件 type 沿用合法字符集，`media-done` 无点 |
| Scheduler | 注册 `{id,cron,timeZone,missedRun:'skip'\|'once'}`，handler 获得原 `scheduledAt`；start/stop | A 定义注册模型和 CF Cron Triggers 映射，B 提供 jobs 内持久调度和互斥 |
| Lifecycle / health | A 的 Node pool、启动配置验证、优雅退出及 health 扩展点；B 暴露 queue `{status:'up'\|'down'\|'unavailable'}` 与 scheduler `{status,lastCronAt}`、run ledger，写既有 heartbeat | A 负责配置和 HTTP/容器接入，B 不重建 web 服务或 Compose；SIGTERM 停止领取，超时未完成保持可恢复 |

文件所有权：B 实施限定 `packages/platform` 的 Node job adapter 文件、`apps/jobs` 对应 Node 入口及业务 runner 解耦、web 任务调用点、job-engine/outbox 数据领域；A 拥有平台公共接口、Cloudflare wrapper、runtime/config/Compose 基础。公共导出、依赖 manifest/lockfile、迁移入口及 schema 导出需协调者分配后串行集成。packages 不依赖 apps；platform 适配器接收 app 注册的 handler，不从 platform 导入 AiMediaWorkflow。

### 4. 队列与事务：采用 outbox 作为 DBOS 基线

DBOS 的 `enqueueInTransaction` 接受 node-postgres Client，不能假定可直接传现有 Drizzle/postgres.js tx。基线保留业务驱动：业务 tx 写同库 outbox；提交后 Node 发布器用稳定消息 ID 投递。回滚无记录；发布成功、标记成功前崩溃会重复投递，必须用稳定引擎 ID 去重和业务幂等共同恢复。不在业务事务内调用外部网络，不用“提交后 fire-and-forget”替代 Q2。

outbox 存 message ID（UUIDv7）、queue、payload、requestId、可用时间和发布状态；重复投递复用 ID，多个发布器使用数据库原子 claim/锁；仅在引擎持久接受后标记完成。发布失败保留待投递状态并记录脱敏错误。发布器恢复不能丢已提交任务。若 spike 证明所选候选能用既有 tx 原子发送且无需换驱动，则删除多余 outbox 实施任务，避免保留两套路径。

消费者提供既有 MessageBatch 外形，保留逐条 ack/retry 与显式延迟。DBOS 是 workflow 队列，**不能仅把单条数组称为批量消费**：spike 必须证明可聚合 10 条/5 秒窗口的真实批次、逐消息重试/checkpoint，并按消息计算限额。若批次作为一个 workflow，批内已完成消息必须持久标记；失败重放不重新发送已完成消息，批内 Promise.all 也不能突破 Q3。这一适配成本是 DBOS 的核心选型风险，不先决定复杂通用批处理框架。

Node 耗尽策略必须写死信（原队列、message ID、attempts、失败原因、时间及受控 payload）。邮件业务层最后一次 `email.dropped` 在 Node 接入死信记录再 ack，CF 保持原行为；无效/不可重试邮件仍按现有策略确认并告警，不反复重放过期验证链接。只提供查询/运维 runbook，不增加后台 DLQ UI 或默认自动重放。

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

DBOS 基线把 stable named steps 映射到持久调用，不重跑已完成 step 的 callback。工作流体重放必须维持稳定步骤次序/版本，随机值、时间和外部副作用在 step 中记录；已有 runner 的 deadline/终态自检需保留可更新的数据库观察，不能把实时取消状态永久缓存。step 成功结果限定可序列化数据/文件 ID，不跨 step 存流或 Provider 实例。

sleep 持久存唤醒时刻；wait 持久存 type/deadline，重启不重新计算整段等待时间。sendEvent 在实例存在后进入持久 inbox，queued 或 sleep 中早到也可读，至少保留 60 分钟；匹配 type FIFO、消费与 wait 完成的 checkpoint 需原子一致。使用 DBOS send/recv 时验证上述行为，recv 的 null 超时映射为可捕获等待超时。NonRetryableError 禁止该 step 重试，错误仍进入现有 fail-and-notify 的业务结算，而非跳过退款。

若选择 pg-boss，任务 3.x 改为自研最小 journal：workflow instance/version/state、step name/结果/attempt/下一可运行时间、wait deadline、event inbox/消费标记及执行权。pg-boss 仅负责可运行任务投递，**不能通过重跑整个函数冒充 W2**；step 执行与结果提交之间可能重复副作用，仍遵守业务幂等。表的唯一约束与故障恢复均须从 spike 证据推导，不提前扩成通用 DAG 平台。

AiMediaWorkflow 保持 task.id 为 instance ID、2h 硬截止、回调先落库、check/recheck、15min 等待后轮询、submit/persist 重试配置、确定性对象 key、结算与通知幂等。非幂等 Provider 的 submissionAttempted 不确定窗口仍禁止重提；引擎成功只表示 runner 返回，业务 ai_task 可能 failed，两个状态不混淆。取消先释放/落终态，再尝试引擎 terminate；取消失败保持可重试标记。Node 对象存储由配套存储 change（C）提供；A 只隔离 CF 专用入口并将尚未支持的 Node 媒体能力标为不可用，B 不实现存储后端。媒体产出端到端验收依赖 C，Node 不要求 Workers AI 绑定。

### 7. Schema 与生命周期

引擎 schema 与业务 schema 位于同 PG17 实例，优先同逻辑数据库的独立 namespace，隔离业务、outbox 和引擎 metadata。不手工改第三方内部表；migrator 在一次性迁移流程先跑受版本控制的业务迁移和引擎迁移/权限，再启动 app。app 无 CREATE/ALTER 权限，运行时关闭自动迁移；readonly 仅查询必要状态。库内部 ID 不强行改表，对外业务/outbox ID 保持 UUIDv7。

spike 证明 migrator 的版本升级、幂等重跑、app 无 DDL 启动。DBOS/pg-boss 自带 migration CLI 需要纳入现有迁移入口；worker 不提交 SQL，由协调者按 `docs/09-parallel-plan.md` 统一生成/集成，不能因库默认自动建表给 app 提权。连接预算包含引擎可能自带的 pg pool、A 的业务 pool、web/两个 jobs，总量必须在 PG 资源内。

SIGTERM 停止接收新任务，等待受控在途任务；超过 A 的退出上限后保存/保留未完成状态，以重启恢复。等待、sleep 不靠内存 setTimeout 单独承载。引擎日志经 `@saas/shared/log` 保留 requestId/workspaceId/jobId/attempt，健康数据不暴露 payload 或凭据。

## Risks / Trade-offs

- [DBOS batch/DLQ 与 Cloudflare MessageBatch 不完全一致] → spike 把混合批次与消息级额度列为硬门槛，成本过大改推荐候选。
- [事务驱动与引擎不同、确认窗口重复] → outbox 用现有业务 tx，稳定 ID 和消费者幂等；用故障注入证明恢复。
- [锁丢失/网络分区导致两个执行者] → 实测候选 ownership 与 fencing，外部 API 使用业务幂等键，不承诺任意副作用 exactly-once。
- [日志和死信可能带邮件内容] → 受控持久数据、最小读取权限及保留期；stdout/健康/验收报告仅输出脱敏摘要。
- [1–2h 工作流跨版本重放不兼容] → 同版本恢复为本期验收；升级时完成/暂停旧工作流或保留旧 handler/version，不热改旧 step 顺序。
- [2核4GB CPU/连接/WAL 压力] → 两实例峰值及全套服务预算实测，显式并发/速率/pool 限制，报告 journal/DLQ 清理成本。
- [A 与 B 并发修改共享边界] → 对齐接口后按文件分配，公共文件由协调者串行集成，CF 回归与 staging 自动发布保持既有流程。

## Migration Plan

1. 先执行 spike、回填矩阵与 DR-B-001、对齐 A；只选择一个候选实施，移除失效任务假设。
2. A 的接口、Node 宿主/池和适配能力合并可用后，集成 B Node adapter 与共有业务 runner；媒体存储完整链路需 C 可用。Cloudflare 仍使用其 wrapper。
3. 协调者集成业务/outbox 与引擎迁移；先 migrator、再 app；持久卷与备份覆盖引擎 metadata（备份实现属其他 change）。
4. 在隔离本地 Docker 验收后，在新加坡服务器重做第 4–6 项；先单 jobs 再双 jobs。不得部署分支到共享 Cloudflare staging；CF 回归使用现有自动发布。
5. 回滚 Node 代码前停止领取并保留 PG/outbox/checkpoint/inbox，不删除任务表；确认旧版本可读 schema，不能兼容时恢复匹配版本备份或继续匹配版本引擎。切回 Cloudflare 不自动转移 Node 未完成任务；迁移目标需另行协调。

## Open Questions

spike 后在不改变行为门槛的范围内确定具体版本/参数：引擎 polling/pool 和保留期预算、readonly 运维查询范围、死信与已完成 journal 的默认保留时长。最终库选择和 A 接口签字属于前述阶段门槛，不是可绕过的开放问题。
