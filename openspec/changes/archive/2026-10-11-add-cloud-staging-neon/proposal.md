# Proposal

## Why

staging 的数据库目前是开发者本机 Docker 中的 `saas_staging`，经本机 `cloudflared` → Tunnel → Workers VPC → Hyperdrive 访问：本机关机、Docker 停止或本机代理（TUN / fake-ip）干扰 Tunnel 时 staging 整体不可用（2026-10-08 实测 `/api/health` 返回 `db: down`，cloudflared 连接反复断开重连）。剩余五个 change 的收尾任务几乎都是 staging 验收，需要一个不依赖本机、CI 可以自动迁移和部署的云端测试环境。

## What Changes

- staging 数据库迁到 Neon（托管 Postgres），Hyperdrive 以连接串直连 Neon；新建两个 Hyperdrive 配置（关缓存 / 开缓存）替换 `apps/web`、`apps/jobs` staging 环境中的 ID。本机 PG + Tunnel 不再承载 staging，保留给本地开发与阶段二生产方案。
- Neon 上按现有约定建 `app` / `migrator` / `readonly` 三个账号与权限，应用全部迁移与 `billing:seed`；staging 数据从空库重建，不迁移本机 `saas_staging` 的数据。
- 补齐 staging 配置：`jobs-staging` 的支付密钥、`web-staging` 缺少的 PayPal 密钥、AI Gateway 变量；新增脚本按清单核对两个 Worker 的 staging secrets 是否齐全（只输出名称）。
- 启用的支付服务商缺少凭据时，Worker 记录一条只含变量名的告警，不再静默以「无服务商」运行。
- `/api/health` 的 `version` 改为构建时注入的提交标识（CI 中为 commit SHA），用于确认部署是否生效。
- 新增 GitHub Actions staging 流水线：main 上 CI 通过后执行 staging 迁移 → 部署 jobs → 部署 web → 健康检查确认版本 → Playwright staging 冒烟测试。
- 更新 `docs/07`、`docs/08`、相关 runbook，新增 `docs/runbooks/staging-neon.md`。

## Capabilities

### New Capabilities
- `staging-deployment`: staging 环境的自动迁移、部署顺序、部署后版本确认与冒烟测试，以及 PR 不得改动 staging 数据库的约束。

### Modified Capabilities
- `system-health`: 健康检查返回的 `version` 必须能区分每次部署（提交标识），而不是包版本号。
- `runtime-config`: 新增「已启用的可选集成缺少凭据时记录告警」要求。

## Impact

- 配置：`apps/web/wrangler.jsonc`、`apps/jobs/wrangler.jsonc` 的 `env.staging`（Hyperdrive ID、AI Gateway vars）。
- 代码：`apps/web/vite.config.ts`（版本注入）、`packages/billing/src/runtime.ts` 或其调用方（缺凭据告警）、`apps/web/playwright.config.ts` 与新的 staging 冒烟用例、`scripts/staging/`。
- CI：新增 `.github/workflows/deploy-staging.yml`；需要 GitHub Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`STAGING_MIGRATION_DATABASE_URL`。
- 外部服务：Neon 项目（新依赖，staging 专用）、Cloudflare Hyperdrive ×2、AI Gateway、Stripe / PayPal 测试 webhook 地址。
- 不影响：本地开发与 Orca worktree 的数据库流程、生产（阶段二）方案、已有业务行为。
