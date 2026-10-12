# Design

## Context

动机与需求 ID 见 [proposal](proposal.md)。以下是对本 checkout 的观察，不把源需求中的文件计数当作当前事实：

- `apps/web/vite.config.ts:64` 起用 Cloudflare 插件接管 SSR，并依赖其 preview 预渲染；`apps/web/src/server.ts` 是 Workers fetch / Sentry / env 入口。installed `@tanstack/react-start` 为 1.168.60，`@tanstack/start-plugin-core` 为 1.171.49，Vite 为 8.3.2；Start 的 server schema 支持 entry / build，没有旧式 `server.preset`。
- `packages/db/src/client.ts:15` 每次创建 postgres.js 客户端（max 5、prepare true、fetch_types false）；`apps/web/src/server/health.ts:43` 依赖 workerd 请求结束回收，不能直接移植到常驻 Node。
- `packages/config/src/env.ts` 的共享 schema 当前强制 HYPERDRIVE；web 的扩展 schema 强制邮件队列、缓存与限流。认证 KV、Queue 和媒体 runner 仍使用 Workers 全局类型，即使业务 package 没有直接 `cloudflare:*` import，也不能宣称类型已中立。
- `scripts/check-deps.mjs:29` 规定 shared 无内部依赖、config 仅依赖 shared、db 仅依赖 shared/config；目前只对 packages 扫描 import。`docs/02` 的更宽泛依赖描述与检查器不完全一致，实施需同步文档与 AGENTS。
- `infra/local/initdb/01-roles.sql` 与 `02-db-grants.sql` 已提供三角色权限，local 角色密码固定用于开发，生产不能照抄；`infra/postgres` 已有容器初始化与权限参考。
- `.github/workflows/ci.yml` 在临时 PG17 上跑 Cloudflare 集成测试与独立 workerd 冒烟；main 的 staging 流水线仍按迁移 → jobs → web 发布。现有认证 e2e 的服务启动、邮件捕获与绑定注入都依赖 Miniflare。
- 现有 `runtime-config`、`system-health` 的平台特定文字须以本 change 的 MODIFIED delta 演进；user-auth 的异步邮件及 workspace-tenancy 的权限与空间语义保持不变。

## Goals / Non-Goals

**Goals:** 能力契约中立且可按构建目标隔离；保留 Cloudflare 请求生命周期，正确引入 Node 池与停机生命周期；使 B 能依契约 spike，分离基础验收与依赖 B 的完整验收。

**Non-Goals:** 不在 A 选择任务引擎或实现 Node 队列/Workflow/Cron，不重写账本或业务逻辑，不新增 S3/SMTP/Sentry Node，不发布镜像或配置服务器/Dokploy。详细分工见 proposal Non-Goals。

## Decisions

### 1. 平台 package 的依赖和装配（R2）

采用 `packages/platform`，导出目标中立契约和显式 `./cloudflare`、`./node` 入口；业务只导入中立入口。不做万能 env 仿真器，不在业务中散布 target 判断。Cloudflare 入口可使用 Workers SDK / binding 类型；Node 构建的依赖图不得包含它们。

依赖方向为 `shared ← config ← db` 保持不变，platform 可依赖 shared/config/db，业务包和 apps 可依赖 platform；**db/config 不反向依赖 platform**。db 的连接输入是 postgres.js Sql / string / 原有 Hyperdrive 结构，platform 的 db 契约返回 Database；schema/ORM 仍归 db，避免循环。

app 的 composition root 创建适配器并注入业务上下文。Cloudflare 每请求/事件装配并保留原 binding 引用；Node 启动装配进程资源，通过请求上下文（AsyncLocalStorage 或显式参数，优先复用现有 TanStack middleware context）传入 env、请求元数据、waitUntil。共享入口不读全局 process.env、不缓存 Cloudflare I/O；浏览器不得导入 Node 或 Cloudflare 服务端入口。

| 能力 | 最小契约 | Cloudflare | Node |
|---|---|---|---|
| env | 只读已校验标量配置 + 能力可用性；取值不是原始 bindings | schema 校验 vars，入口封装 bindings | 启动读取 dotenv / env / file 并校验 |
| db | 业务连接与只读公开数据连接；migrator 仅专用任务入口 | 每请求 createDb，保持 Hyperdrive cached / uncached 区分 | 每进程持有 app 池；公开数据可共用 app 池（不引入查询缓存）；迁移独立池 |
| kv | get text/JSON、put（秒 TTL）、delete | KV 序列化与现有 TTL 下限封装 | Valkey GET/SET EX/DEL，同一环境/用途键前缀 |
| rateLimit | limit(policy, key) → success；policy 为 auth / ai / api | 转发 RL_AUTH / RL_AI / RL_API | 同一 Valkey 的原子窗口计数 |
| waitUntil | 注册 Promise，运行时负责异常记录与排空 | ctx.waitUntil | 进程任务集合及有界 shutdown drain |
| clientIp | 从请求及传输层 peer 推导可空 IP | cf-connecting-ip 由 CF 入口提供 | 可信代理验证后解析 XFF |
| requestId | 新请求 ID + 可选 cfRay | 应用生成并附带 cf-ray | 应用生成，cf-ray 仅作附加诊断字段 |

`cloudflare:*` 禁令覆盖 apps 和 packages 的生产源码，包括 import/export、动态 import、require；只允许平台 Cloudflare 目录及显式列出的 app Cloudflare composition entry。cloudflare:test 只在目标测试配置/夹具中例外，不向业务开放通用豁免。Workers 全局能力类型也逐模块替换为契约，Node tsconfig 不依赖 worker-configuration 生成声明。检查器具备正反例以保证绕过无效。

C 延后的能力不拖延 R2：A 将 R2 binding 获取放在 CF composition root，业务继续调用 packages/storage 的既有封装；存储 package 中的 R2 类型/FixedLengthStream 等平台细节隔离为 Cloudflare 专用入口。Sentry Cloudflare 包装器也只在 CF entry 导入。Node 暂不装配文件/媒体存储或 Sentry；相应入口明确不可用，在预扣/写文件前拒绝，不提供假成功适配器。C 接入 S3/Node Sentry 时复用原有业务接口，不在 A 建造 S3 后端。

### 2. B 对齐的任务契约与交接

A 拥有中立接口定义和现有 Cloudflare 适配；B 拥有 Node 引擎实现、持久化 schema、spike 与引擎验收。接口以能力拆分，不能把 DBOS / pg-boss 的对象暴露给业务。A、B 在实施首波先合入契约；B spike 可针对此结构写原型，发现不满足时由协调者更新两份设计，不静默更换接口。这里的 Q/J/W 条件是交给 B 的兼容约束，并非 A 宣称实现。

- **QueueProducer<T>**：send(body, {delaySeconds?})、sendBatch([{body,delaySeconds?}])；按队列配置 retry/backoff/concurrency/rate。消费端批量消息包含稳定 id、body、attempts、ack()/retry({delaySeconds?})；未 ack 的消息失败重投、达到上限保留死信。消费结果须能区分成功/无效消息确认与最终投递失败；B 提供持久 dead-letter sink 接收耗尽/不可重试的有效消息，不能沿用邮件 handler 的 ack/drop 而丢失 Q1 证据。CF adapter 保留原丢弃行为；Node handler 的终态失败 hook 由 B 接入。处理器可幂等处理至少一次投递（Q1/Q3）。
- **TransactionalEnqueue<T>** 单独能力：enqueue(tx, body)，tx 使用 db 已存在的事务类型（对外不暴露引擎连接）；B 必须通过同一 PG 事务或 outbox 保证回滚不投递（Q2）。Cloudflare QueueProducer 不谎称支持此能力；不要把普通 send 作为等价事务入队。A 不向现有 CF 业务要求新事务能力。
- **Workflow<P>**：create({id?,params})、get(id)；instance 的 status()、terminate()、sendEvent({type,payload})。状态归一为 queued/running/paused/waiting/completed/failed/terminated；CF complete 等映射到中立枚举。缺失实例、终态发事件为明确错误，不吞掉。稳定业务 id（媒体为 task.id）、JSON 可序列化参数/结果。
- **WorkflowStep**：do(name, callback) 或 do(name,{retries:{limit,delayMs,backoff},timeoutMs},callback)、sleep(name,durationMs)、waitForEvent(name,{type,timeoutMs})。共享 NonRetryableError 转换到各引擎；现有媒体 runner 的重试、截止时间与终态检查保留。B 保证成功步骤结果持久化、重启续跑、事件按 type FIFO 单次消费、事件早到至少保留 60 分钟（W1–W3）；流和二进制不跨 step 持久化。
- **Scheduler**：注册 `{id,cron,timeZone,missedRun:'skip'|'once'}` 与 handler；执行上下文有 scheduledAt，探测接口读 lastCronAt。B 实现 jobs 内调度、锁互斥、明确补跑、原有五条 cron 和 heartbeat（J1–J3）。CF 映射 scheduled handler，保留现有 UTC triggers，不要求 CF 原生新增任意时区调度能力。
- health 能力返回 queue `{status:'up'|'down'|'unavailable'}`、scheduler `{status,lastCronAt}`；Node 没有装配 B 时返回 unavailable，绝不能将 DB 可达推断成队列正常。

**邮件缺口选择：完整 e2e 延后到 B。** 临时 in-process queue 会丢信、无可靠重试且进程重启丢工作，违背现有 user-auth 的异步邮件规格，增加删除成本。A 先提供能构建/运行并报告依赖未就绪的 jobs Node 进程，不执行 cron 或伪消费。Node 单元/基础集成在 A 验证；真实 queue-dependent 集成与注册→验证→退出→登录→切换空间的 Compose e2e 是 A 的尾部任务，B 合入前不勾选、A 不宣称全部验收完成。测试可注入捕获邮件的 sender，必须经过 B 的真实持久队列，不以读取 DB 验证 token 替代发信链路。

### 3. Node 输出与构建隔离（R1/R5/R6/P6）

2026-10-12 核查的 [TanStack 官方 hosting 指南](https://tanstack.com/start/latest/docs/framework/react/guide/hosting) 支持 Vite 中接入 `nitro/vite`；Node / Docker 启动 `.output/server/index.mjs`。选择新增、锁定经当前 Vite/Start 验证的 `nitro` 依赖，采用 [Nitro 官方 Node preset](https://nitro.build/deploy/runtimes/node) `node_server` 输出，独立 `vite.node.config.ts` / `build:node` / `start:node`，不写不存在的 tanstackStart server.preset，也不迁移框架。确切版本通过首个构建兼容验收锁入 lockfile。

复用 Tailwind、文案、content collections、OG 与预渲染选项；抽取这些共用构建部分时保留默认 CF 配置语义。CF-only prerender env fallback 不进入 Node；Node 构建期不启动生产校验/连接池、不读取生产凭据，根布局/定价快照保留 DB 不可达降级。输出目录与 Turbo cache key/outputs 区分目标，避免 dist 相互覆盖或缓存把 Worker 产物交给 Node。

jobs 新增 Node entry 与 ESM 构建（复用现有 TS 工具链、外置原生依赖），共享消费者/cron/runner 仍复用业务 handler；CF entry 继续导出 WorkflowEntrypoint 与 queue/scheduled。Node entry 包含启动校验、进程资源、内部健康端点与 shutdown；B 后续装配引擎。选 Node 22 LTS、最低 22.12（当前 React Start engines 要求；与 CI 22 主版本一致），镜像使用 Debian 基础以允许原生模块；不把原生依赖送入 CF bundle。Node 不设置 Workers CPU/响应后 30 秒上限，只执行现有业务 timeout、依赖探测 timeout 与停机 deadline。

### 4. config、连接池与缓存（R3/R4/D1–D4/C1–C2）

config 提供按目标区分的 schema，CF binding 校验仍在首请求/事件之前，Node 在 listen/启动引擎前校验所需项。PAYMENT_MODE 的缺失策略仍由支付入口判定，不能让支付缺凭据阻断公开页/认证。可选 AI/支付/Sentry 功能保持现有「不可用+变量名告警」，不是把所有可选 key 变为全局必填。

Node `.env` 在运行时读取，进程 env 优先；只对 schema 声明的密钥支持 `NAME_FILE`，与 `NAME` 同时提供时报冲突（不猜优先级）。文件只去掉一个末尾换行，缺失/不可读/空值报字段名，不打印值/路径/驱动错误。Compose env_file 不做 shell source；_FILE 由应用解释，挂载只读 secrets。不得在 Vite define / VITE_*、Docker ARG、镜像层或缓存中携带真值。运行时 setting、模板功能开关、密钥归属仍三层分离。

`createDb` 保留 Hyperdrive 重载，增加 string / postgres.js Sql 输入；Node app 池在启动创建，按请求创建 Drizzle facade 或复用无请求状态 facade，但不每请求新开池。string 模式的池由显式 owner 关闭；借用池不得由 facade 关闭。web/jobs 独立有限池（建议各 max 10，迁移 max 1，可配置）；总连接预算必须与 PG 上限匹配。shutdown 顺序为停止接收请求/引擎 → 排空请求及后台 Promise → 关闭缓存与 SQL 池。CF 不全局持有 pool、不调用已知 workerd 有问题的 sql.end。`prepare:true`、事务、FOR UPDATE、advisory_xact_lock 与 scoped 查询不变。

Valkey 为独立服务，web/jobs 使用同一命名空间，认证/setting/model cache 与 rate keys 分前缀。KV 保留 string/JSON 行为和秒 TTL；CF 侧保持现有最低 60 秒处理，Node 可精确秒级过期。限流选择简单原子 fixed-window Lua（计数与首次 TTL 同一操作），按 policy / key 独立、跨 web 实例共享；保持现有键维度、限额和周期，不承诺复制 CF 的机房分布与最终一致性。额度/积分继续以 PG 为准。Valkey 不可达时认证/AI/API 返回可辨识 503，不能自动放行或退回内存防刷。

### 5. HTTP 信任与后台延续（H2–H5/A1）

Node 入口取得真实 TCP peer，TRUSTED_PROXY_CIDRS 默认空；只有 peer 可信才读取 XFF，从右向左跳过可信代理取得第一非可信地址。非法链退回 peer，不能取无验证的最左项、不能信任任意公网或全部 Docker 网段。部署示例约束 Caddy / Traefik 所在专用 ingress 子网，剥离/覆盖客户端可控转发头；不开放 app 直连端口。APP_URL 为公开 HTTPS 地址，保留 Secure Cookie / origin 校验。requestId 每请求生成并贯穿 JSON 日志/响应；cf-ray 仅附带，不能作为认证或唯一 ID。

Turnstile 开关仍属于 template.config；Node 缺 site key/secret 仅在启用时失败，关闭后不渲染组件、不调用 siteverify，但认证 rateLimit 继续有效。

Node waitUntil 持有任务集合，注册即处理 rejected Promise 并通过 shared/log 记录；stream response 的取消仅关闭客户端输出分支，不能取消服务端 consume/usage/settle。Nitro 的 shutdown hook 必须接入同一 drain，关闭顺序不能由默认强制退出抢先终止结算；其强制超时与应用 deadline 对齐。SIGTERM/SIGINT 停止接新请求，等待 active requests + 后台集合（默认 drain 30s，可配置），超时记录未完成数再释放资源退出；Compose stop_grace_period 大于此 deadline。正常运行不因响应结束加 30s 取消。它不具备 crash durability；持久任务交给 B，现有 hold/checkpoint 回收保护仍保留。

### 6. AI 出口（A2–A4）

文本模型工厂接收出口配置：默认 CF 保留 Gateway / BYOK；Node 默认 direct，通过 `OPENAI_BASE_URL`（完整 API base）和 `OPENAI_API_KEY` 配置 OpenAI 兼容 provider，模型 id 使用既有注册表 providerModelId。其他既有原生 provider 继续原来的工厂路径；不新增供应商 SDK。Gateway 显式开启时才要求 account/id/token，direct 不发 cf-aig 授权头，不把占位 key 转发。直连端点属于管理员配置，不接受请求体任意 URL。

输出 factory 变化不触碰 pricing snapshot、budget、hold/capture/release、usage checkpoint 或权益。两种出口使用同一流式执行/结算测试覆盖正常 usage、per_call、超额、停止与客户端断开。Node 能力表缺 Workers AI 时，不渲染 workers-ai 模型/后台选项，直接提交在预扣前拒绝；CF 保持 binding 配置与同步媒体路径。

### 7. Compose、镜像结构与非 root（H1/H4/D2/D3/D5/O1）

官方入口为 `deploy/selfhost/compose.yaml`，部署目录包含无真值 env example、Caddy 配置与 web/jobs/migrate Dockerfiles；镜像字段由镜像引用变量指定，**Compose 无 build 字段**。A 在开发机/CI 构建这些 Dockerfiles做结构验证；镜像推送、多架构与 Dokploy 配置全归 D。正式 plain `docker compose up -d` 的前提是填好 env/secrets 与可拉取镜像，A 不声称在 D 前已有公开镜像。

| service | 启动依赖 / 检查 | 网络/持久化 |
|---|---|---|
| postgres | PG17 非 root；pg_isready | data 网，data 卷；无 ports |
| valkey | 非 root；PING | data 网，Valkey 卷；无 ports |
| migrate | postgres healthy；migrator 执行现有 SQL migrations，退出 0 | data 网；无 ports；restart: no |
| jobs | migrate service_completed_successfully + valkey healthy；内部进程探活 | data 网，有出站能力；无 ports |
| web | 同上；内部 liveness，外部 /api/health 为 readiness | ingress + data；无 ports |
| caddy（profile） | web 启动；本机代理状态检查 | ingress，证书/config 卷；仅此服务 ports 80/443 |

常驻服务 `restart: unless-stopped`，migrate 是一次性例外，不能自动重跑失败迁移。所有服务有 healthcheck、mem_limit/cpus、logging json-file max-size/max-file；服务资源总预算按 2 核 4GB 起步，具体默认值在 Compose config 校验中列出。健康检查内部 liveness 证明 Node 进程可运行，**不替代外部 readiness**；无 B 时依赖健康 unavailable 的进程不进入不停重启循环。

Caddy 可选 profile `caddy`；独立部署 env 示例设置 `COMPOSE_PROFILES=caddy`，因此用户仍执行普通 `docker compose up -d`；不用 Caddy 时由外部代理接入 ingress。Caddy 非 root 监听容器 8080/8443 映射宿主机 80/443，无需 root 绑定低端口；ACME HTTP challenge 仍经宿主机 80，自带证书只读挂载，证书持久化。

PG/Valkey 数据目录及 Caddy 可写卷在镜像阶段预设非 root UID/GID 和所有权；首次空 named volume 复制 image 目录权限，初始化和正常运行均非 root，不靠 root init 容器。reuse infra 脚本时保留 grants / default privileges / audit 约束，生产角色密码从挂载 secret 经安全 stdin/变量传入，不沿用 local 固定值；必要的运行时凭据参数化属于 A 的角色复用，不包含 D 的主机初始化脚本。bootstrap 超级用户 secret 只给 postgres，migrator secret 只给 migrate，app secret 只给 web/jobs，readonly 不交给应用。既有 `infra/postgres/pg-entrypoint.sh` 含 chown，不可直接当非 root 入口复用；A 将复制证书改为目标非 root 用户可写目录中的普通 copy/chmod，并要求挂载源可读。保留 PG hostssl-only 策略，web/jobs/migrate 经 TLS 直连并验证挂载 CA 与 postgres 服务名，证书/私钥运行时挂载，不进入镜像。验证空卷初始化 UID、TLS 和权限，不通过扩大 PG 权限让 B 工作；B 引擎建表走 migrator，运行走 app，若 spike 确需额外角色由协调者明确审批契约更新。

Dokploy 推荐导入同一 Compose 文件，关闭 Caddy profile，由 Dokploy Traefik 接 ingress 并管理域名、证书、env；A 不添加 Dokploy 专有 label/network，不配置 Dokploy；D 给出其外部网络接入规则。data 网络不给 Traefik，避免通过运维层暴露 PG/Valkey。容器出站网络不禁止，以支持支付/AI/邮件外部调用。

### 8. 健康与验证边界（O2/P6）

保留现有 CF db/status/version/jobs 字段与 5s、no-store、安全错误策略。Node 本地/CI/Docker 构建均固化完整 40 位 git SHA；源码归档必须显式提供合法 APP_VERSION，缺失不能回退包版本冒充部署版本。响应无论 200/503 都有完整 SHA。

Node readiness 同时探测实时 DB、Valkey、B queue backend/consumer readiness 与 scheduler heartbeat；db/cache/queue 使用 up/down/unavailable，jobs 包含 lastCronAt 与 scheduler 状态。失败/未装配为 503；没有 Cron 记录或超过所注册 heartbeat 的两个周期也未就绪。B 前报告 queue/scheduler unavailable、lastCronAt null；B 后不得继续保留占位结果。健康响应和日志不泄漏依赖主机/密钥。

CI 新增独立 Node job，至少 Node unit + web/jobs Node build，独立临时 PG/Valkey 支持集成测试；重用业务用例，不简单把 cloudflare:test 测试 import 进 Node。CF workers-pool 测试、默认 build、e2e-smoke 和 staging secrets/触发器/发布顺序保持，Node job 不连接 staging。B 前完成与其无关的 Node 单元/集成；B 后跑全部适用业务集成与真实 Compose auth e2e，C 专属 R2/S3 适配器测试仍分别归各平台，不将未实现 C 的文件功能假装验收。

## Risks / Trade-offs

- [Nitro 与当前 Vite / Start 集成及预渲染生命周期变化] → 锁定版本；首个 Node SSR/Server Function/流式/静态资源/无 DB 预渲染验证后再批量迁移；默认 CF build 并行回归。
- [大范围 env/type 改造引入业务回归] → 首波契约完成后按互斥模块分波；每批保留行为用例；composition root 与共享 manifests/checker 由协调者串行整合。
- [Node 正常服务但无 B 邮件能力] → readiness 503 明示，完整认证验收在尾部依赖门后；无临时队列、无提前归档。
- [优雅退出无法保障 SIGKILL 后 Promise 完成] → 保留账本幂等/checkpoint，B 提供持久任务；不把 waitUntil 宣称为持久作业。
- [非 root PG 首次卷权限不正确] → 空卷与重启实测全部 service UID；不引入 root 初始化捷径。
- [代理错误信任使 IP 防刷失效] → 默认不信代理；受限 ingress CIDR、恶意 XFF 与直连 peer 验证。
- [A 与 C/D 未交付导致全功能生产部署尚不可用] → A 完成声明仅覆盖分配能力，C/D 验收另列；D 镜像就绪前使用本地测试镜像。

## Migration Plan

1. 协调者确认 A/B 契约；先合入中立接口、config/db 生命周期与 Node smoke，Cloudflare 保持默认。
2. 按 tasks 模块批次迁移；每批在隔离 worktree 数据库验收，共享文件串行合入；迁移 SQL 若需要仅由协调者生成。
3. 合入 Node 构建与 Compose，开发机空卷验证基础启动、权限、入口与健康未就绪路径；CF CI 和合并后的自动 staging 回归，无手工 staging 部署。
4. B 引擎合入后装配生产任务能力，完成 A 剩余集成、O2 完整健康与 auth e2e；证据未齐不勾选。
5. C/D 接续存储、邮件监控与镜像/运维交付。A 无破坏性 schema 变更；回滚到既有 Cloudflare 构建/发布路径，Node 停止服务但保留卷，不清空数据库。镜像版本回滚与备份恢复脚本由 D 定义。

## Open Questions

- Nitro 的确切锁定版本及池/内存/log rotation 参数，实施按既定适配方案与 2 核 4GB 基线实测记录；不更换框架或接口。
- C/D change 的最终名称由协调者登记；本提案使用职责名，不引用不存在的 change 路径。
- Dokploy ingress 网络名与 Traefik trusted CIDR 是 D 的环境交付参数；A 保持默认拒信和普通 Compose ingress 契约。
