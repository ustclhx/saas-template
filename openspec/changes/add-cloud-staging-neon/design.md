# Design

## Context

- staging 两个 Worker（`web-staging`、`jobs-staging`，`*.workers.dev`）已部署；KV、Queues（`email-staging`、`events-staging`）、Workflow（`ai-media-staging`）、限流命名空间都已在 Cloudflare 上，只有数据库在本机（`docs/07` §0、§2）。
- staging 的 Hyperdrive 配置 `c4b28441…`（关缓存）/ `1b360cad…`（开缓存）指向 Workers VPC 服务 `saas-template-local-pg`。
- 迁移以 `migrator` 账号通过 `drizzle-kit migrate` 执行（`packages/db/drizzle.config.ts` 读取 `MIGRATION_DATABASE_URL`）；`billing:seed` 以 `app` 账号连接（读取 `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`）。
- 账号与权限约定在 `infra/local/initdb/01-roles.sql`（集群级账号）与 `02-db-grants.sql`（单库权限，可重复执行，含 `audit_log` 只追加的撤销）。
- `/api/health` 的 `version` 来自 `vite.config.ts` 的 `__APP_VERSION__ = pkg.version`，目前恒为 `0.0.0`。
- 支付运行时 `createTestPaymentRuntime`（`packages/billing/src/runtime.ts`）在凭据缺失时静默跳过服务商；`jobs-staging` 当前没有任何 secret，`web-staging` 缺 `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID`。
- CI（`.github/workflows/ci.yml`）只做检查与构建，不部署。
- Playwright 只针对本地 `vite dev`（`apps/web/playwright.config.ts` 自启 webServer）；默认 `auth.requireEmailVerification=false`，注册不依赖邮件。

## Goals / Non-Goals

**Goals:**
- staging 数据库在任何时候可用，不依赖开发者本机。
- main 合并后无人值守地完成 staging 迁移、部署、版本确认与冒烟测试。
- staging 配置齐全到足以执行 P2 / P3 / 管理后台 / 营销的 staging 验收任务。

**Non-Goals:**
- 生产环境、自定义域名、备份（仍属阶段二，`docs/08`「生产迁移」）。
- PR 预览环境与 Neon 分支（以后可基于 Neon branch 做，本次不做）。
- 实现 AI Provider 工厂（`add-ai-text-chat` 2.1）、Sentry 接入（observability 1.2）、R2 `FILES` 绑定与媒体功能（`add-ai-media-generation`）；本次只准备它们需要的外部资源与变量。
- 迁移本机 `saas_staging` 的数据：staging 数据按约定可随时重建。
- 删除本机 Tunnel、Workers VPC 服务与旧 Hyperdrive：观察期后再清理（见 Migration Plan）。

## Decisions

### 1. Neon 作为 staging 数据库，Hyperdrive 以连接串直连
- Hyperdrive 使用 Neon 的**直连（非 pooled）**主机名，`sslmode=require`；连接池由 Hyperdrive 负责，避免与 Neon 的 PgBouncer（事务模式）叠加两层池。
- 选择理由：零运维、CI 可直接访问（TLS + 密码）、与现有 Hyperdrive 代码路径一致（`createDb(env.HYPERDRIVE)` 不变）。
- 备选：本机 PG（现状，不可靠）；提前上 VPS（阶段二工作量，备份与运维前置）；Supabase（同类托管，Neon 的分支能力对以后的 PR 预览更有用）。
- 区域：选与主要用户和 Cloudflare 边缘都近的 AWS 区域，默认 `aws-us-west-2`（Phase 0 边缘落在 `lax*`）。延迟基线需在新库上重测，结论只代表 staging。
- Postgres 版本 17，与 `infra/local`、CI 一致。

### 2. 账号与权限沿用三账号约定，`migrator` 作为数据库 owner
- 在 Neon 控制台 / API 创建 `migrator` 角色，并以它为 owner 创建数据库 `saas_staging`；`app`、`readonly` 同样在控制台创建（Neon 生成密码）。
- 以 `migrator`（database owner）连接执行 `02-db-grants.sql`。数据库 owner 即 `public` schema 的 owner（PG15+ 的 `pg_database_owner`），脚本中的 `ALTER SCHEMA public OWNER TO migrator` 应可执行；若 Neon 拒绝某条语句，以 Neon 默认 owner 角色补执行，并把差异写入 runbook，**不修改** `02-db-grants.sql` 对本地与 CI 的行为。
- `01-roles.sql` 不在 Neon 执行（其中是本地明文密码）。
- 验收方式：以 `app` 账号执行 DDL 被拒绝、对 `audit_log` 执行 UPDATE 被拒绝。

### 3. 新建 Hyperdrive 配置而不是原地更新
- 新建 `saas-staging-neon`（`--caching-disabled`）与 `saas-staging-neon-cached`（`--max-age 60`），两个都用 `app` 账号连接串；替换两个 `wrangler.jsonc` 中 `env.staging.hyperdrive` 的 ID 与注释。
- 理由：回滚只需还原 ID 并重新部署；旧配置在观察期内保留。备选 `wrangler hyperdrive update` 保持 ID 不变，但回滚需要再次改源。

### 4. 版本标识在构建时注入
- `vite.config.ts` 中 `__APP_VERSION__` 取值顺序：`process.env.APP_VERSION` → `git rev-parse --short HEAD` → `pkg.version`。CI 设置 `APP_VERSION=${{ github.sha }}`。
- 不使用 Workers 的 version metadata 绑定：那是 Cloudflare 的版本 ID，与提交不对应，CI 无法预先知道期望值。

### 5. 缺凭据告警放在支付运行时入口
- 在 `createTestPaymentRuntime` 判定某个已启用服务商因凭据缺失而跳过时，调用注入的告警回调（默认 `log.warn('billing.provider_unconfigured', { provider, missing })`），按 `provider` 在模块级 Set 中去重（每个 isolate 一次）。只记录变量名。
- 放在运行时而不是 7 个调用方，保证 web 与 jobs 行为一致；`sk_test_` 校验等现有行为不变。

### 6. staging 发布流水线
- 新文件 `.github/workflows/deploy-staging.yml`，触发：`workflow_run`（`CI` 在 `main` 上 `completed` 且 `conclusion == success`），检出 `workflow_run.head_sha`；另加 `workflow_dispatch` 便于手动重发。
- `concurrency: { group: staging-deploy, cancel-in-progress: false }`；`environment: staging`（GitHub Environment，secrets 只授予该 environment，PR 工作流拿不到）。
- 步骤：install → `pnpm --filter @saas/db db:migrate`（`MIGRATION_DATABASE_URL` = `STAGING_MIGRATION_DATABASE_URL`）→ `pnpm --filter @saas/jobs deploy:staging` → `APP_VERSION=$SHA pnpm --filter @saas/web deploy:staging` → `scripts/staging/wait-healthy.mjs`（每 5 秒一次、最长 3 分钟，要求 200 + `db.status=up` + `version=SHA`；输出不含响应以外的信息）→ Playwright `staging` 项目。
- wrangler 在 CI 中以 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 认证。Token 权限：Workers Scripts 编辑、Workers KV / Queues / Hyperdrive / Workflows 读取（部署时解析绑定）、Account Settings 读取。
- 迁移在部署前执行，依赖「迁移只做向后兼容变更」的既有原则（`docs/07` §5）。

### 7. staging 冒烟用例与本地 e2e 分离
- `apps/web/playwright.config.ts` 在 `STAGING_URL` 存在时：`baseURL = STAGING_URL`、不启动 webServer、只运行 `e2e/staging/*.spec.ts`；否则保持现有行为并忽略 `e2e/staging/`。
- 冒烟用例只用公开 UI 与 Turnstile 测试 key：首页、定价页、以 `smoke+<sha>-<随机>@example.com` 注册并进入个人空间。不读取本地日志文件，不依赖邮件。
- 注册在 staging 留下测试用户，可接受（staging 可重建）；RL_AUTH 每分钟 10 次，用例总注册次数保持为 1。

### 8. staging secrets 核对脚本
- `scripts/staging/check-secrets.mjs`：内置 web / jobs 各自的必需与可选 secret 名单，调用 `wrangler secret list --env staging --format json`（或解析其 JSON 输出），打印缺失项名称，有必需项缺失时退出码非 0。永不打印值（`secret list` 本身也不返回值）。
- 名单：web 必需 `BETTER_AUTH_SECRET`、`TURNSTILE_SECRET_KEY`、OAuth 四项、Stripe 两项、PayPal 三项；jobs 必需 Stripe 两项、PayPal 三项；可选 `RESEND_API_KEY`、`AI_GATEWAY_TOKEN`、`SENTRY_DSN`。

## Risks / Trade-offs

- [Neon 计算持续运行导致免费额度不够：jobs 的 `*/5` 心跳与 `*/10` 重试 Cron 会让计算几乎不进入 scale-to-zero] → 先用 Free 计划，部署一周后在 Neon 控制台查看计算用量，超过额度则升级到付费计划；不为省额度而在 staging 改 Cron 频率（会与生产行为不一致）。
- [Scale-to-zero 冷启动让首个请求变慢，可能接近健康检查 5 秒超时] → 冒烟流水线的健康检查轮询 3 分钟，容忍首次 503；若频繁出现，在 Neon 中关闭 scale-to-zero。
- [数据库暴露在公网（TLS + 密码），不再是 Tunnel 私有访问] → 只承载可丢弃的测试数据；三账号最小权限；`migrator` 凭据只存在 GitHub `staging` environment 与开发者本机；Neon 计划支持时开启 IP 白名单。生产仍按阶段二的私有方案。
- [Hyperdrive 经公网连 Neon 时，事务与锁的行为与 Phase 0 的 VPC 实测不同] → 用 `scripts/probes/71-locks` 对新配置重跑一轮，结论写入 `docs/07`。
- [CI 自动迁移出错会让 staging 停在半迁移状态] → 迁移失败时不部署；staging 可从空库重建（runbook 写清重建步骤）。
- [`workflow_run` 触发的工作流使用默认分支上的工作流定义] → 这正是期望行为（只部署 main）；手动重发用 `workflow_dispatch` 并限定 `ref` 为 main。

## Migration Plan

1. 创建 Neon 项目、角色、数据库，应用迁移与 seed（不影响现有 staging）。
2. 新建两个 Hyperdrive 配置，修改 wrangler staging ID，本机按 jobs → web 手动部署一次；`/api/health` 返回 `db: up`，并重跑 71-locks 探针。
3. 补齐 secrets 与 vars，核对脚本通过；重新登记 Stripe / PayPal 测试 webhook 地址（如已登记，地址不变则跳过）。
4. 合入版本注入、告警与流水线；首次 main 合并触发自动发布并通过冒烟。
5. 观察 24 小时（2026-10-09 由 7 天缩短）：Neon 计算用量、健康检查与 Cron 心跳。之后停止本机 `cloudflared` 的 staging 用途，删除旧 Hyperdrive 配置 `c4b28441…` / `1b360cad…`（Workers VPC 服务与 Tunnel 保留给阶段二或一并删除，由用户决定）。

**回滚**：把 `env.staging.hyperdrive` 的 ID 还原为旧值、启动本机 cloudflared 后重新部署；流水线可通过禁用 `deploy-staging.yml` 停止。

## Open Questions

- Neon 是否在 Free 计划下够用（取决于实际计算用量）——一周后根据数据决定是否升级，不影响任务拆分。
- 观察期结束后，Tunnel `saas-template-local` 与 Workers VPC 服务是否保留给阶段二——由用户在清理时决定。
