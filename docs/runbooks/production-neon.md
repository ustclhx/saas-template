# Neon production 操作与验收

生产使用独立于 staging 的 Neon 项目与数据库，计划、区域、备份保留期和预算由项目负责人选择。先完成 [staging-neon](staging-neon.md) §1–2 的建库与受限角色流程，再按本文配置生产资源、备份与发布门。示例资源名由生成器改为本项目名称；资源 ID、账号、域名与凭据由项目自身配置。

<!-- template-only:start -->
> **实例状态（2026-10-18）**：用户确认拆除模板演示的生产实例与自托管测试实例。`saas-production` Neon 项目及生产 Workers、KV、Queues、Hyperdrive、Turnstile、空文件桶和 GitHub `production` environment 已删除；备份开关变量 `PRODUCTION_BACKUP_SCHEDULE` 已删除。生产备份桶已解除 `retain-30d` 锁并设为所有对象 1 天后过期，待次日核空删除；Sentry Uptime 监控待用户手动删除。完整结果与手动收尾见拆除记录（私有证据库 `saas-template-evidence:teardown-2026-10-18.md`）。下文为历史验收与派生项目操作参考，原资源 ID、凭据路径及已写入状态不代表仍可使用；`env.production` 与 workflow 保留，重新上线须创建项目自身资源和凭据。GitHub `production-backup` environment 本次未在删除范围内，仍保留。

本 runbook 对应 `add-cloud-production-neon`（2026-10-15 用户决定：Cloudflare 形态生产数据库使用 Neon 付费档，不自建 PG）。流程沿用 [staging-neon](./staging-neon.md) §1–2，本文只记录生产项目的事实与差异，不含任何凭据。

<!-- template-only:end -->

## 1. 项目

核对组织与区域，创建独立项目 `saas-production`、Postgres 17、数据库 `saas_production`；确认默认分支与非 pooled endpoint，不从 staging 复制资源 ID 或凭据。以下参数先由项目负责人选择，`--no-secrets` 避免输出密码：

```sh
neonctl projects create --org-id "${NEON_ORG_ID:?选择本项目组织}" --name saas-production \
  --region-id "${NEON_REGION_ID:?选择本项目区域}" --pg-version 17 \
  --database saas_production --role neondb_owner --no-secrets --output json
```

核对项目与默认分支归属，将 endpoint、数据库 owner、PITR 与计算配置记入本项目私有运维记录。

<!-- template-only:start -->
## 1. 项目（任务 1.1，2026-10-15）

| 项 | 值 |
|---|---|
| 组织 | `Haixin`（`org-ancient-mountain-81615147`），计划 **Launch**（用户 2026-10-15 升级） |
| 项目 | `saas-production`（`super-resonance-99115167`），独立于 staging 项目 `saas-staging` |
| 区域 / 版本 | `aws-us-west-2`（用户选定，与 staging 一致，沿用已验证的 Hyperdrive 锁探针结论）/ Postgres 17 |
| 默认分支 | `main`（`br-cold-morning-ar2z16iw`）；staging 默认分支名为 `production`，两者不要混淆 |
| 读写 endpoint | `ep-morning-resonance-arum7105`（非 pooled 主机名，不带 `-pooler`） |
| 数据库 | `saas_production`，owner `migrator`；创建时默认 owner 为 `neondb_owner` |
| PITR 保留 | 7 天（创建时默认 1 天），见 §4 |
| 计算 | autoscaling 0.25–1 CU（创建时默认固定 1 CU），`suspend_timeout_seconds = 0`（平台默认 5 分钟缩容），见 §4 |

创建命令（`--no-secrets` 不在输出中打印密码）：

```sh
neonctl projects create --org-id org-ancient-mountain-81615147 --name saas-production \
  --region-id aws-us-west-2 --pg-version 17 --database saas_production --role neondb_owner \
  --no-secrets --output json
```

<!-- template-only:end -->

## 1a. 生产域名

核对本项目生产域名的 Zone、DNS 占用、账户权限及 TLS。web `env.production.routes` 使用 `custom_domain: true`，`APP_URL` 与实际 HTTPS 域名一致；已有同名 DNS 记录先核对用途，不直接覆盖。CI token 需有目标 Zone 的 Workers Routes 权限及实际资源所需账号权限。

域名同时用于 Google/GitHub OAuth 回调 `/api/auth/callback/<provider>`、Turnstile 允许的 hostname、支付 webhook `/api/billing/webhooks/<provider>`、生产只读冒烟 URL 与文件桶 CORS。邮件发件域在服务商验证，按要求设置 SPF/DKIM 等 DNS 记录。staging 使用独立 URL 与测试凭据。

<!-- template-only:start -->
## 1a. 生产域名（任务 1.2，2026-10-15）

- 用户选定 production web 域名 **`app.ezarouter.cc`**；staging 保持 `web-staging.saas-jobs.workers.dev`，不绑定自定义域名。
- Zone `ezarouter.cc`（`c6b12cacca002dc21f9b24370d4a5bd7`）在本 Cloudflare 账号 `170a06d3…` 下，`active`，Free Website 计划；NS 为 Cloudflare（`bingo` / `damien`）。apex 已在使用（Cloudflare 代理），不改动 apex 及其他记录。
- `app.ezarouter.cc` 公共 DNS（DoH `cloudflare-dns.com`）查询 A/AAAA/CNAME 均为 NXDOMAIN，未被占用。本机经代理的普通 `dig` 返回 `198.18.x.x`（fake-ip），不能作为依据。
- 绑定方式：web Worker `env.production` 的 Workers 自定义域名（`routes` 中 `custom_domain: true`），由 Cloudflare 自动建 DNS 记录与证书；存在同名 DNS 记录时绑定失败而不会覆盖。
- 权限：本机 wrangler OAuth 有 `zone (read)`、`workers_routes (write)`、`ssl_certs (write)`，无 DNS 读取权限（DNS records API 返回 Authentication error），实际绑定在 2.1 / 3.3 首次部署时验证。CI 使用的生产 Cloudflare API token（任务 1.4）须对 Zone `ezarouter.cc` 具备 Workers Routes 编辑权限，不能直接沿用只含账号级权限的 staging token。

域名确定后连带的配置（在对应任务中完成）：

| 用途 | 地址 / 动作 | 任务 |
|---|---|---|
| 应用 URL 与认证回调 | `APP_URL=https://app.ezarouter.cc`；Google / GitHub OAuth 生产应用回调登记该域名 | 2.1 / 2.2 |
| 邮件发件域 | 生产发件地址所用域名需在邮件服务商验证，并按其要求在 DNS 增加 SPF / DKIM 记录（需用户在控制台操作或授予 DNS 编辑权限） | 2.2 |
| Turnstile | 生产站点 hostname 加入 `app.ezarouter.cc` | 2.2 |
| 支付 webhook（Q9 后） | `https://app.ezarouter.cc/api/billing/webhooks/stripe`、`/paypal` | 6.1 |
| 只读冒烟 | Playwright `production` project 的 baseURL | 3.2 |

<!-- template-only:end -->

## 2. 受限角色与凭据

按 [staging-neon §1](staging-neon.md#1-建库受限角色与本地凭据) 以 **SQL** 创建 `migrator` / `app` / `readonly`（NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOREPLICATION、NOBYPASSRLS），`GRANT migrator TO neondb_owner` → `ALTER DATABASE saas_production OWNER TO migrator` → `REVOKE migrator FROM neondb_owner`；再以 migrator 执行 `infra/local/initdb/02-db-grants.sql`。

**Neon 密码设置**：Neon 控制面拒绝预先计算的 SCRAM 校验值（`ALTER ROLE ... PASSWORD 'SCRAM-SHA-256$...'` 返回 `Neon only supports being given plaintext passwords`），psql `\password` 同样在客户端加密，因此不可用。设置方式：脚本用 `crypto.randomBytes(32)` 生成 64 位十六进制密码，`ALTER ROLE ... PASSWORD '<明文>'` 只经 psql **stdin** 与 TLS 发送；连接参数通过 `PG*` 环境变量传入，连接串与密码不出现在命令参数、shell 历史或输出中。默认 owner 连接串由 `neonctl connection-string main --role-name neondb_owner` 取得后只在脚本内存中使用。

三个非 pooled 直连 URL（`sslmode=require`）保存在当前 checkout 被忽略的 `.env.production-neon`（600），键名 `NEON_MIGRATOR_URL`、`NEON_APP_URL`、`NEON_READONLY_URL`。该文件只用于运维与恢复演练；CI 迁移凭据按 §6 写入 GitHub `production` environment。

```sh
set -a; . ./.env.production-neon; set +a
psql "$NEON_MIGRATOR_URL" -X -c 'select current_user, current_database()'   # 应为 migrator | saas_production
```

## 3. 权限与迁移验证

按 [staging-neon §2](staging-neon.md#2-权限迁移与-seed) 执行 `infra/local/initdb/02-db-grants.sql` 与迁移。核对数据库和 public schema owner 均为 migrator，app/readonly 只有预期权限，三角色高权限 flags 与 `neon_superuser` 成员身份均为 false。

迁移记录数应等于 journal 条目数。app 建表、修改审计日志与 readonly 写业务表均应被拒绝；每次权限探测使用独立事务并 ROLLBACK。billing 启用时仅在确认目标库、角色和支付模式后 seed / sync；验证完成不自动接入 live 支付。

<!-- template-only:start -->
## 3. 验证结果（2026-10-15）

- 身份：owner、migrator、app、readonly 分别返回 `<角色> | saas_production`。
- 数据库 owner 与 public schema owner 均为 `migrator`；public ACL 为 `{migrator=UC/migrator,app=U/migrator,readonly=U/migrator}`。
- 三角色 `rolsuper / rolcreatedb / rolcreaterole / rolreplication / rolbypassrls` 均为 false，`pg_has_role(rolname,'neon_superuser','MEMBER')` 均为 false。
- 拒绝验证（独立事务、ROLLBACK）：app `CREATE TABLE public.t` → `permission denied for schema public`；readonly `CREATE TABLE public.t` → 同上；app `CREATE SCHEMA` → `permission denied for database saas_production`。
- 尚未迁移（0 张业务表）：app 修改 `audit_log`、readonly 写业务表的拒绝验证在首次生产发布（任务 3.3）迁移后执行，届时迁移记录数应等于 `packages/db/migrations/meta/_journal.json` 条目数。

<!-- template-only:end -->

## 4. 项目设置与预算

按恢复目标选择 PITR 保留期、计算上下限与缩容策略，核对当前计划支持范围和组织内其他项目的计费影响。发布后用 Neon Usage 与实际 Cron 频率复核预算；持续定时唤醒可能阻止缩容。记录本项目配置和观察结果，价格与配额以当前平台计划为准。

<!-- template-only:start -->
## 4. 项目设置与费用（2026-10-15 用户按推荐配置确认）

用户在组织升级 Launch 后按以下推荐配置确认，已经 Neon API（`neonctl api ... -X PATCH`）修改并回读核对：

| 项 | 创建时默认 | 现值 |
|---|---|---|
| 生产 PITR 保留 | 1 天 | **7 天**（`history_retention_seconds = 604800`，Launch 上限） |
| 生产计算 | 固定 1 CU | **autoscaling 0.25–1 CU**（endpoint 与项目默认值），缩容沿用平台默认 5 分钟 |
| staging 计算上限 | 0.25–8 CU（升级后） | **0.25–2 CU**（两个 endpoint 与项目默认值） |

**费用依据**（[Neon 定价](https://neon.com/pricing)，2026-10-15 查询，Launch）：$0.106/CU-hour、$0.35/GB-月、PITR history $0.20/GB-月，每项目含 10 个分支与 500 GB 出流量，无月度最低消费。升级为组织级：同组织的 `saas-staging` 与无关项目 `yingshu` 也按量计费，不再受 Free 的 100 CU-hours 上限保护。

**估算（每月，待 Usage 复核）**：生产首次发布前接近 $0；发布后默认 Cron 使 compute 基本常驻，0.25 CU 空闲约 183 CU-hours ≈ $20–25（固定 1 CU 时约 $77）；测试期生产使用 `CRON_PROFILE=reduced` 时约 33 CU-hours ≈ $4（见提案 2.1 / D7）；存储与 7 天 history 低于 $0.1；staging 约 $4，验收期另加 $1–3。

<!-- template-only:end -->

## 5. 逻辑备份存储与加密

创建与用户文件桶分离的私有备份桶，关闭公开访问：

```sh
pnpm --dir apps/web exec wrangler r2 bucket create saas-production-backups
```

在 R2 配置并回读保留策略，例如 Bucket Lock `retain-30d`（全部前缀，30 天不可删除/覆盖）、生命周期 `expire-35d`（35 天过期，晚于锁定期）、中止未完成分片。保留期按项目恢复目标确认，调整时保持生命周期晚于锁定期。备份 S3 token 仅授权此桶对象读写，与文件桶 token 分开。

生成本项目独立 age 密钥，私钥目录 700、文件 600，私钥不进入仓库或 CI：

```sh
install -d -m 700 "$HOME/.config/saas-template"
(umask 077; age-keygen -o "$HOME/.config/saas-template/production-backup.agekey")
age-keygen -y "$HOME/.config/saas-template/production-backup.agekey"
```

仅将最后命令输出的公钥写入 `BACKUP_AGE_RECIPIENT`，私钥保存两份离线副本；验证一次加解密往返和离线副本恢复。备份上传前 age 加密，数据库只读角色授权见 §8；备份/恢复脚本与演练见 [restore](restore.md)。

<!-- template-only:start -->
## 5. 逻辑备份存储与加密（任务 1.3，2026-10-15）

用户选定 R2。桶与规则由 wrangler 创建并回读核对：

| 项 | 值 |
|---|---|
| 桶 | `saas-production-backups`（账号 `170a06d3…`，2026-10-15T08:57Z 创建），r2.dev 公开访问关闭 |
| Bucket Lock | `retain-30d`：全部前缀，对象写入后 30 天内不可删除或覆盖 |
| 生命周期 | `expire-35d`：全部前缀，35 天后过期（晚于锁定期，避免删除失败）；未完成分片 1 天后中止。另有平台默认规则：未完成分片 7 天后中止 |

保留策略：每日一份，约保留 35 份；锁定期内即使 R2 凭据泄露也无法删除已有备份。调整保留期时先改生命周期再改锁（生命周期天数始终大于锁定天数）。

加密：备份上传前用 age 公钥加密，私钥不进仓库与 CI。

- 公钥（`BACKUP_AGE_RECIPIENT`）：`age1e7a6xlm8rfj0skg8658qhk559prk6g6d4pcrtk0usl5g43e4c3fq3l3tve`
- 私钥：开发机 `~/.config/saas-template/production-backup.agekey`（目录 700、文件 600），生成后已做一次加解密往返验证。**用户须另存两份离线副本**（如密码管理器 + 离线介质）；私钥丢失则所有备份不可解密，恢复演练（4.2）时验证离线副本可用。

<!-- template-only:end -->

## 6. GitHub environments

| environment | 保护与允许的 ref | 配置 |
|---|---|---|
| `production` | 项目负责人审批，允许 tag `v*` 与分支 `main`（手动入口）；按团队情况设置审批人与自审策略 | secrets：`PRODUCTION_MIGRATION_DATABASE_URL`（migrator 非 pooled TLS）、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`；live 阶段另需 `SENTRY_DSN`、`SENTRY_AUTH_TOKEN`、`SENTRY_ORG`、`SENTRY_PROJECT` |
| `production-backup` | 仅分支 `main`，定时备份不等待交互审批 | secrets：`PRODUCTION_READONLY_DATABASE_URL`（readonly 非 pooled TLS）、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`；variables：`BACKUP_BUCKET=saas-production-backups`、`BACKUP_AGE_RECIPIENT`、`R2_ACCOUNT_ID` |

`backup-production.yml` 还由仓库 variable `PRODUCTION_BACKUP_SCHEDULE=true` 控制定时运行，完成首份备份与恢复演练后再启用。`BACKUP_BUCKET` 为备份桶，不是用户文件桶。

Cloudflare token 按实际部署资源配置账号权限和目标 Zone 的 Workers Routes 权限。先只读验证 token 归属、资源访问与 R2 列桶，再写入 environment；首个 API token / R2 S3 凭据由用户在平台控制台创建。

只在真实终端交互执行 `gh secret set <NAME> --env <environment>`，或从权限 600 文件经 stdin 写入 `gh secret set <NAME> --env <environment> < <文件>`；自动化调用必须提供非空 stdin，真值不进入 argv、输出或历史。用 `gh secret list --env <environment>` 只核对名称。生产 secrets 不放仓库级；PR CI 与 staging 作业使用各自 environment。

<!-- template-only:start -->
## 6. GitHub environments（任务 1.4，2026-10-15）

| environment | 保护规则 | 允许的 ref | 用途 |
|---|---|---|---|
| `production` | 必需审批人 `ustclhx`，允许本人审批（`prevent_self_review=false`，单人仓库） | 仅 tag `v*` | 生产迁移与部署（3.1） |
| `production-backup` | 无审批（每日定时任务不能等待人工） | 仅分支 `main` | 每日逻辑备份（4.1） |

| environment | 名称 | 类型 | 状态 |
|---|---|---|---|
| production | `PRODUCTION_MIGRATION_DATABASE_URL` | secret | 已写入（Neon migrator 非 pooled 直连） |
| production | `CLOUDFLARE_ACCOUNT_ID` | secret | 已写入 |
| production | `CLOUDFLARE_API_TOKEN` | secret | 用户 2026-10-16 04:09Z 在真实终端重写（`saas-production-deploy`：账号级 Workers Scripts / KV / R2 / Queues / Hyperdrive 编辑，Zone `ezarouter.cc` 的 Workers Routes 编辑与 Zone 读取） |
| production | `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | secret | 待 5.2 |
| production-backup | `PRODUCTION_READONLY_DATABASE_URL` | secret | 已写入（Neon readonly 非 pooled 直连） |
| production-backup | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | secret | 用户 2026-10-16 04:13Z 重写（`saas-production-backups-rw`：Object Read & Write，仅限桶 `saas-production-backups`） |
| production-backup | `BACKUP_BUCKET` / `BACKUP_AGE_RECIPIENT` / `R2_ACCOUNT_ID` | variable | 已写入（非机密） |

secret 均经 stdin 写入（无末尾换行），不出现在命令参数或输出中。仓库级 secrets 为空，生产值只存在于上述两个 environment；PR 与 `deploy-staging.yml`（environment `staging`）的作业无法读取。

用户自行写入时须在**真实终端**执行 `gh secret set <NAME> --env <environment>`（交互提示、输入不回显），或从 600 权限文件经 stdin 写入（`gh secret set <NAME> --env <environment> < <文件>`）。**不要**在 Claude Code 提示符用 `!` 执行不带输入的 `gh secret set`：该模式没有 TTY，gh 会把空值写成 secret（2026-10-15 实际发生，`CLOUDFLARE_API_TOKEN` 与 `R2_ACCESS_KEY_ID` 被写为空，需重写）。写入前应先用只读 API 验证凭据（token verify、Zone 与资源读取、R2 列桶 HTTP 200）。

wrangler 无法创建 API token（无对应命令，OAuth 可选范围不含 API Tokens 权限，其登录令牌短期有效且绑定本机），R2 S3 密钥同样派生自 API token；首个凭据必须在控制台创建。

<!-- template-only:end -->

## 7. 发布与回滚

仓库变量 `RELEASE_PHASE` 仅取 `testing` 或 `live`，未设置按 `live`。测试阶段可以绕过 CI；正式上线后只有紧急修复可绕过。CI 必须是本仓库 `main` 分支上同一完整 SHA 的成功 `CI` push 运行，PR 检查不算。生产始终要求目标 tag 的提交在 main 历史上、已成功发布 staging，并经 `production` environment 审批；这些条件不能绕过。

正常发布：对已验证的提交推送 `v*` tag。批准后依次构建 jobs/web、上传 source map、迁移、部署 jobs、部署 web、校验 `/api/health` 完整 SHA，最后执行只读 Playwright 冒烟。两个构建产物保留在同一 job，构建失败不会触及数据库。live 阶段缺少 `SENTRY_DSN` 或 source map 上传配置会在迁移前失败；testing 只发 warning 并写摘要。GitHub production DSN 用于发布门禁，web/jobs 的运行时 `SENTRY_DSN` secrets 也必须分别配置，发布门禁不代替实际事件验收。

手动操作从 **main 的当前工作流** 运行并指定目标 tag，避免旧 tag 自带的旧工作流缺少新检查。`production` environment 的 deployment branches/tags 需同时允许 `main` 与 `v*`，保留必需审批人。维护者应先确认目标 tag 与摘要中的解析 SHA 一致。

```sh
# 普通手动重发 / 回滚，仍需 CI、staging 与审批
gh workflow run deploy-production.yml --ref main -f tag=vX.Y.Z
# 紧急修复：先部署同一 main SHA 到 staging，生产仍需审批
gh workflow run deploy-staging.yml --ref main -f bypass=hotfix -f reason='修复正在发生的生产故障，关联事件编号'
gh workflow run deploy-production.yml --ref main -f tag=vX.Y.Z -f bypass=hotfix -f reason='修复正在发生的生产故障，关联事件编号'
```

每次 CI 绕过都有 `::warning` 和 Job Summary，记录 `testing` 或 `hotfix` 类型、原因及 `github.actor`。testing 未填写原因时摘要会使用测试阶段说明；live 的 hotfix 原因必须非空。不得把 testing 长期当作上线后的发布通道。

回滚 dispatch 读取当前生产 `/api/health.version`，比较当前版本与目标 tag 的迁移文件。每条新增迁移必须在**当前生产提交**中有 `-- rollback-safe: <具体原因>`，否则部署前失败并改为向前修复。只新增表、可空列等且旧代码仍兼容时才能标注；删除/改名字段、增加旧写入无法满足的非空约束等不得标注。旧生产提交未带声明时会保守阻止跨迁移回滚；后来补注释不会追溯改变旧提交。历史 `0003`（变更约束）、`0004`（原非空列可为 null）与 `0009`（撤销权限）未声明安全，禁止自动跨越。该检查只允许回退 Worker，schema 与数据不回退；数据恢复按 [restore](restore.md)。

staging/production 共用 `node scripts/production/migrate.mjs`，连接启动参数强制 `lock_timeout=5s`、`statement_timeout=15min`，避免等锁长期阻塞。CI 以固定版本 `squawk-cli@2.67.0` 检查相对 base 新增的迁移，危险 SQL 会阻断 PR。依赖来源核对为 [sbdchd/squawk 官方仓库](https://github.com/sbdchd/squawk) 的 [npm 包 squawk-cli](https://www.npmjs.com/package/squawk-cli)，该版本 publisher 为 `sbdchd`，maintainers 为 `sbdchd` / `cdignam`。例外按 [原生 ignore 语法](https://squawkhq.com/docs/cli/) 在同一行写原因，例如下列空表上的已评审索引；迁移在事务内执行，`CONCURRENTLY` 需要另行规划，不盲目照搬建议。不要为回滚执行反向 SQL。

```sql
SET lock_timeout = '5s';
SET statement_timeout = '15min';
-- squawk-ignore require-concurrent-index-creation -- reason: table is empty before first deployment
CREATE INDEX example_idx ON example_table (id);
```

本地只读冒烟：`PRODUCTION_URL=<URL> pnpm --filter @saas/web exec playwright test --project production`。

## 7a. events 死信队列与上线清单

合并后由协调者在确认 Cloudflare 账号后创建两个独立队列，资源名称必须与 jobs 的对应 Wrangler 环境一致；此步骤不由 worker 执行。Queues 的死信配置放在原队列 consumer 上，详见 [Cloudflare 死信队列文档](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)。

```sh
pnpm --dir apps/jobs exec wrangler queues create events-dlq-staging --env staging
pnpm --dir apps/jobs exec wrangler queues create events-dlq-production --env production
```

随后部署 jobs，使 `apps/jobs/wrangler.jsonc` 中 staging 与 production 的 events 队列的 `dead_letter_queue` 与 `EVENTS_DLQ` producer、死信 consumer 同时生效。认证邮件不加 DLQ。不可重试和达到尝试上限的错误用信封保留真实错误、原队列、原 ID 与失败时间，投递成功后确认原消息；原生 DLQ 同时保留意外消费者失败的落点。死信落库或告警失败时继续重试，运营告警直接发渠道，避免循环进入 events。

Cloudflare 过去只授权 public schema；复用 job-engine 死信表前，在 staging/production 各以 migrator 对已迁移的目标库授予最小权限（不调用 Node/DBOS 迁移，也不授予 app DDL）：

```sql
GRANT USAGE ON SCHEMA job_engine TO app;
GRANT SELECT, INSERT ON job_engine.queue, job_engine.message, job_engine.dead_letter TO app;
```

上线前逐项核对：

- 两个 DLQ 已创建，jobs consumer 与 producer 指向各自环境；生产两个 Worker 的日志开启且采样率为 1。
- app 可以幂等写入死信表，死信记录包含原 ID、原队列、尝试次数、原因、时间，运营渠道收到测试告警。
- production environment 允许 main 手动入口与 v* tag，保留审批；Sentry DSN 两端绑定、GitHub 上传配置及真实事件均已验收。
- 新迁移已由协调者生成、审阅 squawk 结果并判断 rollback-safe；两环境迁移入口的锁超时验证通过。
- **把仓库变量 `RELEASE_PHASE` 改为 `live`**，回读确认；普通手动发布不能绕过 CI，hotfix 必须有原因且摘要保留触发人。

## 8. 生产写操作清单

<!-- template-only:start -->
## 8. 生产写操作清单（2026-10-15 起草；A、B 已获用户批准并执行）

### 执行记录（2026-10-15）

- **A 已执行**：`neondb_owner` 执行 `GRANT pg_read_all_data TO readonly`；回读 `pg_has_role('readonly','pg_read_all_data')` 由 f 变 t，readonly 高权限 flags 与 neon_superuser 成员身份仍均为 false；readonly 以 PG17 容器 `pg_dump` 成功（空库 1159 字节），`CREATE TABLE` 仍被拒绝。
- **B 已执行**（名称冲突预检通过后创建）：

  | 资源 | 名称 | ID / 状态 |
  |---|---|---|
  | KV | `saas-production-cache` | `76d4f2b69b1a45db8fe1c0a66eaf9b34` |
  | R2 | `files-production` | 已建；CORS 仅 `https://app.ezarouter.cc`、PUT/GET/HEAD；r2.dev 关闭 |
  | Queues | `email-production` / `events-production` | 已建 |
  | Hyperdrive | `saas-production-neon` | `0519ee8f8e5b4f0f95ecd9d425c58a36`（缓存关闭） |
  | Hyperdrive | `saas-production-neon-cached` | `3deaa579109549f9a06f12b6c8d4aae6`（缓存开启，默认 max_age） |

  Hyperdrive 经 Cloudflare API 创建：请求体与授权头均经 stdin，连接串不进命令参数或输出；缓存设置回读 staging 两个配置后照搬；创建时 Hyperdrive 已实际连通 `saas_production`（app，非 pooled）。Workflow `ai-media-production` 与两个 Worker 随首次发布（3.3）创建。
- **构建验证**：jobs `wrangler deploy --env production --dry-run` 全部绑定指向上述资源；web 生产构建在预渲染阶段因 `env.invalid missing TURNSTILE_SITE_KEY` 失败（模板启用 Turnstile，站点 key 为构建期必需 var）。用户批准后经 Cloudflare API（wrangler OAuth 的 `challengewidgets.write`）新建 Turnstile 站点 `saas-production`：managed 模式、仅允许 `app.ezarouter.cc`，站点 key `0x4AAAAAAFXeXLLV-NITAkGX` 写入 web `env.production.vars`；密钥未输出，存于开发机 `~/.config/saas-template/turnstile-production.secret`（600），在 2.2 写为 web secret `TURNSTILE_SECRET_KEY`。复验后 web 生产构建（预渲染无 `env.invalid`）与部署 dry-run 通过。不使用始终通过的测试 key；生成器会清空 `0x` 开头的真实站点 key，新项目须自行配置。

<!-- template-only:end -->

按 deploy-cloudflare 技能「写入前确认动作清单」，以下操作会在 Cloudflare 账号或生产库产生真实资源 / 权限变更，批准后由协调者执行并回读核对。名称与 staging 一一对应。

**A. 生产库备份权限**——以 `neondb_owner` 执行一次：

```sql
GRANT pg_read_all_data TO readonly;
```

原因：`readonly` 只在 public 有权限，`pg_dump` 读 `drizzle.__drizzle_migrations` 时报 `permission denied for schema drizzle`。`pg_read_all_data`（PG14+ 内置）可读全部 schema 与序列，仍不能写；权限与恢复演练说明（见 [restore §6](./restore.md)）。

**B. Cloudflare 资源**——先核对当前登录身份与写权限：

| staging | production（新建） | 说明 |
|---|---|---|
| Hyperdrive `saas-staging-neon` / `-cached` | `saas-production-neon` / `saas-production-neon-cached` | 指向 `saas_production` 的 app 非 pooled 直连，`sslmode=require`；缓存版沿用默认 max_age |
| KV `CACHE` | 新 KV namespace `saas-production-cache` | web 与 jobs 共用 |
| R2 `saas-files-staging` | `saas-files-production` + CORS（origin 为本项目生产 `APP_URL`，PUT/GET/HEAD，同 `scripts/staging/files-cors.json`） | 用户文件；与备份桶 `saas-production-backups` 分开 |
| Queues `saas-email-staging` / `saas-events-staging` | `saas-email-production` / `saas-events-production` | 消费者参数同 staging |
| Workflow `saas-ai-media-staging` | `saas-ai-media-production`（随 jobs 部署创建） | web 经 `script_name: saas-jobs-production` 调用 |
| 限流 namespace | 为本项目环境分配三个独立整数 | 与 staging、本地不共享计数 |
| Worker `saas-web-staging` / `saas-jobs-staging` | `saas-web-production` / `saas-jobs-production`（首次发布创建） | web 绑定自定义域名为本项目生产域名 |

vars：`SENTRY_ENVIRONMENT=production`、`APP_URL`（本项目生产 HTTPS URL），按已确认的支付模式配置 `PAYMENT_MODE`（未接入 live 前关闭生产支付），jobs 的 `CRON_PROFILE` 按本项目调度需求选择。资源创建后把 ID 写入两个 `wrangler.jsonc` 的 `env.production`，以 `wrangler deploy --dry-run --env production` 与绑定名一致性检查验证。

**C. 生产 Worker secrets**——名称同 `scripts/staging/check-secrets.mjs` 的 web / jobs 清单（支付类除外），值需用户提供或新生成（如 `BETTER_AUTH_SECRET` 新随机值，OAuth / Turnstile 需为本项目生产域名新建生产应用）。

## 9. 生产 Worker secrets

按功能开关与实际两端消费者建立清单，写入前核对目标 Worker/environment。值由用户提供或安全生成，真值经交互或 stdin 写入；仅用 `wrangler secret list --env production` 核对名称。

| Worker | secrets 与来源 |
|---|---|
| `saas-web-production` | 独立随机 `BETTER_AUTH_SECRET`；所选 OAuth 的生产 client ID/secret；本项目 Turnstile secret；可选 `BOOTSTRAP_ADMIN_EMAILS` |
| web / jobs 按消费者配置 | 文件桶的 `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`；AI Gateway token 或直连 Provider key；媒体 `FAL_KEY` / `MEDIA_WEBHOOK_SECRET`（两端共享值）；可选 `SENTRY_DSN` |
| `saas-jobs-production` | 已验证发件域的 `RESEND_API_KEY`、`EMAIL_TRANSPORT` / `EMAIL_FROM`；支付与媒体功能所需 secrets |

OAuth 回调使用 §1a 的生产域名。文件与备份 R2 token 分开；同一绑定名只声明为 secret 或 var 之一。支付 secrets 仅在确认 live 账户、webhook 与生产支付清单后配置，详见 [支付联通](p2-payment-integration.md)。邮件 DNS 与服务商 Verified 状态需独立核验。

```sh
pnpm --dir apps/web exec wrangler secret put <SECRET_NAME> --env production
pnpm --dir apps/jobs exec wrangler secret put <SECRET_NAME> --env production
pnpm --dir apps/web exec wrangler secret list --env production
pnpm --dir apps/jobs exec wrangler secret list --env production
```

首次发布前完成 secret 名称、构建与绑定检查；值的有效性通过健康、注册邮件、OAuth 登录与所启功能验证。

<!-- template-only:start -->
## 9. 生产 Worker secrets（任务 2.2，2026-10-16 核对名称）

用户在真实终端写入；协调者以 `wrangler secret list --name <worker>` 只核对名称（不读值）。值的正确性在首次发布（3.3）时以健康检查、注册邮件与登录实际验证。

| Worker | secrets | 来源 |
|---|---|---|
| `saas-web-production` | `BETTER_AUTH_SECRET` | 本地随机生成，未留存 |
| | `TURNSTILE_SECRET_KEY` | Turnstile 站点 `saas-production`（开发机 `~/.config/saas-template/turnstile-production.secret`） |
| | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 生产 OAuth 客户端，回调 `本项目生产 APP_URL/api/auth/callback/google` |
| | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub 生产 OAuth App，回调 `本项目生产 APP_URL/api/auth/callback/github` |
| | `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 token，仅 `saas-files-production`（与备份 token 分开） |
| | `DEEPSEEK_API_KEY` | 生产文本 AI 直连（未配 AI Gateway） |
| | `FAL_KEY`、`MEDIA_WEBHOOK_SECRET` | 与 jobs 相同值（媒体回调 HMAC 需一致） |
| `saas-jobs-production` | `RESEND_API_KEY` | Resend 发信 key，域名 `ezarouter.cc` |
| | `EMAIL_TRANSPORT`（`resend`）、`EMAIL_FROM`（`EzaRouter <noreply@ezarouter.cc>`） | 用户以 **secret** 写入；运行时与 var 等效。**不要**再在 `wrangler.jsonc` 中声明同名 var，否则部署时绑定名冲突 |
| | `FAL_KEY`、`MEDIA_WEBHOOK_SECRET` | 与 web 相同 |

未配置（可选）：`SENTRY_DSN`（两端，5.2）、`BOOTSTRAP_ADMIN_EMAILS`（web；无管理员则无法在生产后台创建模型与套餐授权，首次发布前建议配置）、`EMAIL_REPLY_TO`。支付 secrets 待 Q9（6.1）。

Resend 域名记录（DoH 核对）：`resend._domainkey.ezarouter.cc` TXT 存在；`send.ezarouter.cc` 的 MX 与 SPF TXT 存在（经 CNAME `send.forge.rmta.net`）；`_dmarc.ezarouter.cc` 未配置（建议补 `v=DMARC1; p=none;` 以提升送达率）。域名验证状态以 Resend 控制台 Verified 为准。
<!-- template-only:end -->
