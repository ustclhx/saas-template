# Tasks

本轮 **propose only**，不执行或勾选下列任务。阶段一为合计 2–3 个 worker 工作日的 spike；阶段二暂按 **DBOS + 业务事务 outbox** 推荐假设规划，须在 1.10 后依据最终候选调整。任何第三候选或行为门槛变更交协调者，不自行扩大范围。

实施前按 apply 技能读取全部 artifacts；只领取指定编号。共享接口/manifest/lockfile/迁移入口需协调者分配所有权；worker 用独立数据库，不提交迁移 SQL。所有完成勾选都须有该项验证证据。以下平台测试脚本需随 A 的实际 package scripts 对齐，不以尚未存在的命令作为已通过证据。

## 1. Phase 1：隔离 spike 与选型门槛

- [ ] 1.1 固定两个候选的发行版本/源码 SHA、Node LTS/PG17，建立 `spikes/job-engine/` 或临时目录的独立依赖、隔离数据库和共享场景驱动；核对 A 的接口假设。验证：两候选均能启动，版本/许可/运行命令有脱敏记录，业务代码及根 lockfile 无 spike 引用，原型不纳入合并。
- [ ] 1.2 分别验证 Q2 真实业务 tx 预扣与入队的未提交/提交/回滚，比较现有 postgres.js tx 直接入队与 outbox；若用 outbox，注入接受后未标记完成的发布器崩溃。验证：回滚执行计数零、提交最终执行、恢复不丢任务且副作用不重复，记录事务/执行状态证据。
- [ ] 1.3 分别验证 Q1 至少一次、10 条混合结果批次、逐条 ack/retry、30s 起指数退避封顶 900s、首次 + 5 次重试后死信、消费后确认前崩溃。验证：只有失败条重试，次数/时间序列及可查询死信正确，重复投递无重复业务结果。
- [ ] 1.4 分别验证 Q3 两 jobs 共享队列级并发 2、每 10s 启动最多 3 条，批量和重试均计入且不同队列独立。验证：持久执行计数与时间轴证明合计并发/速率不超限，不能仅报告单实例限额。
- [ ] 1.5 分别验证 J1–J2 的 Asia/Singapore cron/02:00 slot、两 jobs 同时调度、长任务跨下一 slot、停机多个周期后的 skip/once 和已有未完成运行恢复。验证：计划时间 UTC 对照正确、单 slot 一次、同 schedule 无重叠、once 只补最近一次且双实例不重复。
- [ ] 1.6 分别验证 J3 heartbeat 与 health：五分钟成功路径、删除缓存补偿失败、不运行超过 10 分钟。验证：`jobs.lastCronAt` 成功时更新、失败不前移、health 无缓存展示旧值或初始 null；各 schedule run ledger 有结果。
- [ ] 1.7 分别构建仿 AiMediaWorkflow 的持久 step 原型，覆盖 W1 的步骤重试/超时、sleep、等待超时、NonRetryableError、外部 sendEvent，覆盖 W3 的 queued/sleep 中早到、同 type FIFO、一次消费、不存在/终态拒绝。验证：至少一次实时时长超过 3600s 的早到事件在中途重启后仍被匹配，等待截止不因重启延长，脱敏报告可复现。
- [ ] 1.8 两候选分别运行真实持续 1–2h 的模拟采集流水线（无真实 API）：列表、事务预扣/限流分批、详情、归并、汇总；成功中间步骤后和 sleep/wait 中强制重启。验证 W2：同任务身份完成、成功步骤调用计数不增加、未完成步骤安全重试；补测副作用后 checkpoint 前崩溃窗口。
- [ ] 1.9 比较 2 vCPU/4GiB Docker 资源、schema 与许可/成熟度：idle/backlog/双 jobs/长跑 CPU/RSS/连接/WAL/journal 增长，合并 A 全服务预算；migrator 初始化/重复迁移/升级、app 无 DDL 启动、readonly 权限及保留期。验证：固定版本 LICENSE/维护证据与可复现测量入报告，无 OOM/连接耗尽，不把引擎自身低于 4GiB 当整机达标。
- [ ] 1.10 将实测评价矩阵、证据索引、推荐与排除理由回填 design.md，更新 DR-B-001 为经审阅的最终选择，并与 A design 对齐接口；按结果重写 2.x–6.x（选 pg-boss 时补自研 step journal/事件 inbox/恢复任务，删除 DBOS 假设）。验证：协调者确认核心门槛和接口、无未解释差距，`openspec validate add-selfhost-job-engine --strict` 通过；两候选均不满足时记录阻塞而不启动实施。

## 2. Phase 2：Node 引擎初始化与队列（暂按 DBOS，spike 后可调整）

依赖 1.10；A 的平台接口/Node pool/配置 schema 可用并分配共享文件所有权后实施。此组提交自己的队列测试和运维说明。

- [ ] 2.1 接入最终固定版本 Node 引擎初始化与 A pool/lifecycle，给出独立 schema 迁移及权限接入（运行时禁止 DDL），协调者集成迁移。验证：migrator 初始化/升级重复运行通过，app 无 CREATE/ALTER 可正常启动、旧 schema 启动明确失败，`pnpm check:deps`/`pnpm check:singletons` 通过。
- [ ] 2.2 实现 Node Queue send/batch send 的事务 outbox、原子发布 claim 与稳定消息 ID；若 spike 选直接 tx 则仅实施该路径。验证：真实 PG 集成用例覆盖未提交不可见/回滚零执行/提交可执行和发布崩溃窗口，复用 1.2 证据，不进行网络内嵌事务。
- [ ] 2.3 实现真正批量消费、逐消息 ack/retry、attempts/延迟映射和持久死信，保留业务主动确认策略及耗尽记录入口。验证：真实引擎混合批次、6 次尝试、确认前崩溃及死信查询用例通过，成功条不因单条失败重复处理。
- [ ] 2.4 实现队列级跨两 jobs 并发/速率限制并校验配置，批内执行和重试计额。验证：双实例 PG 测试的合计并发/窗口计数及独立队列行为通过，不使用仅进程本地限额。
- [ ] 2.5 随队列实现提交任务参数、事务发送方式、DLQ 查询与保留期/手工处置 runbook，日志仅记录脱敏 metadata。验证：按文档在隔离环境复现事务回滚、失败死信与只读查询，Node 目标队列测试和相关静态检查通过。

## 3. Phase 2：持久工作流（暂按 DBOS，spike 后可调整）

依赖 2.1 与 A workflow 合同。此组拥有 Node workflow adapter，不更改 Cloudflare 执行器。

- [ ] 3.1 实现 create/get/id/status/terminate 与平台错误映射，保持稳定实例身份、JSON 输入结果和引擎/业务状态区分。验证：真实 PG 实例创建/重复身份、状态查询、取消、不存在/终态错误测试通过，不跨包导入 apps。
- [ ] 3.2 映射 named do、重试 delay/backoff/limit/timeout、NonRetryableError 与持久 sleep。验证：成功步骤缓存、失败步骤独立重试、不可重试错误及重启 sleep 截止测试通过，未完成副作用幂等窗口测试保留。
- [ ] 3.3 实现持久 waitForEvent/sendEvent、超时可捕获、type FIFO/inbox 原子消费与至少 60min 保留。验证：queued/睡眠中早到、同 type 多事件、超时和不存在/终态实例用例通过，真实 60+min 事件实验及重启证据通过。
- [ ] 3.4 将 workflow 版本/重放约束、持久结果限制、退出恢复和事件保留行为写入 Node 引擎 runbook。验证：真实 PG+进程重启场景中成功 callback 不再执行、等待仍按原 deadline；按文档能恢复同版本未完成实例。

## 4. Phase 2：调度与可观察性（spike 后可调整）

依赖 2.1/3.1 和 A scheduler 合同；先完成时区/互斥，再移植现有 Cron。

- [ ] 4.1 实现 Node jobs 内 cron 注册、IANA timezone、原 scheduledTime 与持久 run ledger，默认既有任务 UTC。验证：Asia/Singapore 02:00 与 UTC 日期对照、非法配置启动失败用例通过，时区配置文档随实现提交。
- [ ] 4.2 实现双实例唯一 slot、整个 schedule 运行期间互斥、恢复 ownership 和 skip/once 合并；禁用会逐个补全部的默认 backfill。验证：双 jobs、长任务跨 slot、丢执行权、错过 3 次只补一次及恢复已有运行的真实 PG 测试通过。
- [ ] 4.3 接入 `jobs.lastCronAt` 与 A health/readiness 扩展点，成功路径及各 schedule 结果可观察，SIGTERM 停止领取并保留可恢复在途状态。验证：health 无缓存、失败不前移、超过 10min 陈旧心跳时 Node readiness 503、队列未装配/故障的 unavailable/down 和优雅/强制退出恢复测试通过；提交健康/调度排障说明，不泄露 payload。

## 5. Phase 2：现有业务移植（依赖 A 相关适配与 2–4，媒体产出依赖 C）

复用或扩展现有行为测试，按 Node/Cloudflare 两目标运行共享用例；只补真实平台故障风险测试。

- [ ] 5.1 将 email/events 的生产与消费接入 A queue 接口和 Node adapter，保留 requestId/幂等键、邮件错误分类、billing/operations 分消息处理；Node 耗尽邮件先记录死信再确认，CF 原行为保留。验证：复用 email-queue、billing.unit、operations.unit 及相关 web 队列测试，两目标通过且无效消息/耗尽/暂时失败行为符合规格。
- [ ] 5.2 为 Node 注册五条既有 Cron，移植 billing、删除缓存补偿、文件/空间清理、metrics 与 heartbeat，保留 ai_message/ai_task hold handler 注册及独立子任务失败策略。验证：复用 jobs/billing/files-cleanup/metrics/workspace 测试，检查所有五条映射；补跑 metrics 使用原 scheduledTime 的前一 UTC 日、重复 upsert 不累计。
- [ ] 5.3 解耦 media-runner 的 Cloudflare step/telemetry 依赖，由 Node 外壳注入 A 数据库、C 对象存储、既有 Provider 与 step，CF wrapper 使用相同业务 runner。验证：复用 media-workflow/media-settlement/media-hold-sweep 测试，两目标覆盖丢提交响应不可重提、check/recheck、轮询/截止、确定性产出与结算幂等。
- [ ] 5.4 将 web create/get/sendEvent/status/terminate 调用接入 A workflow，保留创建失败退款、回调先落库且通知失败仍 200、取消失败标记可恢复。验证：复用 ai-media-tasks 与跨绑定 smoke；Node 中途重启/晚到回调/取消后恢复不重复扣费；CF smoke 不依赖 Node 引擎。
- [ ] 5.5 提交 Node jobs 注册/扩展指南，说明队列、调度、工作流、配置默认 UTC 与 Asia/Singapore 示例、事务 API 和版本恢复限制。验证：隔离目标按指南运行新任务，关闭 billing/credits/AI 模块时不注册对应业务处理器且 jobs/heartbeat 仍可启动；文档不含外部本机路径。

## 6. Phase 2：集成与部署验收（须实际完成，不提前勾选）

依赖 1–5 全部完成、A 已合并可运行，C 媒体存储与部署配套可用。只做集成检查，前各组所需测试/文档已随实现交付。

- [ ] 6.1 在本地 Docker 执行需求验收第 4 项：Asia/Singapore 调度及同时两个 jobs，含跨 slot 长任务和 skip/once。验证：计划/实际时间、唯一运行与最大活跃数证据入验收报告，heartbeat 可由 health 读取。
- [ ] 6.2 在本地 Docker 执行需求验收第 5 项：策略重试/死信、事务入队后回滚、Q3 双实例队列限额。验证：尝试时间轴、死信记录、回滚执行计数零及全局流控计数入报告。
- [ ] 6.3 在本地 Docker 执行需求验收第 6 项：1–2h 模拟流水线中途强制重启 jobs，含 sleep/wait；复测 60+min 早到事件。验证：任务同身份最终完成、成功步骤不重做、结算/输出不重复、deadline 不延长，记录重启前后证据。
- [ ] 6.4 在新加坡 Linux 服务器重复第 4、5、6 项，核对双 jobs/资源限制与全套服务 2核4GB 余量。验证：完整 git SHA、版本/配置（脱敏）、时间轴/恢复/死信/资源报告通过；服务器未就绪时保持未完成并写明协调者所需准备，不以本地验收替代。
- [ ] 6.5 集成后运行 `openspec validate add-selfhost-job-engine --strict`、`pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm dedupe --check`、`pnpm typecheck`、`pnpm test`、`pnpm build`；验证 Node 目标集成用例及 CF 既有测试通过，自托管依赖不进入 CF 构建；现有 staging 自动发布/health 的回归由协调者通过 main 验证，不手动部署该分支、不以单纯构建替代部署验收。
