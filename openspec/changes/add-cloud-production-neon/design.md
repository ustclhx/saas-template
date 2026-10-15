# Design

## Context

- staging：Neon 项目 `saas-staging`（2026-10-15 随组织升级为 Launch 计费，计算 0.25–2 CU）（PG 17、`aws-us-west-2`），受限三角色由 SQL 创建，Hyperdrive 缓存/非缓存两个绑定走非 pooled TLS 直连；main CI 成功后 `deploy-staging.yml` 按迁移 → jobs → web → 健康 SHA → 冒烟发布（见 `docs/runbooks/staging-neon.md`、`openspec/specs/staging-deployment`）。
- web / jobs 的 `wrangler.jsonc` 只有顶层（本地）与 `env.staging`；hyperdrive / workflows / queues / kv / ratelimits / vars 不从顶层继承，每个环境都要重新声明。
- `payment-mode` 已规定：staging、production 缺少 `PAYMENT_MODE` 时关闭支付；`billing:sync` 只允许 test。Q9（正式收款主体）未决。
- 原阶段二方案（自建 PG + cloudflared + Workers VPC）已由 2026-10-15 用户决定替换；自托管形态的 PG、WAL-G 与 PITR 属于 `add-selfhost-*`，本 change 不复用其服务器脚本。

## Goals / Non-Goals

**Goals:**
- 生产环境可由 tag 受控发布、可确认版本、可回滚。
- 生产数据可按时间点与独立逻辑备份两条路径恢复，并有演练证据。
- 资源与凭据和 staging 完全隔离，配置全部可在仓库中审阅（secrets 除外）。

**Non-Goals:**
- 不升级 staging 的 Neon 计划，不改 main → staging 自动发布。
- 不在本 change 内开通 live 支付（Q9 未决）；只保证未配置时支付安全关闭。
- 不做多区域、读副本或自动故障切换。

## Decisions

**D1 Neon 生产项目独立于 staging。** 新建项目而非在 staging 项目中加分支：计划与账单、PITR 窗口、访问控制与删除风险都按项目隔离，staging 可继续 Free。备选「同项目 production 分支」省一个项目，但 staging 误操作或配额会波及生产，否决。角色创建沿用 staging runbook §1–2 的 SQL 流程（Console 建角会带 `neon_superuser`）。

**D2 区域与连接。** 默认与 staging 相同的 `aws-us-west-2`，复用已验证的 Hyperdrive → Neon 锁探针结论；若目标用户集中在其他地区，由用户在 1.1 选定区域后重跑锁探针与延迟基线（5.1）。仍使用非 pooled 直连 + Hyperdrive 连接池，不叠加 Neon pooler（事务级锁与 advisory lock 依赖会话语义）。

**D3 tag 触发 + environment 审批 + staging 前置校验。** `deploy-production.yml` 监听 `v*` tag；第一步用 GitHub API 校验 tag 提交在 main 历史上，且存在该 SHA 成功的 `Deploy staging` run，再进入需审批的 `production` environment 作业。备选「main 合并直接发生产」风险过高；「手动 workflow_dispatch 输入 SHA」可作为回滚入口（重新发布旧 tag 对应 SHA，迁移须向前兼容）。`concurrency` 串行且不取消。

**D4 只读生产冒烟。** 新增 Playwright `production` project，仅访问首页、定价页与 `/api/health`；注册类用例只保留在 staging，避免生产出现测试账号和邮件发送。

**D5 逻辑备份在 GitHub Actions 中运行。** 备份作业使用独立的 `production-backup` environment（无审批、仅 main），只持有 readonly 凭据与备份桶写入密钥；需审批的 `production` environment 不能用于每日定时任务。每日 schedule workflow 用 `readonly` 角色执行 `pg_dump -Fc`，以 age 公钥加密后上传到独立 bucket（默认 R2 + Bucket Lock；用户也可选非 Cloudflare 的 S3 兼容存储以获得供应商隔离），私钥离线保存不进 CI。备选「Worker 内导出」无法运行 pg_dump；「Neon 自带快照」与 PITR 同供应商，不满足独立副本，故两者并存。失败通过 workflow 失败通知 + 现有内部通知渠道告警。

**D6 恢复演练。** 时间点路径：在 Neon 从生产主分支创建指定时间点的临时分支；逻辑路径：解密后 `pg_restore` 到临时 Neon 分支或本地 Docker PG。两者运行同一校验脚本（迁移记录、关键表行数、积分对账不变式），记录 RTO / RPO 到 `docs/runbooks/restore.md`，演练后删除临时分支。

**D7 Cron 与成本。** 生产计算为 autoscaling 0.25–1 CU、PITR 7 天（2026-10-15 用户确认）。测试期（首次发布到对外开放注册之间）生产使用 staging 已验证的 `CRON_PROFILE=reduced`，compute 可缩容，约 $4/月；对外开放注册前改回默认频率，接受 compute 基本常驻（0.25 CU 约 $20–25/月）。上线首月用 Neon Usage 复核费用，再调整 autoscaling 上限。

**D8 支付关闭上线。** Q9 未决时生产不设置 `PAYMENT_MODE` 与支付 secrets，营销定价显示支付不可用；Q9 决定后单独执行 05 §8 清单（任务组 6）。

## Risks / Trade-offs

- [Neon 单供应商故障或账号问题] → 每日加密逻辑备份存放在独立存储，演练证明可脱离 Neon 恢复到任意 PG 17。
- [tag 发布不兼容的迁移导致回滚困难] → 迁移保持向前兼容（先加后删），回滚只回退 Worker 版本，不回滚 schema；破坏性迁移需单独评审。
- [compute 常驻导致成本高于预期] → 首月复核 Usage，必要时调整 autoscaling 或 Cron 合并。
- [备份加密私钥丢失则备份不可用] → 私钥由用户离线保存两份，演练时验证可解密。
- [生产与 staging 配置漂移] → `env.production` 与 `env.staging` 在同一文件中，增加一致性检查脚本比较两环境的绑定名集合。

## Migration Plan

1. 用户准备资源（任务组 1）后，配置与流水线以 PR 合入 main；合并本身不触发生产发布。
2. 首次推送 tag 发布空库生产环境，执行 seed（套餐结构；价格同步在 Q9 后）并完成只读冒烟。
3. 完成首次恢复演练后，才对外开放注册。
4. 回滚：用 `workflow_dispatch` 重新发布上一 tag 的 SHA；数据问题按 restore runbook 从时间点分支恢复。

## Open Questions

- 生产 Neon 区域：默认 `aws-us-west-2`，用户可在 1.1 改选，不影响任务拆分。
- 逻辑备份存储供应商：R2 Bucket Lock 或非 Cloudflare S3 兼容存储，由用户在 1.3 选定；workflow 只依赖 S3 API。
