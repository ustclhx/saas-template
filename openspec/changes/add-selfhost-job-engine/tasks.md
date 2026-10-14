# Tasks

本 PR 只执行 **Phase 1 spike（1.1–1.10）**；原型/独立依赖不进入合并。阶段二按实测推荐 **DBOS5.2.11 + 调用方 Drizzle 事务消息 inbox** 重写，1.10 已于 2026-10-12 经用户确认（DBOS）。任何第三候选或行为门槛变更交协调者，不自行扩大范围。

实施前按 apply 技能读取全部 artifacts；只领取指定编号。共享接口/manifest/lockfile/迁移入口需协调者分配所有权；worker 用独立数据库，不提交迁移 SQL。所有完成勾选都须有该项验证证据。以下平台测试脚本需随 A 的实际 package scripts 对齐，不以尚未存在的命令作为已通过证据。

## 1. Phase 1：隔离 spike 与选型门槛

- [x] 1.1 固定两个候选的发行版本/源码 SHA、Node LTS/PG17，建立 `spikes/job-engine/` 或临时目录的独立依赖、隔离数据库和共享场景驱动；核对 A 的接口假设。验证：两候选均能启动，版本/许可/运行命令有脱敏记录，业务代码及根 lockfile 无 spike 引用，原型不纳入合并。
- [x] 1.2 分别验证 Q2 真实业务 tx 预扣与入队的未提交/提交/回滚，比较现有 postgres.js tx 直接入队与 outbox；若用 outbox，注入接受后未标记完成的发布器崩溃。验证：回滚执行计数零、提交最终执行、恢复不丢任务且副作用不重复，记录事务/执行状态证据。
- [x] 1.3 分别验证 Q1 至少一次、10 条混合结果批次、逐条 ack/retry、30s 起指数退避封顶 900s、首次 + 5 次重试后死信、消费后确认前崩溃。验证：只有失败条重试，次数/时间序列及可查询死信正确，重复投递无重复业务结果。
- [x] 1.4 分别验证 Q3 两 jobs 共享队列级并发 2、每 10s 启动最多 3 条，批量和重试均计入且不同队列独立。验证：持久执行计数与时间轴证明合计并发/速率不超限，不能仅报告单实例限额。
- [x] 1.5 分别验证 J1–J2 的 Asia/Singapore cron/02:00 slot、两 jobs 同时调度、长任务跨下一 slot、停机多个周期后的 skip/once 和已有未完成运行恢复。验证：计划时间 UTC 对照正确、单 slot 一次、同 schedule 无重叠、once 只补最近一次且双实例不重复。
- [x] 1.6 分别验证 J3 heartbeat 与 health：五分钟成功路径、删除缓存补偿失败、不运行超过 10 分钟。验证：`jobs.lastCronAt` 成功时更新、失败不前移、health 无缓存展示旧值或初始 null；各 schedule run ledger 有结果。
- [x] 1.7 分别构建仿 AiMediaWorkflow 的持久 step 原型，覆盖 W1 的步骤重试/超时、sleep、等待超时、NonRetryableError、外部 sendEvent，覆盖 W3 的 queued/sleep 中早到、同 type FIFO、一次消费、不存在/终态拒绝。验证：至少一次实时时长超过 3600s 的早到事件在中途重启后仍被匹配，等待截止不因重启延长，脱敏报告可复现。
- [x] 1.8 两候选分别运行真实持续 1–2h 的模拟采集流水线（无真实 API）：列表、事务预扣/限流分批、详情、归并、汇总；成功中间步骤后和 sleep/wait 中强制重启。验证 W2：同任务身份完成、成功步骤调用计数不增加、未完成步骤安全重试；补测副作用后 checkpoint 前崩溃窗口。
- [ ] 1.9 比较 2 vCPU/4GiB Docker 资源、schema 与许可/成熟度：idle/backlog/双 jobs/长跑 CPU/RSS/连接/WAL/journal 增长，合并 A 全服务预算；migrator 初始化/重复迁移/升级、app 无 DDL 启动、readonly 权限及保留期。验证：固定版本 LICENSE/维护证据与可复现测量入报告，无 OOM/连接耗尽，不把引擎自身低于 4GiB 当整机达标。
- [x] 1.10 将实测评价矩阵、证据索引、推荐与排除理由回填 design.md，更新 DR-B-001 为经审阅的最终选择，并与 A design 对齐接口；按结果重写 2.x–6.x（选 pg-boss 时补自研 step journal/事件 inbox/恢复任务，删除 DBOS 假设）。验证：协调者确认核心门槛和接口、无未解释差距，`openspec validate add-selfhost-job-engine --strict` 通过；两候选均不满足时记录阻塞而不启动实施。

## 2. Phase 2：DBOS 初始化与事务消息 inbox

依赖1.10；正式合同为A #107的queue/workflow/scheduler/capabilities与contracts夹具。协调者分配公共导出/依赖/schema权限后实施；下列编号均未执行。

- [x] 2.1 固定DBOS5.2.11，接入A Node生命周期、Database/Drizzle facade和独立native pg pool；稳定executorID不并发复用，退出后才恢复同ID。migrator执行DBOS public migrate及自有schema/权限，app runMigrations:false。验证：初始化/重复/升级、旧schema明确拒绝、app无CREATE/ALTER启动通过，业务/引擎/health总连接预算明确，check:deps/check:singletons通过。
- [x] 2.2 按正式QueueProducer/TransactionalEnqueue实现send/sendBatch/调用方Drizzle tx写事务消息inbox，UUIDv7消息ID、不可变timestamp、延迟与requestId/幂等键；原子批次claim后用稳定batch workflow ID发布，不额外增加outbox路径。验证：真实Drizzle未提交/回滚/提交、claim后未发布与接受后未标记的发布器崩溃，恢复无丢消息/重复业务结果；不得另开连接或依赖裸驱动codecs冒充caller tx。
- [x] 2.3 实现真实最大10条/5秒批次，QueueBatch ackAll/retryAll与逐条ack/retry，初次+5重试、30s指数退避封顶900s，持久DLQ与DeadLetterSink有效失败先记录后确认。验证：成功成员各1次，失败6次真实时间轴、确认前崩溃最终确认、不可重试有效失败与无效消息策略通过；不修改DBOS内部表。
- [x] 2.4 实现每队列跨两jobs消息级并发/滑动启动额度，批内和重试计额，独立队列互不占用；补齐failed batch/claim/permit恢复与ownership保护，不能盲目TTL释放仍可能运行的worker额度。验证：两worker实际竞争、真批次、重试、失去执行权/旧执行者/终态异常与其他队列的PG场景通过，持久计数不超限且不卡死未处置消息。
- [x] 2.5 提交事务inbox/批次/DLQ查询、手动处置、迁移、许可/版本、pool/轮询及保留期runbook；清理自有message/batch/DLQ/start及owned DBOS queue-batch journal；不删除其他workflow/native事件，active及未消费数据至少保留60min；自有终态FIFO event清理归3.3。验证：只读查询、保留期边界及拒绝删除active数据通过，脱敏日志有metadata且无邮件正文/凭据，相关静态检查通过。

## 3. Phase 2：DBOS工作流与自有FIFO事件日志

依赖2.1及A正式Workflow/WorkflowStep；Node adapter接收apps注册handler，不跨package导入apps，不更改CF执行器。

- [x] 3.1 实现create({id?,params})/get返回中立instance，id/status/terminate/sendEvent、JSON输入输出和平台错误；任意合法字符串业务ID与内部引擎ID区分。验证：重复身份/不存在/完成失败/终止、终态事件拒绝与正式contracts类型夹具通过；SDK成功不冒充业务ai_task成功。
- [x] 3.2 实现named do的成功缓存、limit排除首次、毫秒timeout/delay、constant/exponential及linear退避；NonRetryableError不重试，sleep保留原唤醒时刻。验证：成功callback跨重启不增加，linear100/200/300ms与原有submit/persist策略、不可重试失败结算、sleep/副作用后checkpoint前故障通过；记录timeout不能强制停止不合作回调的边界。
- [x] 3.3 实现自有event inbox序号FIFO、wait deadline和原子消费结果journal，queued/sleep中接收事件，至少60min保留；timestamp API返回Date，持久结果JSON；负责自有终态FIFO event清理，active实例永不清理且未消费早到事件至少保留60min（2.5只清理队列域）。固定版native状态只读/锁定耦合须封装并在升级验证，禁止写第三方内部表。验证：同type FIFO/不同type/消费一次、等待超时可捕获、截止后到达不误匹配、缺失/终态拒绝、重启原deadline及真实60+min事件通过。
- [x] 3.4 完成同版本恢复与升级/停机runbook，记录applicationVersion/handler版本和稳定步骤顺序；接A shutdown停止领取，受控排空，未完成状态保留。验证：同版本1–2h流水线恢复、等待/sleep/成功步骤缓存通过；不宣称跨代码版本热重放已支持，变更版本先完成/暂停旧任务或保留旧handler。

## 4. Phase 2：持久调度与健康

依赖2.1/3.1；Scheduler.register返回void，初始化阶段完成持久注册/校验后才启动，handler获得原scheduledAt:Date。共享spike scheduler只是实验，不原样并入生产。

- [x] 4.1 实现jobs内cron/IANA时区、配置校验、唯一(scheduleId,scheduledAt)ledger；默认既有任务UTC，采集示例Asia/Singapore02:00。验证：UTC对应、非法cron/时区启动拒绝、正式Scheduler注册/health类型及原Date时间传递通过。
- [x] 4.2 实现整个schedule生命周期不重叠、双实例唯一slot、稳定运行身份、ownership/fencing及skip/once；不启用逐个backfill，已有未完成运行必须恢复。验证：两jobs、跨slot长任务、失去执行权/旧worker、停机多个周期once只补最近一次、skip已有运行恢复的PG场景通过。
- [x] 4.3 接TaskHealth/A Node readiness：真实backend+consumer探测，未装配unavailable、故障down，成功五分钟heartbeat写jobs.lastCronAt；前置失败不推进，超过10min/no record时503/no-store。SIGTERM停止领取并保留可恢复状态。验证：实际web health、成功/失败/停摆、queue未装配/消费者故障与优雅/强制退出恢复通过；各schedule可查询结果，日志无payload。

本批 B 4.1–4.3 按协调者任务说明只交付平台侧能力与测试，不修改并行组 5 的入口文件。
Node jobs 仍待组 5 在 engine.register 中注册 handler 并 await scheduler.prepare，launch 后
启动 scheduler；shutdown 停止 queue/scheduler 领取，再关闭 engine 与业务池。Node web
readiness 仍待组合 TaskHealth 和 DB 探测并接入平台健康响应；五分钟业务前置 handler 用
createNodeCronHeartbeat 包装，五条 UTC 业务映射归 5.2。实际 apps 入口/Compose/服务器
健康验收留后续，不以本批真实 Node HTTP fixture 代替。只勾选本批平台范围，不勾 5.x/6.x。
4.1–4.2 已通过隔离 PG 时区/defaults、双实例/长任务、真实秒级停机 skip/once、SIGKILL/
SIGTERM、claimed-before-publish 和成功 checkpoint 后 ledger 写入故障恢复；恢复使用固定版
DBOS 的公共 rewind 保留成功 step，同 run/workflow 身份与原计划 Date 不变。
4.3 平台健康单测 12 项、真实 Node HTTP 成功/前置失败/缺失/陈旧心跳通过；独立实时时钟
停摆测试等待 601 秒（用例 601.58 秒）后仍显示 2026-10-12T16:57:37.783Z 的旧心跳，
返回 503/no-store。全仓 check/check:deps/check:singletons/dedupe --check/typecheck/test/build
与 OpenSpec strict 全部通过；以上不改变前述尚待 apps 入口接线和部署验收的边界。

## 5. Phase 2：既有业务移植

依赖A相关适配与2–4；媒体对象存储依赖C。复用现有业务测试，两目标共享行为用例，仅补真实平台故障风险。

- [x] 5.1 将email/events生产消费接A Queue接口和Node adapter，保留requestId/幂等键、邮件错误分类、billing/operations逐消息处理；有效不可重试/耗尽失败先DeadLetterSink持久记录再确认，CF保留原行为。验证：email-queue/billing.unit/operations.unit及web队列测试两目标通过，暂时失败/无效/耗尽符合规格。
- [x] 5.2 注册五条既有UTC Cron，移植billing、删除缓存补偿、文件/空间清理、metrics与heartbeat；保留ai_message/ai_task hold注册及独立子任务失败策略。验证：现有jobs/billing/files-cleanup/metrics/workspace测试通过，五条映射齐全；metrics补跑使用原scheduledAt前一UTC日，重复upsert不累计。
- [x] 5.3 解耦media-runner的CF step/telemetry，由Node外壳注入A DB、C storage、既有Provider和正式WorkflowStep，CF wrapper复用runner。验证：media-workflow/media-settlement/media-hold-sweep两目标通过，丢提交响应不重提、check/recheck/轮询/硬截止、确定性产出及结算幂等不变。
- [x] 5.4 将web create/get/instance.status/sendEvent/terminate接正式Workflow，保留创建失败退款、回调先落库且通知失败仍200、取消先释放/落终态及停止失败可恢复。验证：ai-media-tasks/跨绑定smoke、Node重启/晚回调/取消后恢复不重复扣费；CF不依赖Node引擎。
- [x] 5.5 提交Node jobs注册/扩展指南，含中立接口、事务API、队列配置、UTC/Singapore、版本与pool/shutdown约束。验证：隔离目标按指南新增任务可运行，关闭billing/credits/AI时不注册对应业务handler且jobs/heartbeat可启动；文档无外部本机路径。

## 6. Phase 2：集成与部署验收

依赖1.10与2–5全部实际完成、A可运行、C相关能力可用；spike不能替代以下正式验收。只做集成检查，不提前勾选服务器/外部凭据或main发布。

- [x] 6.1 本地Docker需求验收第4项：Asia/Singapore、双jobs、跨slot长任务及skip/once/恢复。验证：UTC计划/实际时间、唯一运行、无重叠、真实web health heartbeat证据入报告。
- [x] 6.2 本地Docker需求验收第5项：实际业务Drizzle回滚零执行、策略6次重试/DLQ、真实批次与双worker全局限额。验证：完整尝试时间轴、DLQ、确认前/发布窗口故障、跨worker竞争及无超限入报告。
- [x] 6.3 本地Docker需求验收第6项：真实1–2h采集替身流水线，列表→事务额度/限流批次→详情→归并→汇总；成功步骤后及sleep/wait重启、60+min早到事件、副作用checkpoint窗口。验证：同业务身份、已成功callback计数不增加、原deadline和幂等输出/结算，固定版本和开始/结束时间记录。
- [ ] 6.4 新加坡Linux重复第4–6项，合并A全服务预算并在整机2核4GiB下测web/PG/cache/代理/双jobs、连接/WAL/journal及余量。验证：完整SHA、脱敏版本/限额、时间轴/恢复/死信/资源通过；服务器或配套未就绪时保持未完成，不用本地spike冒充部署验收。
- [ ] 6.5 集成后openspec strict、pnpm check/check:deps/check:singletons/dedupe --check/typecheck/test/build全部通过；Node适用集成与CF既有用例通过，CF bundle无Node引擎依赖。A真实Compose auth e2e依赖门解除后验收；main自动staging/health回归由协调者执行，不手动部署本分支或以构建替代部署验收。
