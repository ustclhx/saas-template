# Tasks

## 1. 资源与决策（用户门，协调者执行）

- [x] 1.1 **BLOCKED（用户开通 Neon 付费计划并选定区域）**：新建 Neon 生产项目（PG 17），按 `docs/runbooks/staging-neon.md` §1–2 以 SQL 创建受限 `migrator` / `app` / `readonly`，执行权限脚本，确认计划的 PITR 保留窗口。验证：三角色无高权限 flags 与 `neon_superuser` 成员身份；app DDL、readonly 写入被拒；新增 `docs/runbooks/production-neon.md` 记录项目、区域、计划与 PITR 窗口（不含凭据）。
  - 2026-10-15 完成：Launch 计划、`saas-production`（`super-resonance-99115167`，`aws-us-west-2`，PG 17）；SQL 受限三角色、权限脚本、flags 与拒绝验证通过；用户确认后 PITR 改为 7 天、计算改为 0.25–1 CU，staging 上限改为 2 CU（runbook §4）。表级写入拒绝随 3.3 迁移后复核。见 [production-neon runbook](../../../docs/runbooks/production-neon.md)。
- [x] 1.2 **BLOCKED（用户提供生产域名与 DNS 权限）**：确定 production web 域名（可先用已有 Zone 的子域），记录在 production runbook。验证：Zone 归属与 DNS 权限可用，域名写入 runbook。
  - 2026-10-15 完成：用户选定 `app.ezarouter.cc`，staging 保持 workers.dev；Zone 在本账号且 active，该主机名公共 DNS 为 NXDOMAIN。本机 OAuth 无 DNS 读取权限，Workers 自定义域名绑定在 2.1 / 3.3 首次部署时验证；生产 CI token 的 Zone 权限见 1.4。见 [production runbook §1a](../../../docs/runbooks/production-neon.md)。
- [x] 1.3 **BLOCKED（用户选定备份存储并提供凭据）**：创建开启对象锁定的独立备份 bucket（R2 Bucket Lock 或非 Cloudflare S3 兼容存储），生成 age 密钥对，私钥离线保存。验证：bucket 锁定策略与保留期限截图/命令输出脱敏记录；公钥写入 runbook，私钥不进仓库与 CI。
  - 2026-10-15 完成：R2 桶 `saas-production-backups`，Bucket Lock 30 天、生命周期 35 天过期，r2.dev 关闭；age 公钥写入 runbook §5，私钥在开发机仓库外（600），离线两份副本由用户保存并在 4.2 验证。
- [x] 1.4 **BLOCKED（用户指定审批人）**：创建 GitHub `production` environment，配置必需审批人与生产迁移、Cloudflare（token 需含 Zone `ezarouter.cc` 的 Workers Routes 编辑权限）、备份 secrets。验证：PR 与 staging workflow 中无法读取这些 secrets；secrets 名称清单写入 runbook。
  - 2026-10-15 进展：`production`（审批人 ustclhx、仅 `v*` tag）与 `production-backup`（无审批、仅 main，供每日定时备份）已创建；数据库凭据、账号 ID 与备份变量已写入。待用户创建生产 `CLOUDFLARE_API_TOKEN` 与 R2 备份密钥后勾选，见 runbook §6。
  - 2026-10-16 完成：用户在真实终端重写 `CLOUDFLARE_API_TOKEN`（production）与 R2 备份密钥（production-backup）；`gh secret list` 核对名称与写入时间，仓库级 secrets 为空。值在 3.3 首次发布与 4.1 首次备份时实际验证。见 production runbook §6。

## 2. production 环境配置

- [x] 2.1 创建生产 Hyperdrive（缓存/非缓存，非 pooled TLS 直连 app 角色）、KV、Queues、Workflows、R2 与限流命名空间，并在 web / jobs `wrangler.jsonc` 增加 `env.production`（`SENTRY_ENVIRONMENT=production`，不设 `PAYMENT_MODE`，测试期 `CRON_PROFILE=reduced`、对外开放注册前改回默认 profile，自定义域名路由）。验证：两 app `wrangler deploy --dry-run --env production` 通过；新增脚本比较 staging 与 production 的绑定名集合一致并纳入 `pnpm check`；无任何 staging 资源 ID 出现在 production 段。
  - 2026-10-15 进展：用户批准后资源已创建（ID 见 production runbook §8 执行记录），两个 `wrangler.jsonc` 已加 `env.production`（Worker 自定义域名 `app.ezarouter.cc`，关闭 workers.dev / preview URL）；`scripts/production/check-wrangler-envs.mjs` 纳入 `pnpm check`（绑定名一致、无 staging ID / 名称、禁设 PAYMENT_MODE 与 AI_FAULT_INJECTION，单测含反例）。用户批准后经 API 新建 Turnstile 站点 `saas-production`（仅 `app.ezarouter.cc`，managed），站点 key 写入 web `env.production.vars`、密钥存开发机 600 文件供 2.2；jobs dry-run 与 web 生产构建（预渲染无 env.invalid）+ 部署 dry-run 均通过，2.1 完成。
  - 同批修复生产会触发的缺陷：jobs 队列分发只认 `email|events(-staging)`，`*-production` 会抛 `Unknown queue`；`presign.ts` 文件桶白名单只含 `files|files-staging`，生产上传会 503。两处加入 production 名称并补测试（备份桶仍被拒绝）。生成器同步识别 `-production` 后缀并把模板生产域名替换为占位值，避免新项目复用本项目域名与资源名。
- [x] 2.2 写入生产 Wrangler secrets（auth、邮件、AI、Sentry、通知等，支付除外）并在 runbook 列出名称与来源。验证：`wrangler secret list --env production` 名称与清单一致；本 change 不写入支付 secrets。
  - 2026-10-16 完成：`wrangler secret list --name web-production / jobs-production` 名称与 runbook §9 清单一致，无支付 secrets；jobs 的 `EMAIL_TRANSPORT=resend` 与 `EMAIL_FROM` 由用户以 secret 写入（不再声明同名 var）。可选项 `SENTRY_DSN`、`BOOTSTRAP_ADMIN_EMAILS` 未配置。

## 3. 生产发布流水线

- [x] 3.1 新增 `.github/workflows/deploy-production.yml`：`v*` tag 触发，前置校验 tag 提交在 main 历史上且存在该 SHA 成功的 `Deploy staging` run，再进入 `production` environment 作业，按迁移 → jobs → web → `wait-healthy.mjs` 完整 SHA 执行；`concurrency` 串行不取消；提供 `workflow_dispatch` 回滚入口。验证：对未经 staging 的 SHA 打测试 tag 时在迁移前失败；actionlint 通过；日志无连接串。
  - 2026-10-15 进展：`deploy-production.yml` 与 `scripts/production/check-release.mjs`（单测 4 项纳入 `pnpm check`；真实 git/gh 下 main 提交通过、非 main 提交失败）已交付，actionlint 通过；Sentry 未配置时跳过上传但仍删除客户端 map。#222 合并后对非 main 提交 `667ecaf` 推送测试 tag `v0.0.0-verify-1`：run 38717565372 的 `verify` 失败（not on main）、`deploy` 跳过，未迁移、未请求审批、日志无连接串；测试 tag 已删除。实际部署依赖 2.1 的 `env.production`，在 3.3 首次发布时验证。
- [x] 3.2 新增 Playwright `production` project 的只读冒烟（首页、定价页、`/api/health`），流水线失败时上传 trace。验证：本地对 staging 域名以 production project 运行通过；用例中无注册、支付或写请求。
  - 2026-10-15 完成：`apps/web/e2e/production/smoke.spec.ts` 只发 GET（首页、定价页、`/api/health`，设置 APP_VERSION 时校验版本）；`PRODUCTION_URL=<staging>` 本地运行 3/3 通过；默认本地运行与 staging project 均不包含该目录；失败上传 trace 在 `deploy-production.yml`。
- [ ] 3.3 首次生产发布：推送首个 tag，完成迁移、seed 与冒烟。验证：健康返回完整 SHA 与 `db.up`；Cron 心跳推进；生产库无冒烟账号；证据写入 `docs/runbooks/evidence/production/`。

## 4. 备份与恢复

- [ ] 4.1 新增每日备份 workflow：`readonly` 角色 `pg_dump -Fc` → age 加密 → 上传到 1.3 的 bucket；失败时 workflow 失败并经内部通知渠道告警。验证：手动触发一次成功，bucket 中出现加密对象且无法用无私钥方式读取；故意使用错误凭据时任务失败并告警，已有对象不变。
  - 2026-10-15 进展：`backup-production.yml`（`production-backup` 环境；定时需仓库变量 `PRODUCTION_BACKUP_SCHEDULE=true`）与 `scripts/production/backup.sh`（PG17 容器 `pg_dump` → age → R2 put + head 校验大小）已交付，actionlint 通过；本地 dry run 生成有效加密文件。告警使用 GitHub 对失败 workflow 的通知。待：生产执行 `GRANT pg_read_all_data TO readonly`（readonly 无 drizzle schema 权限，见 production runbook §8.A）、R2 密钥写入后手动触发验证。
- [ ] 4.2 编写 `docs/runbooks/restore.md` 与校验脚本（迁移记录、关键表行数、积分对账不变式），完成两条路径的恢复演练：Neon 时间点临时分支、解密逻辑备份恢复到临时目标。验证：两次校验通过，记录 RTO / RPO，临时分支已删除，生产主分支未受影响。
  - 2026-10-15 进展：`docs/runbooks/restore.md` 与 `scripts/production/verify-restore.mjs`（单测 3 项；规则同自托管恢复演练与 `reconcileWorkspaceCredits`）已交付。本地加密备份 → 解密 → `pg_restore` 到临时库校验五项通过，人为删除一条迁移记录后判定失败；临时库已删除。两条生产路径演练待首次发布与首个真实备份后执行。

## 5. 观测与基线

- [ ] 5.1 生产延迟基线与放置评估：测 Hyperdrive → Neon 的读写与事务往返，对比 Smart Placement 开关；区域非 `aws-us-west-2` 时重跑锁探针七场景。验证：结果写入 `docs/07-infrastructure.md` §8，注明日期与区域。
- [ ] 5.2 生产 Sentry release / source map 与告警：确认 tag 发布上传 maps、生产异常可读，备份失败与健康 503 有通知。验证：触发一次受控测试异常得到可读堆栈；告警渠道收到测试通知。

## 6. 支付 live（Q9 决定后）

- [ ] 6.1 **BLOCKED（Q9 正式收款主体）**：按 `docs/05-billing.md` §8 清单配置 live 凭据、价格对象与 webhook，设置 `PAYMENT_MODE=live`，完成受控真实付款、退款与对账验收。验证：05 §8 清单逐项勾选并附证据；后台显示 live 模式。

## 7. 汇总

- [ ] 7.1 协调者核对 1–5 证据（6 视 Q9 状态单列），更新 `docs/08-roadmap.md` 与 `docs/07-infrastructure.md` §0 为已上线状态，`openspec validate add-cloud-production-neon --strict` 通过。验证：路线图「Cloudflare 生产上线」逐项与证据对应；归档只由协调者执行。
