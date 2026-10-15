# Proposal

## Why

Cloudflare 形态的最小原型与 staging 验收已完成，但只有 `*.workers.dev` 上的 staging，没有生产环境、自定义域名、备份或生产发布流程。2026-10-15 用户决定：生产数据库使用 Neon 付费档，不自建 PG，不建设 Tunnel / Workers VPC。原路线图「生产迁移」以自建 PG 为前提，需要按新决定重新定义阶段二。

## What Changes

- 新建独立的 Neon 生产项目（付费计划、PG 17），沿用 staging 的受限 `migrator` / `app` / `readonly` 角色与非 pooled TLS 直连，经两个 Hyperdrive（缓存/非缓存）接入。
- web / jobs 新增 `env.production` Wrangler 配置（独立 KV、Queues、Workflows、R2、限流命名空间与 vars）和生产 secrets 清单，绑定自定义域名。
- 新增由 tag 触发的生产发布流水线：只发布已在 staging 成功部署的提交，按「迁移 → jobs → web → 健康检查完整 SHA → 只读冒烟」串行执行，需 GitHub `production` environment 审批。
- 新增生产备份与恢复：Neon PITR 之外，每日用 `readonly` 角色生成加密逻辑备份并上传到开启 Bucket Lock 的独立存储；提供恢复演练 runbook 并记录 RTO / RPO。
- 生产支付在 Q9（正式收款主体）决定前不配置，按 `payment-mode` 现有规范关闭支付入口；Q9 决定后按 `docs/05-billing.md` §8 清单切换 live。
- 不修改 main → staging 自动发布行为（staging 项目随组织 2026-10-15 升级为 Launch 计费，计算上限改为 2 CU，见 production runbook §4）；不涉及自托管形态（其 PG 在 Compose 内，由 `add-selfhost-*` 负责）。

## Capabilities

### New Capabilities

- `production-deployment`: Cloudflare 形态生产环境的发布触发与门禁、发布顺序与版本确认、只读冒烟，以及生产数据库的备份、恢复演练与凭据隔离。

### Modified Capabilities

无。`staging-deployment` 的行为不变；`payment-mode` 已规定 production 缺少模式时关闭支付，本 change 直接沿用。

## Impact

- 配置：`apps/web/wrangler.jsonc`、`apps/jobs/wrangler.jsonc` 新增 `env.production`；生产 Hyperdrive / KV / Queue / R2 / Workflow 资源 ID。
- CI：新增 `.github/workflows/deploy-production.yml` 与每日备份 workflow；GitHub `production` environment 及其 secrets。
- 测试：新增 production 只读冒烟 Playwright project；现有 staging 冒烟不变。
- 文档：`docs/07-infrastructure.md`、`docs/08-roadmap.md`、新 runbook `docs/runbooks/production-neon.md` 与 `docs/runbooks/restore.md`。
- 外部资源（用户提供或批准）：Neon 付费计划与账单、生产域名及 DNS 权限、备份存储（R2 Bucket Lock 或非 Cloudflare 对象存储）、备份加密密钥、GitHub production 审批人；live 支付另依赖 Q9。
- 费用：Neon Launch 按 CU-hours 与存储计费。生产 autoscaling 0.25–1 CU、PITR 7 天；测试期 reduced Cron 约 $4/月，默认 Cron 常驻约 $20–25/月；staging 约 $4/月。以实际 Usage 复核，依据见 production runbook §4。
