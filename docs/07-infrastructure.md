# 07 · 基础设施、环境与部署

## 0. 部署阶段

模板按两个阶段推进基础设施，避免在原型尚未成形时就投入生产服务器的运维：

| 阶段 | 时间 | 数据库 | 连接方式 | Worker 部署 | 域名 | 备份 |
|---|---|---|---|---|---|---|
| **阶段一：本机开发测试**（当前） | 从 Phase 0 到完成最小原型 | 开发者本机 Docker 中的 PG（`infra/local`），staging 使用其中的 `saas_staging` 库 | 本机 `cloudflared` → Tunnel → Workers VPC 服务 → Hyperdrive（§2） | staging 部署到 `*.workers.dev` | 不需要 | 不做 |
| **阶段二：生产服务器测试** | 完成最小原型之后 | 生产服务器上的 PG（§1，`infra/postgres`） | 同阶段一，或公网主机名 + Access（§2 备选） | staging / production，绑定自定义域名 | 需要（可先用已有 Zone 的子域名） | 必须（§1「备份与恢复」） |

**最小原型**指 Phase 0–3 完成：可以注册登录、开通套餐或购买积分、进行一次计费正确的 AI 对话（见 `docs/08-roadmap.md`）。

阶段一的限制：
- 部署后的 staging Worker 访问数据库时，开发者本机必须开机且 `cloudflared` 在运行。
- 请求从 Cloudflare 边缘绕回开发者本机网络，延迟不能代表生产环境；Phase 0 记录的延迟基线只用于验证链路可用。
- 本机 PG 不做备份，staging 数据可随时重建。

## 1. 自建 Postgres（阶段二）

### 部署形态
一台 VPS（地区按具体应用的主要用户选择，模板不限定），Docker Compose 运行：

| 服务 | 说明 |
|---|---|
| `postgres` | Postgres 17，数据卷挂载本地 SSD；只监听 Docker 内网 / localhost |
| `cloudflared` ×2 | Cloudflare Tunnel，把 PG 暴露给 Hyperdrive（不开放公网端口）；同一 Tunnel 运行**两个副本**（Tunnel 原生支持多个连接器），单个进程崩溃或升级时不中断数据库访问 |
| `walg` / `pgbackrest` | 基础备份 + WAL 归档到 R2（S3 兼容） |
| （可选）`postgres-exporter` | 指标给 Grafana / 监控平台 |

模板提供 `infra/postgres/docker-compose.yml`、`postgresql.conf` 基础调优、初始化脚本（创建应用用户，最小权限）。

### 数据库账号
| 账号 | 权限 | 用途 |
|---|---|---|
| `app` | 业务表 DML | Hyperdrive 连接使用 |
| `migrator` | DDL | 仅 CI / 迁移使用 |
| `readonly` | SELECT | 数据分析、排查 |

### 备份与恢复（阶段二必须；阶段一不做）

> 状态：推迟到阶段二实施。R2 主备份与异地第二副本均为待办（`docs/08-roadmap.md`「生产迁移」）。

- 每日基础备份 + 持续 WAL 归档到独立的 R2 桶（开启 Bucket Lock 保留规则，防误删）。
- **异地第二副本**：每日基础备份与 `pg_dump` 再同步一份到**非 Cloudflare 账号**下的对象存储（如 Backblaze B2，使用独立凭证）。业务和主备份都在同一个 Cloudflare 账号下，账号被盗、被封或误操作时会一起丢失。
- 保留策略：7 天每日 + 4 周每周（可调）。
- **每月恢复演练**：在临时实例恢复到指定时间点，并跑一次校验脚本（含积分对账不变式）。
- 另做一份每日 `pg_dump` 逻辑备份（跨版本迁移时用）。

### 可用性目标（单机部署的明确承诺）

| 指标 | 目标 | 依据 |
|---|---|---|
| RPO（最多丢失的数据） | ≤ 1 分钟 | WAL 持续归档，`archive_timeout = 60s` |
| RTO（VPS 故障时的恢复时间） | 约 1–2 小时 | 新开 VPS → 从 R2 拉基础备份 + 回放 WAL → 切换 Tunnel；Runbook 写入 `docs/runbooks/` |
| 计划内停机 | 有 | PG 小版本升级、VPS 重启期间整站写操作不可用 |

单机没有高可用。业务需要更高可用性时，可加一台异地流式复制备库（手动提升），或迁移到托管 PG。

### 监控与告警
- 磁盘使用率、连接数、复制/归档延迟、慢查询（`pg_stat_statements`）、备份是否成功。
- 外部探活：Uptime Kuma 或 Cloudflare Health Checks；告警到邮件 / Telegram / Discord。

### 迁移到托管服务的后路
只使用标准 PG 特性与常见扩展（`pgcrypto`、`pg_trgm`，可选 `pgvector`），更换为 Neon / Supabase / RDS 时只需修改 Hyperdrive 配置。

## 2. Hyperdrive + Cloudflare Tunnel

### 默认方式：Workers VPC（阶段一、阶段二通用）

Hyperdrive 通过 Workers VPC 服务经 Tunnel 访问私有数据库，**不需要公网主机名、DNS 记录、Access 应用或 Service Token**。链路：Worker → Hyperdrive → Workers VPC 服务（TCP）→ Tunnel → `cloudflared` → Postgres。

步骤（在 `docs/runbooks/hyperdrive-tunnel.md` 中细化）：
1. 创建一个专用 Tunnel，在数据库所在机器上运行 `cloudflared`（阶段一为 `infra/local` 中的可选 `cloudflared` 服务，阶段二为 `infra/postgres`）。
2. Postgres 必须启用 TLS（Workers VPC 的要求）；阶段一使用自签证书，VPC 服务设置为不校验证书。
3. `wrangler vpc service create <name> --type tcp --tcp-port 5432 --app-protocol postgresql --tunnel-id <tunnel-id> --hostname <cloudflared 可达的数据库主机名>`（或 `--ipv4`）；阶段一的自签证书加 `--cert-verification-mode disabled`。
4. 创建两个 Hyperdrive 配置，指向该 VPC 服务（`wrangler hyperdrive create <name> --service-id <id> --database ... --user app ...`）：
   - `app-db`：**关闭缓存**
   - `app-db-cached`：开启缓存（max_age 按需要，如 60s）
5. 在 `apps/web`、`apps/jobs` 的 wrangler 配置中绑定为 `HYPERDRIVE`、`HYPERDRIVE_CACHED`。

### 备选方式：公网主机名 + Access（阶段二可选）

为 PG 配置 TCP 类型的公共主机名（如 `pg.example.com`），为其创建 Access 应用与 Service Token，Hyperdrive 带 Access 的 client id / secret 连接。需要域名与 DNS 编辑权限；优点是 CI 可以经 `cloudflared access tcp` 直接连库执行迁移（见 §5）。

连接代码：

```ts
// packages/db/src/client.ts
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export function createDb(hd: Hyperdrive) {
  const sql = postgres(hd.connectionString, {
    max: 5,                // 单个 Worker 调用内的并发连接数
    fetch_types: false,    // 省掉一次类型查询往返
    prepare: true,
  })
  return drizzle(sql, { schema })
}
// 每个请求调用一次 createDb(env.HYPERDRIVE)，不要缓存到模块作用域
```

## 3. 环境

| 环境 | Web | 数据库 | 支付 | 说明 |
|---|---|---|---|---|
| local | `wrangler dev` / `vite dev`（workerd） | 本地 Docker PG | Stripe test / PayPal sandbox | Hyperdrive 使用 `localConnectionString` 直连本地 PG；R2/KV/Queues 由 Miniflare 模拟 |
| preview | 每个 PR 一个 Worker 预览版本 | staging 库（**只读 schema**） | 测试模式 | 可选；PR 不得对 staging 库执行迁移，含 schema 变更的 PR 不部署预览（或改用本地验证） |
| staging | 阶段一：`*.workers.dev`；阶段二：`*.staging.<域名>` | 阶段一：本机 PG 的 `saas_staging` 库（经 Workers VPC）；阶段二：生产服务器上的独立 database 或独立实例 | 测试模式 | |
| production | 自定义域名（阶段二） | 生产库 | 正式 | 阶段一不部署 |

Wrangler 使用 `env.staging` / `env.production` 区分绑定与变量。

### 本地多 Worker 联调（已实测，wrangler 4.146 / @cloudflare/vite-plugin 1.62）

采用**两个进程**：`apps/web` 跑 `vite dev`，`apps/jobs` 跑 `wrangler dev`（`apps/jobs/scripts/dev.mjs`，端口取自 `.env.worktree` 的 `JOBS_PORT` / `JOBS_INSPECTOR_PORT`，并带 `--test-scheduled`）。根目录 `pnpm dev`（`turbo run dev`）同时启动两者。两个进程经本机 dev registry 自动互连，无需额外配置：
- web 的 `AI_MEDIA_WORKFLOW`（`script_name: "jobs"`）能创建 jobs 中定义的 Workflow 实例并查询状态；
- web 的 `EMAIL_QUEUE` producer 投递的消息由 jobs 的消费者处理；
- 手动触发 Cron：`curl "http://localhost:$JOBS_PORT/__scheduled?cron=*/5+*+*+*+*"`。
- 调试路由（仅 `vite dev`，生产构建返回 404）：`POST /api/dev/workflow` 启动实例、`GET /api/dev/workflow?id=` 查询状态、`POST /api/dev/email` 投递消息。

备选：Vite 插件的 `auxiliaryWorkers: [{ configPath: '../jobs/wrangler.jsonc' }]` 在单进程内同时运行两个 Worker，Workflow、Queue、Cron（经 `/cdn-cgi/local/explorer/api/local/scheduled?worker=jobs`）同样可用；未采用的原因是 jobs 会改由 web 的 Vite 构建并出现在 web 的构建产物中，与 jobs 独立部署（`wrangler deploy`）的方式不一致。

数据库连接：postgres.js 3.4.9 在 workerd 中调用 `sql.end()` 会产生无法捕获的「Stream was cancelled」，连接失败时其 socket 内部 promise 也会出现未处理的 rejection（不影响查询本身的错误传递）。因此 Worker 中按请求 / 事件创建 `createDb()`、不显式关闭，连接随请求结束由 workerd 回收，Hyperdrive 在边缘维护连接池；测试中由 `onUnhandledError` 只忽略来自该 polyfill 的 rejection（`packages/db/test/postgres-socket-rejection.ts`）。

## 4. 环境变量与绑定清单

### Secrets（`wrangler secret put`，本地放 `.dev.vars`）
```
BETTER_AUTH_SECRET
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
TURNSTILE_SECRET_KEY
RESEND_API_KEY
STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET
PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID
AI_GATEWAY_TOKEN(若启用鉴权)
OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_AI_API_KEY   # 或使用 AI Gateway 统一计费
FAL_KEY
MEDIA_WEBHOOK_SECRET          # 回调 URL 的 HMAC
R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   # R2 S3 API 令牌，仅授权 FILES 桶，用于签发预签名上传/下载 URL
SENTRY_DSN
```

### Vars（非敏感）
```
APP_URL
PAYPAL_ENV=sandbox|live
AI_GATEWAY_ACCOUNT_ID / AI_GATEWAY_ID
R2_ACCOUNT_ID / R2_FILES_BUCKET   # 拼接 S3 兼容端点
TURNSTILE_SITE_KEY(前端公开)
```

### Bindings
```
HYPERDRIVE, HYPERDRIVE_CACHED     (Hyperdrive)
FILES                             (R2)
CACHE                             (KV)
RL_AUTH, RL_AI                    (Rate Limiting)
EMAIL_QUEUE, EVENTS_QUEUE         (Queues: web 为 producer，jobs 为 consumer)
AI_MEDIA_WORKFLOW                 (Workflows: 定义在 jobs，web 通过 script_name 绑定)
JOBS                              (Service Binding: web → jobs，可选)
AI                                (Workers AI，可选)
```

## 5. 部署与 CI（GitHub Actions）

```
PR:    install → biome check → typecheck → unit test (vitest-pool-workers) → build
       → （可选，且 PR 不含新迁移时）部署预览版本
main:  以上 + 数据库迁移(staging) → 部署 staging → e2e (Playwright) 
tag:   数据库迁移(production) → wrangler deploy (jobs 先于 web) → 冒烟测试
```

**数据库迁移如何访问私有 PG**：
- 阶段一：数据库在开发者本机，CI 无法访问。staging 的迁移由开发者在本机以 `migrator` 账号执行（`pnpm --filter @saas/db db:migrate`，连接 `saas_staging`），CI 的 main 流水线只部署 Worker。
- 阶段二：CI 中运行 `cloudflared access tcp`（需要 §2 的公网主机名 + Access 备选方式）在本地开一个转发端口，再执行 `drizzle-kit migrate`；或通过 SSH 在生产服务器上执行迁移。

**迁移原则**：只做向后兼容的变更（先加字段/表 → 部署代码 → 再删旧字段），保证 web/jobs 滚动发布期间新旧代码都能运行。

**部署顺序**：迁移 → `apps/jobs` → `apps/web`（web 依赖 jobs 中定义的 Workflow / Queue 消费者）。

## 6. 安全清单

- 所有 Webhook 验签；回调 URL 带 HMAC；验签失败记录并告警。
- Secrets 只存 Wrangler secrets，不进代码仓库；`.dev.vars` 加入 `.gitignore`。
- Turnstile + Rate Limiting 保护认证与 AI 接口。
- R2 桶不公开；下载经鉴权签发短期 URL。
- 服务端下载外部 URL 时限制域名白名单、大小与超时（防 SSRF）。
- 管理后台操作写 `audit_log`；模拟登录有明显提示并记录。
- 数据库最小权限账号；PG 只经 Tunnel（Workers VPC 或 Access）访问，端口不对公网开放。
- 依赖更新：Renovate / Dependabot。

## 7. 可观测性

| 维度 | 工具 |
|---|---|
| 错误 | Sentry（web + jobs，带 release 与 source map） |
| 日志 | Workers Logs（结构化 JSON，含 requestId、workspaceId、userId） |
| 流量 | Cloudflare Web Analytics；产品分析可选 PostHog / Umami |
| AI | AI Gateway 仪表盘 |
| 业务指标 | 管理后台：注册、付费转化、MRR、积分消耗、任务成功率 |
| 数据库 | pg_stat_statements、导出器指标、备份状态 |
