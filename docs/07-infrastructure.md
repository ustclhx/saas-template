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

### 事务与锁（7.1 实测，2026-10-03）

**结论：可用。** 经 Hyperdrive（关缓存）时，显式事务内的 `SELECT ... FOR UPDATE` 与 `pg_advisory_xact_lock` 都能让并发请求串行执行；事务提交、回滚，以及 Worker 中途结束导致事务被丢弃，三种情况下锁都会释放，连接池中不残留锁或未结束的事务。`docs/04`、`docs/06` 中「先取空间级 `pg_advisory_xact_lock` 再检查并写入」的写法保持不变，不需要改用 design.md 风险条目中「锁 workspace 行」的替代写法。

**测试方法**（`scripts/probes/71-locks/`，可重复执行）：
- 临时 Worker `probe-71-locks` 绑定 `saas-template-staging`（关缓存），连接参数与 `createDb()` 相同（postgres.js 3.4.9，`max: 5`、`prepare: true`、`fetch_types: false`），用 `sql.begin()` 开显式事务。
- 请求 A 取锁后读计数器、`pg_sleep(3s)`、写回 +1；800 ms 后请求 B 争同一把锁（持锁 0.5 s 后提交）。行锁为 `setting` 表中 `probe.7.1.row` 一行的 `FOR UPDATE`，advisory lock 为 `pg_advisory_xact_lock(710001)`（与 `hashtextextended(...)` 生成的 bigint 键同一函数）。A 分别以提交、回滚（回调中抛错）、丢弃（拿到锁后立即返回响应，事务不结束）三种方式结束；另有不加锁的对照组。
- 时间点都取数据库时钟 `clock_timestamp()`，A、B 可直接比较。每个场景后在新事务中串行 5 次 `pg_try_advisory_xact_lock` + `FOR UPDATE NOWAIT`，并查 `pg_locks` 与 `pg_stat_activity`。
- 共 3 轮 × 7 个场景，全部判定通过。

**关键数据**（第 1 轮原始时间，相对 A 开始事务，单位 ms）：

| 场景 | A 拿到锁 | B 开始事务 | A 持锁结束 | B 拿到锁 | 说明 |
|---|---|---|---|---|---|
| 行锁 / A 提交 | 630 | 1304 | 5358（发出 COMMIT 前） | 5673 | B 读到 A 提交后的计数器（1 → 2） |
| advisory / A 被丢弃 | 640 | 788 | 1450（A 已返回响应） | 1613 | B 读到原值，A 的事务被回滚 |
| 对照组（不加锁） | 324 | 964 | 4938 | 1446 | B 不等待、读到旧值，两次 +1 后计数器只 +1（丢失更新） |

3 轮汇总（ms）：

| 场景 | A 持锁时长 | B 等待时长 | B 在 A 释放后多久拿到锁 |
|---|---|---|---|
| 行锁 / 提交 | 4141–4984 | 3359–4694 | 164–360 |
| 行锁 / 回滚 | 4118–4730 | 3783–4883 | 160–332 |
| 行锁 / 丢弃 | 649–790 | 630–762 | 160–443 |
| advisory / 提交 | 4734–4871 | 4835–5086 | 312–371 |
| advisory / 回滚 | 4732–4910 | 4877–5188 | 313–336 |
| advisory / 丢弃 | 631–810 | 640–825 | 163–192 |
| 对照组（不加锁） | 4581–4617 | 470–489 | 不等待（B 在 A 释放前 3.5–3.8 s 已拿到） |

- 「B 在 A 释放后多久拿到锁」约为一次 Worker ↔ 本机数据库的往返（A 的 `COMMIT` / `ROLLBACK` 送达数据库所需时间）；阶段一每条语句往返约 160–500 ms，持锁时长因此比 `pg_sleep` 多出 1–2 s，不代表生产延迟（§0）。
- A 被丢弃时，Hyperdrive 在客户端断开后回滚该事务，约一次往返内释放锁；该后端连接（如 pid 8725）随后被其他请求复用，未被关闭。
- 全部场景结束后，在本机以超级用户查看 `saas_staging`：`pg_locks` 中没有 advisory lock，`pg_stat_activity` 中所有 `app` 连接都是 `idle`（无 `idle in transaction`）。

**对设计的影响 / 使用约束**（建议，供 `docs/04`、`docs/06` 后续实现遵守）：
- 只用事务级的 `pg_advisory_xact_lock`，且必须放在显式事务（`db.transaction()`）中；不在事务中的单条 `SELECT pg_advisory_xact_lock(...)` 在语句结束时即释放，起不到互斥作用。
- 不使用会话级的 `pg_advisory_lock` / `pg_advisory_unlock`：Hyperdrive 以事务为单位复用连接，会话级锁会留在被其他请求复用的连接上（本次未实测，属于事务模式连接池的已知限制）。
- 在取锁的事务中 `SET LOCAL lock_timeout`（如 5s），避免排队过久超出 Worker 请求时长；超时报 `55P03`，按「稍后重试」处理。
- 持锁期间只做数据库操作，不调用外部 API（AI 供应商、支付等）；等待中的请求也各占一条 Hyperdrive 连接。

### cloudflared 副本切换（7.5 实测，2026-10-03）

**结论：两个副本能让链路在单副本故障后自动恢复，但切换不是无感的。** 停掉（`docker stop`）或 kill 其中一个副本后，经 Hyperdrive 的数据库访问会卡住约 5–10 s：期间发起的 `/api/health` 中有 4–14 个（约每 300 ms 一个请求时）超过 Worker 端 5 s 的探测超时返回 503，其余的等到 Hyperdrive 经另一个副本重新连上后一起返回（耗时 3–5.7 s）。优雅停止与 kill 的表现没有明显差别。副本重新启动不会引起任何失败。两个副本全停时，`/api/health` 一直返回 503（前约 5 s 的请求挂到超时，之后约 180 ms 快速失败）；启动后 1.2–1.5 s 恢复。

**测试方法**（`scripts/probes/75-tunnel-failover/`，可重复执行，原始数据在其 `results/` 下）：
- 环境：本机 Docker Desktop（macOS），compose 项目 `saas-template` 中的 `saas-template-pg` 与两个 `cloudflared` 副本（2026.9.3，QUIC，每个副本 2 条连接，边缘位置均为 `lax*`）。请求的是已部署的 `web-staging`，链路 Worker → Hyperdrive（`saas-template-staging`，关缓存）→ Workers VPC → Tunnel → cloudflared → PG。
- 本机每 300 ms 发起一个 `GET /api/health`，不等待上一个返回（单次约 0.65–1.2 s）；`200` 且 `db.status = up` 记为成功。`/api/health` 的数据库探测超过 5 s 即返回 503（`apps/web/src/server/health.ts`），所以「失败」实际是「数据库访问超过 5 s 或报错」。
- 场景依次为：S0 基线 30 s；S1 `docker stop` 副本 1，保持 60 s 后 `docker start`，观察 45 s；S2 对副本 2 同样操作；S3 `docker kill` 副本 1，保持 60 s 后启动；S4 两个副本同时 `docker stop`，保持 30 s 后同时启动，观察 60 s。每次启动后从 `docker logs -t` 中取 2 条 `Registered tunnel connection` 的时刻。
- 共运行 3 轮（每轮约 7.5 分钟、约 1500 个请求）。以下时间都相对该场景的 `docker stop` / `docker kill` 或 `docker start`，单位 s。

**单副本停止 / kill**（S1–S3，统计操作后 20 s 内发起的请求，每个场景约 73 个）：

| 轮 | 场景 | 失败（503） | 成功但 > 3 s | 失败请求的发起时刻 | 受影响请求全部返回 | 启动后失败 | 重新注册（距 `docker start`） |
|---|---|---|---|---|---|---|---|
| 1 | S1 stop 副本 1 | 5 | 1 | 0.6 – 6.3 | 11.4 | 0 | 1.4 / 2.1 |
| 1 | S2 stop 副本 2 | 7 | 7 | 0.7 – 4.3 | 10.0 | 0 | 0.9 / 1.6 |
| 1 | S3 kill 副本 1 | 8 | 8 | −0.2 – 2.8 | 9.4 | 0 | 0.9 / 1.6 |
| 2 | S1 | 5 | 1 | 0.9 – 2.1 | 7.8 | 0 | 0.9 / 1.6 |
| 2 | S2 | 14 | 10 | 0.7 – 14.2 | 19.4 | 0 | 1.2 / 2.2 |
| 2 | S3 | 9 | 7 | −0.2 – 3.1 | 9.4 | 0 | 0.9 / 1.6 |
| 3 | S1 | 4 | 1 | 1.2 – 5.4 | 8.6 | 0 | 0.9 / 1.8 |
| 3 | S2 | 10 | 7 | 0.6 – 7.2 | 14.2 | 0 | 0.9 / 1.6 |
| 3 | S3 | 6 | 9 | −0.2 – 1.3 | 7.2 | 0 | 0.8 / 1.5 |

- 失败几乎都是 5.2–6.0 s 后的 503（Worker 端探测超时），只有 1 个在 1 s 内返回 503（第 3 轮 S1，连接报错）。成功但变慢的请求与失败请求在同一时刻（操作后约 6–10 s）一起返回，说明这段时间所有新请求都在等 Hyperdrive 重建经由另一副本的连接。
- 第 2 轮 S2 在主中断（0.7–4.0 s 发起的请求）之后，7.3 s、13.3 s、14.2 s 发起的请求又各有 1 个超时，其余请求正常，属于切换后的零星长尾。
- `docker stop` 约 1.1 s 完成：cloudflared 收到 SIGTERM 后注销连接（`Unregistered tunnel connection`），日志随即出现 `no more connections active and exiting`，没有等待默认 30 s 的 grace period 去排空 Hyperdrive 的长连接。因此「优雅停止」对 Hyperdrive 并不优雅，与 kill 一样会切断经由该副本的数据库连接。kill 时在途的请求（操作前 0.2 s 发起）也失败。
- 副本重新启动：约 0.8–1.4 s 注册第 1 条连接、1.5–2.2 s 注册第 2 条；启动前后都没有失败，成功请求延迟不变（启动后首个请求 30–300 ms 内发起即成功）。
- 基线（S0）：0 失败，p50 约 650 ms，p95 0.67–1.9 s。

**两个副本全停**（S4，保持 30 s）：

| 轮 | 失败 / 请求 | 全停期间的表现 | 启动后首个成功请求 | 启动后失败 | 重新注册（距 `docker start`，副本 1 / 副本 2） | 中断时长（首个失败发起 → 首个成功发起） |
|---|---|---|---|---|---|---|
| 1 | 106 / 313 | 操作后 0.9 s 起全部失败；5.1 s 前发起的挂到 5 s 超时，之后约 180 ms 返回 503 | +1.52 | 5（发起于启动后 0–1.2 s） | 0.95, 1.7 / 0.9, 1.7 | 31.8 |
| 2 | 107 / 313 | 0.6 s 起全部失败；4.8 s 后快速失败 | +1.54 | 5（0–1.2 s） | 0.9, 1.6 / 0.9, 1.7 | 32.1 |
| 3 | 105 / 312 | 0.8 s 起全部失败；4.1 s 后快速失败 | +1.16 | 3（0.3–0.9 s） | 1.1, 1.8 / 0.9, 1.6 | 31.5 |

- 全停期间没有任何请求成功；中断时长 ≈ 停止时长 + 1.2–1.5 s。
- 恢复所需时间：首条连接注册后 0.3–0.6 s 即有请求成功，不需要等两个副本的全部连接注册完。第 1 轮有 1 个在启动后 1.2 s 发起的请求仍挂到 5 s 超时，其余启动后的失败都是快速 503。
- 全停期间 Worker 端仍按 5 s 超时或快速失败返回 503，没有挂起超过 6 s 的请求；客户端没有出现超时或网络错误。

**测试条件的局限**：两个副本与 PG 在同一台机器、同一个 Docker 网络中，出口经过本机代理（cloudflared 日志中边缘 IP 为 `198.18.0.x`），只测了 `/api/health` 一种请求；数据不代表阶段二的生产环境（§0）。没有测量进行中的写事务被切断时的表现。

**对阶段二的建议**：
- 继续运行至少两个 `cloudflared` 副本，并放到不同的故障域（不同主机或至少不同的进程管理单元）；阶段一两个副本在同一台机器上，本机故障就是 S4。
- 单副本故障按「数据库访问中断 5–10 s」处理，而不是无感：
  - 健康检查告警不要以单次 503 触发，至少连续失败 30 s（或连续 3 次以上检查）再告警；另外单独监控 Tunnel 的连接数（少于 4 条即降级），用于发现单副本故障。
  - 读请求可以在连接错误或超时后重试一次；写请求（尤其计费、积分扣减）必须能安全重试（幂等键），且事务被切断时以回滚为准（7.1 已验证连接断开时事务被回滚、锁被释放）。
- 计划内的 cloudflared 升级或重启要逐个副本进行，两次之间至少间隔 30 s（确认新副本注册了 2 条连接、`/api/health` 恢复正常后再动下一个），并避开流量高峰：每停一个副本都会有一次 5–10 s 的数据库访问卡顿，`--grace-period` 不能避免（cloudflared 不排空 Hyperdrive 的长连接）。
- 阶段二在生产服务器上用同一脚本重测（`HEALTH_URL`、`REPLICA_1`、`REPLICA_2` 可配置），并补测「写事务进行中切断副本」的场景。

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

## 8. 延迟基线（Phase 0 实测 7.4，2026-10-03）

> **阶段一的数据库在开发者本机（§0），以下数据只证明「Worker → Hyperdrive → Workers VPC → Tunnel → 本机 PG」链路可用，不代表生产延迟。** 生产延迟在阶段二部署生产服务器后重新测量。

### 测试方法

可重复执行的探针在 `scripts/probes/latency/`（部署、运行、清理步骤见其 README）：

- 临时 Worker `probe-74-latency-{off,smart,eu,ap}`，代码相同，只有放置方式不同：关闭放置、Smart Placement、显式放置 `aws:eu-central-1`（实际执行于 FRA）、显式放置 `aws:ap-northeast-1`（实际执行于 NRT）。都绑定 `saas-template-staging`（关缓存）。
- 每个 HTTP 请求新建一个 postgres.js 客户端（选项同 `createDb`：`max: 5`、`fetch_types: false`、`prepare: true`），对 `setting` 表顺序执行同一查询 `select value from setting where key = $1` 共 6 次，在 Worker 内计时：第 1 次为**首次建连**（新连接 + prepare），后 5 次为**复用连接**。
- 记录 `request.cf.colo`（入口机房）、Worker 内请求 `cloudflare.com/cdn-cgi/trace` 得到的 `colo`（实际执行机房）、响应头 `cf-placement`。
- **两个以上地区**：本机（经代理出口在美国西部）直接请求时入口固定为 LAX；另用两种方式让 Worker 在其他地区执行：① 显式放置（targeted placement）；② 由显式放置在 FRA / NRT 的探针 Worker 经 `/relay` 转发请求，使 off / smart 两个 Worker 的入口机房分别为 FRA、NRT。
- 每组 60 个请求（60 个首次建连样本、300 个复用连接样本），顺序执行。原始数据在 `scripts/probes/latency/results/`。

本机环境：两个 `cloudflared` 副本的 Tunnel 连接都注册在 LAX（`lax01/08/10/13`），即从 Cloudflare 看，数据库「位于」LAX；每次数据库往返都包含 LAX ↔ 开发者本机（经本机代理）这一段。

### 结果（Worker 内测得的数据库往返，单位 ms，p50 / p95）

| 入口机房 | 执行机房 | 放置 | `cf-placement` | 首次建连 | 复用连接 |
|---|---|---|---|---|---|
| LAX | LAX | 关 | — | 320 / 1576（第 1 轮）；482 / 501（第 2 轮） | 159 / 166；161 / 167 |
| LAX | LAX | Smart | `local-LAX` | 479 / 501 | 162 / 166 |
| LAX | FRA | 显式 `aws:eu-central-1` | `remote-FRA` | 704 / 911 | 312 / 398 |
| LAX | NRT | 显式 `aws:ap-northeast-1` | `remote-NRT` | 670 / 705 | 262 / 272 |
| FRA（经 relay） | FRA | 关 | — | 782 / 889 | 312 / 458 |
| FRA（经 relay） | FRA | Smart | `local-FRA` | 786 / 938 | 314 / 323 |
| NRT（经 relay） | NRT | 关 | — | 695 / 851 | 264 / 281 |
| NRT（经 relay） | NRT | Smart | `local-NRT` | 694 / 726 | 264 / 277 |

对照组（`prepare: false`）：LAX 执行时首次 323 / 377、复用 319 / 347；FRA 执行时首次 630 / 727、复用 621 / 719。

所有测量与预热（Smart Placement 预热约 3,500 个请求）中没有失败请求。

### 结论

1. **链路可用**：LAX、FRA、NRT 三个执行位置经 Hyperdrive（关缓存）查询本机 `saas_staging` 均成功。
2. **单次往返由「执行机房 → Tunnel 接入点（LAX）→ 本机」决定**：LAX 执行约 160 ms（几乎全部是 LAX ↔ 本机），FRA 约 310 ms，NRT 约 265 ms；不同执行位置之间的差值（约 +150 / +105 ms）就是执行机房到 LAX 的距离。
3. **Smart Placement 在本场景下没有效果**：入口为 LAX 时决定为 `local-LAX`（本来就在 Tunnel 接入点，合理）；入口为 FRA / NRT 时，在约 70 分钟、约 3,000 个请求后仍为 `local-FRA` / `local-NRT`，没有把 Worker 移到 LAX，延迟与关闭时相同。原因未查实，可能是：Smart Placement 主要依据 `fetch` 子请求的耗时，而 Hyperdrive 走的是 TCP socket；探针每个请求还有一次发往本地机房的 `fetch`（trace），可能把判断拉向「留在本地」；流量规模较小。
4. **首次建连的额外开销来自 prepare，而不是与 Hyperdrive 建连**：`prepare: true` 时首次查询约 2–3 次往返、之后每次 1 次往返；`prepare: false` 时每次查询都是约 2 次往返。首次查询是 2 次还是 3 次往返在两轮测量之间不同（LAX 第 1 轮 320、第 2 轮 482），原因未查实（可能与 Hyperdrive 到源站的连接池状态有关）。

### 对设计的影响（建议）

- 保持 `createDb` 的 `prepare: true`（§2）：同一请求内的重复查询只需 1 次往返；改为 `false` 会让每次查询多一次往返。
- 请求内顺序执行的查询次数直接放大延迟（阶段一每次约 160–310 ms）。后续 change 应尽量合并查询（CTE、`returning`、一个事务内少次往返），避免在一个请求中串行多次读库；这一点在阶段二数据库离用户较远时同样适用。
- 不依赖 Smart Placement 把访问数据库的 Worker 移到数据库附近。阶段二若用户与数据库不在同一地区，建议对以数据库为主的 Worker 评估显式放置（`placement.mode = "targeted"`，`region` 或 `host` 指向数据库所在地区），并在阶段二重新测量本基线后再决定。
