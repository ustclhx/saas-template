# Tasks

本轮仅提案，所有实施项保持未勾选。按 docs/09 §3、§6 派发；同一任务组中的共享文件由唯一 owner 修改，其他 worker 只提交各自模块。所有任务均在隔离 worktree / 临时数据库验证，不使用 staging 凭据。

实施波次：1 →（2 ∥ 3）→ 4 的模块批次 →（5 ∥ 6 ∥ 7，按文件互斥）→ 8。第 9 组等待 B 合入；A 不提供临时队列，9 未通过前不能宣布 A 全部完成。组 4 可按独占目录并行，但共享 server/env、manifests、lockfile、generated 配置、AGENTS/checker 由协调者串行整合；Node entry 属于组 5，组 4 不重写构建入口。B 对 platform/node 的引擎文件由 B 独占，A 只写基础 adapter，不互改 B tasks。C/D 尚未实施的能力明确列入剩余验收，不提前勾选。

## 1. 能力契约与工程边界（协调者串行）

- [x] 1.1 新增 packages/platform 中立契约和显式 Cloudflare/Node export，落实 platform 可依赖 shared/config/db、db/config 不反向依赖 platform；与 B 记录 queue/事务入队/workflow/step/scheduler/health 的接口交接。验证：平台契约类型检查、pnpm check:deps、无循环，B spike 能在不导入引擎类型的情况下接入；文档记录签收接口与能力缺失策略。（R2）
- [x] 1.2 扩展 scripts/check-deps.mjs（或专用检查）覆盖 apps/packages 的 cloudflare:* 静态/动态/export/require 导入及明确入口例外；添加精简正反例并同步 AGENTS.md、docs/01 与 docs/02 的依赖说明。验证：检查器拒绝 routes/features 的违例且允许平台 CF entry/目标测试，pnpm check:deps 通过。（R2）
- [x] 1.3 提供现有 CF env、db、KV、限流、waitUntil、请求元数据与 queue/workflow/scheduler 的 adapter；保留 retry、事件等待和原 UTC cron 行为，Node 任务能力仅定义/报告 unavailable。验证：现有 Worker handler/邮件/媒体 runner 测试通过，Node 能导入中立入口且不加载 cloudflare:*；能力用法文档与 B 交接一致。

## 2. 配置与数据库生命周期（config/db 独占）

- [x] 2.1 实现 config 按目标 schema、Node dotenv/env/file 密钥加载和启动校验，保留 payment/可选集成降级；补文件冲突/不可读/空值及脱敏的重要边界用例，更新运行时配置文档。验证：config 测试和类型检查通过，非法必需配置在 listen 前非零退出，值不进入日志或前端。（R3、R4）
- [x] 2.2 扩展 createDb 的 Hyperdrive/string/Sql 输入与资源所有权；Node 复用有界 app 池，退出关闭自有池，CF 保留请求客户端。验证：db 现有测试与 Node 实库用例通过，连续请求连接数量受池上限约束、关闭借用 facade 不终止共享池；记录池预算及 shutdown 用法。（D1）
- [x] 2.3 为 Node 配置现有 db 业务集成测试，复用事务、FOR UPDATE、advisory_xact_lock、回滚、scoped/账本并发关键场景。验证：隔离 PG17 运行用例，提交/回滚释放锁且无 idle-in-transaction，不修改原断言、不提交 worker 迁移 SQL。（D4）

## 3. Node 基础适配器（platform/node 独占）

- [x] 3.1 实现 Valkey KV 与原子 fixed-window rateLimit，共用命名空间/用途前缀与三策略配置；补跨客户端计数、TTL、删除及故障关闭集成用例，记录缓存配置。验证：实际 Valkey 上两个客户端共享限额、到期/删除行为正确、不可达返回 503，不退回内存。（C1、C2）
- [x] 3.2 实现 TCP peer + trusted CIDR 的 IP 解析、应用 requestId 和可选 cfRay；补恶意 XFF、多层代理和无 cf 头的边界验证，记录 ingress 信任配置。验证：伪造转发头不能影响防刷 IP，响应日志 requestId 一致。（H2、H3）
- [x] 3.3 实现 waitUntil 任务跟踪与有界 drain（不实现持久队列）；补请求/客户端结束后完成、rejection 脱敏、SIGTERM 完成/超时用例，记录正常运行与 crash 限制。验证：任务注册后无 unhandled rejection，shutdown 在上限内结束且先排空后关 DB/cache。（A1、R6）

## 4. 按模块迁移业务平台调用（依赖 1–3，可按子项独占并行）

- [x] 4.1 auth/workspace owner：迁移 packages/auth 与 apps/web/features/auth、workspace 和 auth/workspace API 的 env、KV、IP、rate 类型与调用；保持实时会话校验、异步发信与可选 Turnstile。验证：相关 CF 测试及 Node auth DB/cache 集成通过，关闭 Turnstile 不要求其密钥且仍限流；更新认证适配文档。共享 server/auth*.ts 由协调者合入。（R2、C1、C2、H5）
- [x] 4.2 billing/credits/admin owner：迁移相关业务包与 web 计费、后台 features/routes 的 env/db/cache/queue 调用，保持 adminAction 与账本边界。验证：既有支付、积分、后台权限测试及对应 Node 非队列业务测试通过，无迁移副作用、无直接 CF 导入；记录本批验收与依赖 B 的测试。（R2、D4）
- [x] 4.3 AI owner：迁移 packages/ai 与 web AI/API v1/chat 的 env、限流、waitUntil、workflow 类型与调用；保留预算/检查点/媒体业务 runner 契约。验证：既有 CF 聊天/媒体用例和 Node 文本业务用例通过，依赖 B/C 的媒体任务未伪验收；不修改组 6 的模型出口工厂。（R2、A1、A3）
- [x] 4.4 storage/growth/public owner：隔离 packages/storage 的 R2/FixedLengthStream 细节为 CF 专用入口，迁移 web files/growth/公开页/i18n 的 env 访问；Node 未装配 C 的文件能力明确拒绝。验证：CF 文件与公开页测试通过，Node 无 DB 公开页预渲染正常、文件不可用时无预扣/假成功；文档标明 C 接口。（R2）（经协调者确认：本批验证中立公开页无 DB 降级与 CF 实际预渲染；Node 生产无 DB 预渲染留组 5 验收。证据见 docs/runbooks/selfhost-a4-storage.md。）
- [x] 4.5 jobs owner：迁移 apps/jobs 的 queue handlers、cron、media-runner 为中立能力与类型，Cloudflare WorkflowEntrypoint 留 CF entry，Sentry capture/tag 使用可注入观测边界（Node 暂为共享日志）。验证：jobs 现有 CF 测试全部通过，cron 独立任务失败仍遵循 allSettled，Node 可加载业务 handler 不加载 Workers/Sentry CF 包；记录 B 接入位置。（R2）
- [ ] 4.6 协调者整合 apps/web 的 server/middleware/auth/env、start 与其余 routes 的调用及 Cloudflare composition entry，清除残留业务 Workers 全局类型；同步 manifests 与 lockfile。验证：全量 cloudflare:* / Cloudflare.Env / binding 类型定向扫描只剩允许位置，pnpm check:deps、check:singletons、dedupe --check、双目标类型检查通过。（R2）

## 5. Node 生产构建、启动与 CI（apps 构建/入口与 CI 独占）

- [ ] 5.1 在现有 Start/Vite 版本上锁定兼容 Nitro，新增独立 vite.node.config.ts、server.node entry 和 build:node/start:node；复用生成/预渲染选项，保留 CF 默认配置。验证：Node SSR、Server Function、静态资源与流式 smoke，无生产凭据/DB 的预渲染通过，CF build 产物不变；补文档记录确切 adapter 版本。（R1、R5）
- [ ] 5.2 新增 jobs Node ESM 输出与 entry，装配 config、池、缓存、内部 liveness 和 shutdown，B 未合入时 queue/scheduler unavailable；外置原生模块依赖。验证：生产 Node 入口可运行及优雅退出、无 workerd/Cloudflare 专用依赖、未执行临时队列或 cron；记录 R6 无平台 CPU 上限与业务超时边界。（R1、R5、R6）
- [ ] 5.3 新增独立 Node Vitest 项目与 build/test CI job，临时 PG17/Valkey，按需复用业务用例；区分输出与 Turbo cache inputs/outputs，保留 CF workers-pool/check/e2e-smoke/staging。验证：CI 同时通过 CF 和 Node 构建/单元测试，Node 基础集成不跳过，缓存不能串目标，Node job 无 staging secrets/部署步骤；文档列出实际命令。（P6）

## 6. 文本 AI 出口与能力（模型工厂独占，4.3 后）

- [ ] 6.1 文本模型工厂增加管理员配置的 OpenAI-compatible direct base URL/key 与显式可选 Gateway，保留 CF BYOK。验证：已有 Gateway 夹具和新 direct 请求夹具通过，直连无 cf-aig 头或占位 key、无 Gateway 凭据也可用；更新 AI 配置文档。（A2）
- [ ] 6.2 在 Node 能力表与模型/后台 UI 过滤 Workers AI，直接调用在预扣前拒绝；CF 保持原可用性。验证：隐藏与直接提交无副作用的关键用例通过，CF Workers AI 测试保持；记录能力降级。（A4）
- [ ] 6.3 复用定价/预算/结算测试覆盖两出口正常 usage、per_call、超额、停止/错误估算封顶与 Node 客户端断开后的完整结算。验证：账本金额及终态一致、重复结算不重复扣费，Node 生产 HTTP smoke 证明断开不取消服务端读流；补目标差异验收说明。（A3、A1）

## 7. Compose 与 Dockerfiles（deploy/selfhost 独占，infra 共享改动协调者整合）

- [ ] 7.1 定义 web/jobs/migrate 多阶段 Dockerfiles、无凭据 build context 和完整 SHA 固化，Node 使用非 root Debian 运行层；定义 PG/Valkey/代理镜像的非 root 卷权限策略。验证：开发机/CI 构建产物、原生模块加载 smoke、无 Git 且无合法 SHA 构建失败；镜像配置/文件层无凭据，初始化 UID 非零。（R1、R4、R5、H4）
- [ ] 7.2 新增 image-only compose.yaml 与 env/secrets 示例，postgres17、valkey、migrate、web/jobs、可选 Caddy，健康依赖、资源上限、常驻 restart、migrate 退出语义、滚动日志、持久卷及停止宽限期。验证：docker compose config 无 build、只有代理 ports、全部 service 非 root/health/resource/logging 参数齐全；文档展示普通 up 命令与 D 镜像前提。（D3、D5、H4、O1）
- [ ] 7.3 复用 infra 角色/授权脚本，安全读取挂载密码、保留 default privileges 和 audit 写保护，明确容器间 PG TLS/证书配置且不沿用 local 固定密码。验证：空卷非 root 初始化、migrator SQL 迁移、app DDL/audit 修改被拒绝、readonly 写被拒绝；迁移失败时应用不启动；文档说明 secret 分配。（D2、D3、D4）
- [ ] 7.4 配置 Caddy profile、非 root 8080/8443→80/443、ACME/自带证书、专用 ingress/trusted CIDR 与证书卷；env 示例启用 profile 以兼容普通 up 命令。验证：两种证书模式可访问（ACME 需可用测试域名时才勾选）、data 服务无宿主机 ports、恶意 XFF 不能覆盖客户端 IP；文档说明外部代理模式和 D 的 Dokploy/Traefik 接入边界。（H1、H2）

## 8. 健康与基础集成（server/health 独占，5/7 后）

- [ ] 8.1 扩展 health 的 Node db/cache/queue/scheduler 探测接口、完整 SHA 和 lastCronAt；保留 CF 响应与实时无缓存探测；区分进程 liveness 和依赖 readiness。验证：CF health 原测试通过，Node 200/503 都含完整 SHA、缓存失败或 B 未装配为 503/unavailable、不泄漏主机/凭据；更新探活文档。（O2）
- [ ] 8.2 空卷 Compose 基础验收：迁移顺序、web/jobs 可运行、Node DB/Valkey 集成、非 root、资源/log rotation、外部仅代理 80/443、容器重启保留数据。验证：记录 compose config/ps、UID、权限、health SHA 与日志轮转证据；B 未合入的 queue/scheduler readiness 503 如实记录，不宣称 auth e2e 通过。
- [ ] 8.3 完成根 pnpm check、check:deps、check:singletons、dedupe --check、typecheck、test、build 与新增 Node build/test，复核默认 CF e2e-smoke/自动 staging 发布未削弱。验证：CI 与合入后 main 自动 staging run/health 完整 SHA 证据；不手工部署分支到 staging，未获得合入后证据保持待办。（P6）

## 9. B 合入后的尾部验收（明确依赖门，不属于 B 引擎实施）

- [ ] 9.1 B 合入且其 Postgres 引擎验收通过后，在 Node composition 装配真实 queue/workflow/scheduler，替换 unavailable 探测并保留同一接口；不得在 A 实现 B 后端。验证：真实邮件批量 ack/retry、Node 最终有效消息失败经 B hook 进入持久死信且不提前 ack/drop、CF 保持原 drop 行为、后台心跳、health DB/cache/queue up 与完整 SHA，缺失/停摆消费者或 Cron 返回 503，B 所需权限不越过三角色。（O2）
- [ ] 9.2 在隔离 PG/Valkey 上运行 Node 全部适用单元与业务集成测试（含依赖 B 的用例），CF 专属适配器用例仍在 CF 运行，C 尚未实现的文件/媒体验收列为独立范围。验证：记录目标测试矩阵、测试数与跳过理由，无队列相关用例被隐藏、无弱化断言。（P6、A3）
- [ ] 9.3 在开发机全新 Compose 卷，真实 B 队列+测试邮件 sender、关闭 Turnstile、开启 requireEmailVerification 与 multiTenant：注册→验证邮件真实送达→验证→真实 sign-out→密码登录→创建/切换团队和个人空间。验证：Node 生产输出 Playwright auth e2e 通过、页面/会话/权限正确、健康完整 SHA；不读取 DB token 替代邮件链路、不把日志邮件内容开放给生产；编写本地验收 runbook并记录证据。
- [ ] 9.4 汇总 A 分配需求与剩余 C/D 交付，协调者确认 B 依赖已满足和全部 A 验收通过。验证：本 change 全部对应项有证据、openspec validate add-selfhost-foundation --strict 通过；不提前勾选部署/外部凭据验收，不由 worker 归档。
