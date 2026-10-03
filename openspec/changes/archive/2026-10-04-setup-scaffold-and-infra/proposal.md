# Proposal

## Why

仓库目前只有设计文档（`docs/`），还没有任何代码。整个模板依赖几项尚未实测的平台能力：TanStack Start 跑在 workerd、Hyperdrive 经 Cloudflare Tunnel 访问自建 Postgres、跨 Worker 的 Workflow 绑定、事务级锁在 Hyperdrive 连接池下的行为等（设计中标为「待验证」）。这些一旦不成立，后续各阶段的设计都要返工，因此必须在写任何业务功能之前先搭好骨架并逐项实测（对应 `docs/08-roadmap.md` Phase 0）。

## What Changes

- 建立 pnpm monorepo：`apps/web`（TanStack Start，部署为 Worker）、`apps/jobs`（Workflows / Queue 消费者 / Cron）、`packages/*`（config、db、shared 先行，其余包留空壳），配置 Biome、TypeScript strict、Vitest（`@cloudflare/vitest-pool-workers`）。
- `packages/config`：`template.config.ts` 的类型与默认值；环境变量 Zod 校验，缺失或非法时启动即失败。
- `packages/db`：Drizzle + postgres.js、按请求创建的 `createDb()`、UUIDv7 生成、第一个迁移（仅含 `setting` 表与健康检查所需内容）。
- `/api/health`：返回数据库往返耗时与版本信息。
- `apps/jobs`：导出一个空 Workflow、一个 Queue 消费者、一个 Cron，web 能通过绑定启动 Workflow 并投递消息，Cron 能写库。
- 基础设施（阶段一，见 `docs/07` §0）：本机 Docker PG 启用 TLS，本机 `cloudflared` → Tunnel → Workers VPC 服务 → Hyperdrive（开/关缓存两个配置）；staging 部署到 `*.workers.dev`；生产服务器用的 `infra/postgres` compose 作为模板编写并在本机验证；GitHub Actions CI（PR 检查；staging 自动部署移到 `docs/08`「CI 能力建设（待办）」）。生产服务器、备份与恢复演练、自定义域名、CI 经 Tunnel 迁移属于阶段二，不在本 change 范围内。
- 平台能力实测：事务 + `FOR UPDATE` + `pg_advisory_xact_lock`、跨 Worker `sendEvent` 与事件早到缓存、流式响应断开后 `waitUntil(consumeStream())`、Smart Placement 延迟基线、单个 `cloudflared` 宕机时的连通性。实测结论回写到 `docs/`。
- 决定待决事项 Q1（表单库）。

## Capabilities

### New Capabilities
- `runtime-config`: 模板配置与环境变量的加载和校验规则（缺失即失败、配置分层互不覆盖）。
- `system-health`: 对外暴露的健康检查端点，以及后台 Worker 可用性的可观测行为。

### Modified Capabilities
（无，`openspec/specs/` 目前为空。）

## Impact

- 新增：根目录工程配置、`apps/web`、`apps/jobs`、`packages/{config,db,shared}`、`infra/postgres`、`infra/local`、`.github/workflows/`、`docs/runbooks/`。
- 外部依赖：Cloudflare 账号（Workers Paid、Hyperdrive、Workers VPC、KV、Queues、Workflows、Tunnel）。阶段二另需一台生产服务器、R2 与一个非 Cloudflare 的对象存储（备份异地副本）、一个域名。
- 之后所有 change（auth、billing、AI 等）都建立在本 change 的工程结构和实测结论之上；若实测推翻某项「待验证」假设，需先修订 `docs/` 再继续后续 change。
