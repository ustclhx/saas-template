# Proposal

## Why

A 的 Node/Compose 基础和 B 的 DBOS 任务引擎已经合入，但还没有可拉取的正式镜像、可核验的发布流程或可演练的数据库恢复交付。D 补齐供应商无关的单机交付，使生成的新项目能够部署、重启恢复和从备份恢复，同时保持 Cloudflare 为主目标。

## What Changes

- CI 构建 linux/amd64 与 linux/arm64 镜像，默认推送 GHCR，以完整 git SHA 标记 web/jobs/migrate 及 Compose 所需的配套镜像；服务器只拉取镜像。（P1）
- 官方交付为 plain Compose；Dokploy 为推荐且可选的运维层，导入同一 Compose，关闭 Caddy 并使用 Dokploy 自带 Traefik。
- 提供 SSH 部署脚本，以 `docker compose pull && docker compose up -d` 更新；显式保障迁移顺序、jobs 退出和持久 ownership，自动检查 health 的完整 SHA，失败给出兼容性受限的回滚命令。（P2、P3）
- 提供新 Ubuntu/Debian 的一条命令初始化入口：Docker Engine/Compose v2、防火墙 22/80/443、无真值 `.env` 骨架及后续 secret/TLS 配置步骤。仅适用于明确选择的空白服务器。（P4）
- `create-project --target selfhost` 生成自托管配置、镜像发布和运维材料；支持关闭 billing、credits、营销、i18n 后构建运行。**BREAKING**：现有用于输出目录的 `--target <path>` 改为 `--output <path>`，`--target` 专用于 `cloudflare|selfhost`，默认仍为 Cloudflare；交互提示和文档同步迁移。（P5）
- WAL-G 每日基础备份与持续 WAL 归档到可配置 S3，默认保留 7 天每日与 4 周每周备份；每日 pg_dump；新服务器 PITR 脚本/runbook、隔离恢复演练和第二供应商副本。（B1–B5）
- 验收项 7：S3 备份恢复到本地或服务器临时实例，指定时间点的数据校验通过。验收项 8：服务器重启后全部常驻服务自动恢复，health 返回目标完整 SHA。服务器验收保持阻塞，等待用户选择主机、入口和运维方式。

### 2026-10-16 服务器验收范围更新

用户已授权复用 `product-res-ecs` 与模板 Caddy，并选择 R2 业务桶、主备份桶和同账号独立副本桶/token。7.2 以主目标凭据不可用时副本独立恢复为验收，记录「失去供应商独立性」与账号级共同故障风险；通用跨供应商复制能力保留。7.3 整机 reboot 窗口已追加获准，须在部署/ACME/6.4/7.2 完成后执行，并保持非 selfhost 停止服务不自启；空白主机 init 不适用于这台共用主机。

### Scope and boundaries

本 change 仅覆盖 P1–P5、B1–B5 与需求 §6 验收项 7、8。依赖 A 的安全入口/三角色/TLS/health 和 B 的同版本恢复契约；复用 C 后续提供的通用存储/邮件/监控能力，不在 D 实现这些业务适配器。备份覆盖 PG 业务及 `job_engine`、`dbos` 元数据，外部用户对象、部署密钥与证书的恢复边界必须写清。

本提案 PR 只包含 `openspec/changes/add-selfhost-delivery/`；所有实施任务未勾选，不发布镜像、不部署、不安装 Dokploy、不连接既有新加坡 ECS。该 ECS 的容量与端口约束和备选方案见 design Open Questions，提案不预设部署到它。

## Capabilities

### New Capabilities

- `selfhost-deployment`：沿用 A 尚未同步到主规格的同名 capability，追加多架构镜像、部署/SHA/回滚、初始化、Dokploy 和主机重启交付要求，不复制或改写 A 的基础要求。
- `project-bootstrap`：沿用已有进行中 change 的同名 capability，追加目标选择、功能裁剪和自托管 secret/运维配置生成要求。
- `database-backup-recovery`：基础备份、连续归档、逻辑备份、保留期、PITR、恢复演练与跨供应商副本。

### Modified Capabilities

无。以上前两个路径目前尚不在 `openspec/specs/`；D 使用 ADDED delta，协调者同步时与原 change 的不同 requirement 合并。现有 `system-health` / `staging-deployment` 契约继续适用，D 只消费 health，不重定义健康语义、不调整 CF staging 流程。

## Impact

后续实施涉及 `.github/workflows/` 自托管镜像发布、`deploy/selfhost/` 镜像配置/部署/初始化/备份脚本、`scripts/create-project*`、模板功能配置及对应 Node 构建注册、`docs/create-project.md` 与 selfhost runbook。基础 PG 镜像需要 WAL-G，备份执行器需要受限 secret 与 PG 数据读取；构建、恢复均在隔离环境验证。共享 manifest/lockfile、server/config 和模板开关由协调者指定唯一 owner 串行集成，不修改既有 `infra/postgres` 的 CF 生产配置或 worker 迁移 SQL。
