# Proposal

## Why

模板目前以 Cloudflare Workers 为主运行时，产品的长任务与原生 Node 模块需求需要一个可选的 Linux / Docker Compose 目标。新增目标必须复用业务代码、保持 Postgres 为事实来源，并保留 Cloudflare 的能力、测试与 staging 发布。

## What Changes

- 新增 `packages/platform`，按能力提供 env、db、kv、rateLimit、waitUntil、clientIp、requestId 的独立契约与 Cloudflare / Node 适配；定义 queue / workflow / scheduler 契约供 B 实现 Node 后端。
- 迁移业务代码的平台调用与类型，检查器禁止业务直接导入 `cloudflare:*`；平台入口显式分离，默认构建仍为 Cloudflare。
- 新增 web / jobs Node LTS 构建、Dockerfiles 和 `deploy/selfhost/compose.yaml`，复用 infra 的三角色与权限初始化，包含 Postgres 17、Valkey、一次性 migrate、web、jobs 和可选 Caddy（ACME / 自带证书）。Compose 消费镜像，服务器不构建。
- Node 使用进程级 Postgres 池、Valkey KV 与原子限流、可信代理 IP、应用请求 ID、后台 Promise 排空；文本 AI 支持直连 OpenAI 兼容端点，可选 Gateway，Workers AI 默认不可用。
- 新增 Node 构建 / 单元测试 CI 和本地集成验证；完整 Compose 认证 e2e **等待 B 合入**，不提供临时内存队列、不提前标记通过。

### Requirements covered（原始需求 ID）

| ID | 本 change 要求 |
|---|---|
| R1 | web、jobs 运行在 Node LTS；TanStack Start 输出 Node 服务端 |
| R2 | 统一 env / 平台接口，业务不直接导入 `cloudflare:*` |
| R3 | config 的 Zod schema 校验；Node 缺失或非法配置启动即失败 |
| R4 | 密钥支持 `.env` 与 `*_FILE`，凭据不进入镜像、仓库或日志 |
| R5 | Node 目标允许原生模块，不受 Workers 打包体积限制 |
| R6 | 不添加平台 CPU 时长上限；长任务仅受业务超时约束 |
| D1 | 进程池直连 PG17，createDb 接受连接串 / 池并兼容 Hyperdrive |
| D2 | 保留 app、migrator、readonly 最小权限账号 |
| D3 | migrator 一次性容器先执行迁移，成功后启动应用 |
| D4 | 保留事务、行锁和事务级 advisory lock 语义 |
| D5 | PG 仅 Compose 内网可达，不映射公网端口 |
| C1 | Valkey 支持认证 secondaryStorage 与配置缓存 |
| C2 | 同一 Valkey 实现 RL_AUTH / RL_AI / RL_API 的键、限额和周期语义 |
| H1 | 可选 Caddy 提供 80/443、ACME 及自带证书；推荐运维层 Dokploy 使用自己的 Traefik |
| H2 | 仅从可信代理解析客户端 IP，代理列表可配置 |
| H3 | 应用生成请求 ID，可附带 cf-ray |
| H4 | 所有容器以非 root 运行，只有代理映射端口 |
| H5 | Turnstile 可关闭，关闭后认证与限流仍可用 |
| A1 | 响应结束后跟踪 Promise；优雅停机等待完成并有上限 |
| A2 | 文本 AI 可配置 OpenAI 兼容 base URL / key，Gateway 可选 |
| A3 | 两目标共用用量、预算、预扣与结算规则 |
| A4 | Node 默认关闭 Workers AI，隐藏入口并拒绝直接调用 |
| O1 | stdout JSON 日志，Docker 滚动大小与份数可配置 |
| O2 | health 报告 DB、缓存、队列、最近定时任务与完整 git SHA |
| P6 | Cloudflare 仍为主目标，既有 CI / staging 不受影响；Node CI 至少构建与单元测试 |

### Non-Goals

- **B：`add-selfhost-job-engine`**：Postgres 队列、cron、多步骤任务的 Node 实现及 spike（DBOS Transact vs pg-boss + step engine）。A 不决定引擎、不实现调度；queue / workflow / scheduler 契约与集成验收边界见 design。
- **C（对象存储、邮件与监控 change，名称待协调者确定）**：S1–S2 外部 S3 默认与可选自带存储、O3 Sentry Node SDK、E1 SMTP；A 只隔离现有 R2 / Sentry 平台代码，保留 Resend，不新增这些服务。
- **D（交付与运维 change，名称待协调者确定）**：P1–P5 多架构镜像发布 / GHCR、Dokploy 集成、SSH 部署、服务器初始化脚本、备份恢复 B1–B5、`create-project --target selfhost`、新加坡 ECS 验收。A 定义 Dockerfiles 与 Compose 结构，不发布镜像或配置 Dokploy。
- Kubernetes、多节点、自动扩缩容、跨机器高可用和业务代码分叉。

## Capabilities

### New Capabilities

- `platform-capabilities`：按目标装配的平台接口、后台延续、请求元数据及 B 的任务契约。
- `database-connectivity`：双目标连接生命周期、最小权限与事务不变量。
- `cache-rate-limit`：跨目标 KV 行为与 Valkey 原子防刷。
- `selfhost-deployment`：Node 服务端、Compose 入口安全、容器运行及 CI 隔离。
- `ai-text-runtime`：Gateway / 直连文本模型与一致结算、Workers AI 能力判定。

### Modified Capabilities

- `runtime-config`：按目标启动校验、文件密钥与可选集成在 Node 进程中的告警生命周期。
- `system-health`：Node 完整 SHA、依赖探测和缺失 B 时显式未就绪；保留 Cloudflare 响应兼容。

## Impact

实施将涉及 apps/web 的 server、routes / features 与构建测试入口，apps/jobs 的运行时入口与工作流适配，packages/config、db、auth、ai、storage、业务缓存调用，平台 package、依赖检查 / AGENTS 边界、CI 和 selfhost 部署目录。新增 Node HTTP 适配与 Valkey 客户端依赖；版本与构建证据见 design。

本提案 PR **只包含此 change 的规划产物**，没有代码、迁移、部署或外部凭据变更。A 可先实现基础部分；B 合入前 Node 无可靠邮件队列与 Cron，O2 完整健康和认证 e2e 验收保持未完成。C 的文件 / 媒体服务以及 D 的生产交付不属于 A 的完成声明。
