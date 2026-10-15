# Tasks

## 1. 资源与决策（用户门，协调者执行）

- [ ] 1.1 **BLOCKED（用户开通 Neon 付费计划并选定区域）**：新建 Neon 生产项目（PG 17），按 `docs/runbooks/staging-neon.md` §1–2 以 SQL 创建受限 `migrator` / `app` / `readonly`，执行权限脚本，确认计划的 PITR 保留窗口。验证：三角色无高权限 flags 与 `neon_superuser` 成员身份；app DDL、readonly 写入被拒；新增 `docs/runbooks/production-neon.md` 记录项目、区域、计划与 PITR 窗口（不含凭据）。
- [ ] 1.2 **BLOCKED（用户提供生产域名与 DNS 权限）**：确定 production web 域名（可先用已有 Zone 的子域），记录在 production runbook。验证：Zone 归属与 DNS 权限可用，域名写入 runbook。
- [ ] 1.3 **BLOCKED（用户选定备份存储并提供凭据）**：创建开启对象锁定的独立备份 bucket（R2 Bucket Lock 或非 Cloudflare S3 兼容存储），生成 age 密钥对，私钥离线保存。验证：bucket 锁定策略与保留期限截图/命令输出脱敏记录；公钥写入 runbook，私钥不进仓库与 CI。
- [ ] 1.4 **BLOCKED（用户指定审批人）**：创建 GitHub `production` environment，配置必需审批人与生产迁移、Cloudflare、备份 secrets。验证：PR 与 staging workflow 中无法读取这些 secrets；secrets 名称清单写入 runbook。

## 2. production 环境配置

- [ ] 2.1 创建生产 Hyperdrive（缓存/非缓存，非 pooled TLS 直连 app 角色）、KV、Queues、Workflows、R2 与限流命名空间，并在 web / jobs `wrangler.jsonc` 增加 `env.production`（`SENTRY_ENVIRONMENT=production`，不设 `PAYMENT_MODE`，默认 Cron profile，自定义域名路由）。验证：两 app `wrangler deploy --dry-run --env production` 通过；新增脚本比较 staging 与 production 的绑定名集合一致并纳入 `pnpm check`；无任何 staging 资源 ID 出现在 production 段。
- [ ] 2.2 写入生产 Wrangler secrets（auth、邮件、AI、Sentry、通知等，支付除外）并在 runbook 列出名称与来源。验证：`wrangler secret list --env production` 名称与清单一致；本 change 不写入支付 secrets。

## 3. 生产发布流水线

- [ ] 3.1 新增 `.github/workflows/deploy-production.yml`：`v*` tag 触发，前置校验 tag 提交在 main 历史上且存在该 SHA 成功的 `Deploy staging` run，再进入 `production` environment 作业，按迁移 → jobs → web → `wait-healthy.mjs` 完整 SHA 执行；`concurrency` 串行不取消；提供 `workflow_dispatch` 回滚入口。验证：对未经 staging 的 SHA 打测试 tag 时在迁移前失败；actionlint 通过；日志无连接串。
- [ ] 3.2 新增 Playwright `production` project 的只读冒烟（首页、定价页、`/api/health`），流水线失败时上传 trace。验证：本地对 staging 域名以 production project 运行通过；用例中无注册、支付或写请求。
- [ ] 3.3 首次生产发布：推送首个 tag，完成迁移、seed 与冒烟。验证：健康返回完整 SHA 与 `db.up`；Cron 心跳推进；生产库无冒烟账号；证据写入 `docs/runbooks/evidence/production/`。

## 4. 备份与恢复

- [ ] 4.1 新增每日备份 workflow：`readonly` 角色 `pg_dump -Fc` → age 加密 → 上传到 1.3 的 bucket；失败时 workflow 失败并经内部通知渠道告警。验证：手动触发一次成功，bucket 中出现加密对象且无法用无私钥方式读取；故意使用错误凭据时任务失败并告警，已有对象不变。
- [ ] 4.2 编写 `docs/runbooks/restore.md` 与校验脚本（迁移记录、关键表行数、积分对账不变式），完成两条路径的恢复演练：Neon 时间点临时分支、解密逻辑备份恢复到临时目标。验证：两次校验通过，记录 RTO / RPO，临时分支已删除，生产主分支未受影响。

## 5. 观测与基线

- [ ] 5.1 生产延迟基线与放置评估：测 Hyperdrive → Neon 的读写与事务往返，对比 Smart Placement 开关；区域非 `aws-us-west-2` 时重跑锁探针七场景。验证：结果写入 `docs/07-infrastructure.md` §8，注明日期与区域。
- [ ] 5.2 生产 Sentry release / source map 与告警：确认 tag 发布上传 maps、生产异常可读，备份失败与健康 503 有通知。验证：触发一次受控测试异常得到可读堆栈；告警渠道收到测试通知。

## 6. 支付 live（Q9 决定后）

- [ ] 6.1 **BLOCKED（Q9 正式收款主体）**：按 `docs/05-billing.md` §8 清单配置 live 凭据、价格对象与 webhook，设置 `PAYMENT_MODE=live`，完成受控真实付款、退款与对账验收。验证：05 §8 清单逐项勾选并附证据；后台显示 live 模式。

## 7. 汇总

- [ ] 7.1 协调者核对 1–5 证据（6 视 Q9 状态单列），更新 `docs/08-roadmap.md` 与 `docs/07-infrastructure.md` §0 为已上线状态，`openspec validate add-cloud-production-neon --strict` 通过。验证：路线图「Cloudflare 生产上线」逐项与证据对应；归档只由协调者执行。
