# Design

## Context

动机与范围见 [proposal.md](proposal.md)。本设计只为后续实施提供方案，本 PR 不修改运行代码或外部环境。

### 需求依据（自包含，保留原 ID）

| ID | 优先级 | 必须交付 |
|---|---|---|
| P1 | P0 | CI 构建 web/jobs/migrate 的 amd64、arm64 镜像，默认 GHCR，允许替换 OCI 仓库；标签为完整 git SHA |
| P2 | P0 | 服务器执行 `docker compose pull && docker compose up -d`，提供 SSH 部署脚本或 Actions 流程 |
| P3 | P1 | 部署后自动检查 `/api/health` SHA；不一致时失败提示并给出回滚命令 |
| P4 | P1 | 新 Ubuntu/Debian 一键安装 Docker、配置只开放 22/80/443 的防火墙、生成 `.env` 骨架 |
| P5 | P0 | `create-project --target selfhost`；关闭 billing、credits、营销、i18n 后仍能构建和运行 |
| B1 | P0 | 每日基础备份与持续 WAL 归档到任意 S3 兼容存储，保留可配置，默认 7 天每日 + 4 周每周 |
| B2 | P1 | 每日 pg_dump 逻辑备份 |
| B3 | P0 | 恢复脚本和 runbook，在新服务器恢复到指定时间点 |
| B4 | P1 | 恢复到临时实例并运行校验的演练脚本 |
| B5 | P1 | 同步完整恢复链到独立凭据目标；本次按 2026-10-16 用户决定使用同一 R2 账号下独立桶/token，不证明抵御账号级丢失 |
| §6.7 | 验收 | 从 S3 备份恢复到本地或服务器临时实例，指定时间点数据校验通过 |
| §6.8 | 验收 | 服务器重启后全部常驻服务自动恢复，health 返回正确完整 SHA |

共同约束：Linux + Docker Engine + Compose v2；不使用云厂商元数据或专有 SDK；Cloudflare 仍为主目标；单机，不承诺高可用。源需求的资源目标为整机 2 核 4 GB；这是待实测的基线，不证明已有生产服务的主机还能承载本栈。

### 当前 checkout 的事实与缺口

- A `add-selfhost-foundation` 已合入 Node 构建、`deploy/selfhost/app.Dockerfile` 的 web/jobs/migrate target，以及非 root PG/Valkey/Caddy 镜像和 image-only Compose。`build.sh` 只创建本机镜像；`.env.example` 仍为本机 namespace。D 复用这些成果并发布所有必需镜像，不重建运行时。
- B `add-selfhost-job-engine` 已选择固定 DBOS 5.2.11，并合入事务消息 inbox、事件/等待日志、调度、邮件/events 和五条 UTC Cron。以 `docs/runbooks/node-job-engine.md` 的最新 apps 装配段为准，旧 `deploy/selfhost/README.md` 中“B 尚未装配”已过时。A/B tasks 仍有 ACME、完整 Compose、资源和服务器验收未完成；D 不替它们勾选。
- Compose migrate 已按业务 SQL → DBOS 公共 migrate 执行，应用以 app 角色运行；PG17 TLS、三角色、仅代理端口、日志轮转及非 root 是必须保留的边界。常驻服务内存上限合计约 3.25 GiB，迁移额外 512 MiB；新增备份的 CPU/I/O/内存也需计入整机预算。
- 当前 jobs 未挂载持久 ownership 目录，也未配置稳定 hostname/PID namespace。`packages/platform/src/node/job-engine.ts` 的 `processOwner`/`exited` 只有 hostname 和 PID namespace 相同时才接受 PID 消失为退出证据；普通容器重建和主机重启不能据此宣称可恢复。此处是 B 生命周期契约与 D 交付的签收门，见决策 3。
- `.github/workflows/ci.yml` 已有独立 Node 构建/测试，没有镜像发布；CF `deploy-staging.yml` 继续由 main 自动迁移/发布。D 不把 Node 发布接到 CF staging，不使用其凭据。
- `scripts/create-project.mjs` 的 `projectOptions` 当前把 `--target` 解析为输出路径；`docs/create-project.md` 示例为 `--target ../acme`。生成器未提供 billing/credits/营销/i18n 整体关闭，清空支付 provider 不等于关闭积分。`omit()` 未按 selfhost `secrets/`、`certs/` 目录排除无扩展名密码文件，需要补齐真值排除。
- `infra/postgres` 是 CF 的数据库部署模板，归档关闭，备份/异地副本仍为待办。D 的 WAL-G 集成放在 `deploy/selfhost`，不悄悄修改已有 CF PG 生产配置。
- 主规格尚无 `selfhost-deployment`、`project-bootstrap`，但 A 和既有 change 分别持有同名 delta。D 沿用路径，追加不同 requirement 名；同步/归档由协调者串行合并，避免竞争性的 capability。

## Goals / Non-Goals

**Goals:** 一个 SHA 对应一组可拉取镜像和版本化部署材料；plain Compose 与 Dokploy 共享拓扑和迁移 gate；部署失败可定位且可恢复；备份必须通过真实 PITR 演练证明；生成项目继承这些能力。

**Non-Goals:** 不重新选择 DBOS、不实现业务 S3/SMTP/Sentry 适配器、不开发采集业务、不转移旧 ECS 的生产服务、不自动开云资源或购买套餐。不承诺零停机、跨版本工作流热重放、数据库自动降级或外部 API 副作用的时间点回滚。

## Decisions

### 1. CI 发布完整镜像集合（P1）

新增独立 selfhost 镜像 workflow，复用 A Dockerfiles。web/jobs/migrate 加 postgres/valkey/caddy，以及 D 的备份工具镜像都在 CI 构建两个架构；Compose 不加 build。基础镜像 digest 必须为支持两个架构的 manifest，若现有 digest 是单架构，在实施中校正并验收。

默认仓库 `ghcr.io/<owner>/<project>-<service>:<full-sha>`，允许显式 OCI namespace，部署不依赖 GHCR 专有运行接口。APP_VERSION 与 OCI revision 都取检出的完整 40 位 SHA，不取 workflow 默认分支的头；同 SHA 标签不覆写已有正式镜像，部署材料记录每个 digest。CI 打包同 SHA 的 Compose、脚本与非敏感示例为 release bundle，不包含业务源码构建需求。

PR 只验证构建，不获得 registry 写入或服务器密钥；受信 main CI 成功后或人工指定受信提交发布，最小 `packages:write`，所有服务的两个平台验证通过才发布完整 bundle。生成项目的镜像属于自身 namespace，并随其模板配置重新构建，不能套用模板仓库不同配置的镜像。相较服务器构建，CI 可统一原生依赖与版本；相较 latest，SHA 可核对和回滚。

### 2. 官方 Compose 与可选 Dokploy（P2）

plain Compose 是独立可用的正式交付；默认 Caddy profile 处理 80/443。Dokploy 导入**同一** `compose.yaml`，禁用 Caddy，使用其现有 Traefik/域名/TLS。选择 Compose 部署而非另一个 Stack/Swarm 模板，避免复制迁移/secret/资源契约。

Dokploy 的域名配置只选 web:3000；运行时生成的代理网络/label 仅接入 web 的专用 ingress，PG/Valkey/jobs 不加代理网络或宿主端口。环境特定网络接线可用小 override，基础文件保持普通 Compose。代理覆盖客户端转发头，`TRUSTED_PROXY_CIDRS` 只信任实际受限地址，不能信任全部 Docker 网段。[Dokploy 官方域名文档](https://docs.dokploy.com/docs/core/docker-compose/domains)说明 UI 会添加 label/network；实施必须检查最终渲染配置，而不是假设导入原文件后网络不变。

既有代理/cloudflared 也是相同的外部入口模式：只接 ingress/web 内部端口，不抢占现有公网端口。仅在用户选定资源且明确授权后安装/配置 Dokploy，模板初始化不会默认安装它。

### 3. 发布、迁移、健康与 rollback（P2、P3、§6.8）

提供 `deploy/selfhost/deploy.sh`，本地编排入口接受显式 SSH host、目录和目标完整 SHA，不内置任何 ECS alias。使用 SSH 已验证 host key，凭据从受限文件/stdin 读取，无 argv 明文密码。主机上以文件锁串行发布，记录上一**成功**版本与镜像 digest/非敏感配置；失败目标不覆盖成功版本记录。

发布流程：校验 bundle/配置和磁盘余量 → 拉取目标镜像 → 排空并确认旧 web/jobs 退出 → 强制为目标版本重新执行一次性 migrate → 迁移成功才 `up -d` → 限时轮询公开 health。实际更新仍使用 `docker compose pull && docker compose up -d`；显式控制中间停机/迁移，不能认为对运行中的 app 写一次 depends_on 就形成升级 gate。健康成功要求 HTTP 200、目标完整 SHA、DB/cache/queue/scheduler 正常和成功心跳；另核对 jobs readiness 的 SHA，避免仅 web 更新成功。首次心跳可能等待下一个五分钟 slot，轮询期限覆盖这一正常等待。[Docker 启动顺序文档](https://docs.docker.com/compose/how-tos/startup-order/)区分运行与就绪，迁移使用 service_completed_successfully。

**B/D ownership 签收依赖：** D 添加非 root 持久 ownership 卷、稳定互异 executor ID 与版本配置，并实测容器 recreate、强制退出、主机 reboot。当前 B 对相同 namespace 的要求不足以覆盖这些场景；由协调者分配 B owner 补齐可信退出/宿主重启证据，再签收给 D。D 不自行改写 owner JSON、删除整个目录、根据 TTL/DB 锁消失冒充进程退出，也不以 `pid:host` 猜测解决跨 reboot 问题。该依赖未满足时，部署恢复验收保持阻塞，不能宣布 §6.8 完成；双 jobs 的共享目录/namespace 契约按 B 的签收实现，不直接 `--scale jobs=2` 复制相同 executor ID。

失败非零退出，显示目标/观察到的脱敏 SHA 与下一步。命令接口规划为 `deploy.sh --host <host> --dir <dir> --rollback <previous-full-sha>`，本机运行模式同样支持；回滚拉取上一 bundle/镜像、保留卷、重启并重新检查 SHA。只在 schema 和 DBOS handler/checkpoint 兼容、旧长任务已完成或仍由匹配版本 handler 承接时回滚应用，不自动执行 down migration。无法兼容时停止并按 B3 恢复匹配备份到新卷，明确数据回退范围。Docker 宿主重启只自动恢复常驻服务，已成功 migrate 不作为守护进程循环运行。

### 4. 新服务器初始化（P4）

提供可审核的 `init-server.sh` 单命令入口，在支持的 Ubuntu/Debian amd64/arm64 空白 VM 上安装 Docker Engine/Compose v2、启用 Docker 开机启动、创建受限部署目录、写非敏感 `.env` 骨架，配置 22/80/443 入站规则且保留 SSH。固定并记录支持的发行版/工具版本，重复执行不覆盖 `.env`、secret、证书或数据卷。

检测 OS、权限、已运行容器、现有规则、端口和资源；已用主机拒绝自动初始化并退出到明确诊断。它不是“初始化即上线”：APP_URL、registry、备份两个目标、角色 secret 和 PG/Caddy TLS 仍须由操作者按无真值示例配置。Docker 端口映射可能绕过普通 UFW，必须在 VM 从外部验证实际可达端口，并采用与安装的 Docker 防火墙后端匹配的规则；不 flush 已有防火墙。选择空白主机这一边界，避免一条初始化命令破坏共用生产服务器。

### 5. 生成器目标与功能裁剪（P5）

明确 `--target cloudflare|selfhost` 与 `--output <path>`。省略 target 仍生成 CF；旧 `--target ../acme` 明确失败并提示新参数，不静默当成路径。现有覆盖目录/源树保护保持；不增加模糊双义解析。交互模式和 CLI help 使用相同选项模型。

selfhost 输出自身镜像 namespace、Compose、初始化/部署/恢复脚本、配置模板与针对启用功能的 secret 清单；CF 默认生成与 CI/staging 行为保持。扩展现有模板配置以表达 billing、credits、营销、i18n 的启用状态并沿用现有注册分支，不按功能生成业务源码分叉。团队工具验收组合将 billing/credits/营销/i18n 全关，AI 可关闭以聚焦交付；不为本次交付额外设计新的额度来源。关闭营销后提供实际应用入口，关闭 i18n 使用所选单语言，不能仅把默认语言改成另一种语言而仍注册多语言入口。

关闭模块时不注册其 jobs/导航/API 或要求其密钥/seed，保留 auth、workspace、email、operations 和成功 heartbeat；开关启用时不削弱原行为。不进行破坏性删表或清空历史账本。针对全关组合和 CF 默认组合完成真实生成→CI构建→容器运行验收，源码副本仍能再次生成新项目。

生成器显式排除 selfhost secrets/certs、ownership、备份数据、运行时 release/env 状态及私钥格式，保留 `.env.example`/`secrets.example`/脚本。用无扩展名 secret 哨兵验证，不读源树真值来生成模板；忽略文件名后缀的排除不足以保护当前 Compose secrets。

### 6. WAL-G 备份与保留（B1、B2）

PG 镜像内安装固定版本、校验 checksum 的 WAL-G，运行仍 UID999。PG 配置持续 `archive_mode=on` 与失败返回非零的 wal-push wrapper；使用低写入负载下有限归档延迟的 archive_timeout，失败不伪返回成功。备份工具容器同 UID，只读挂载 PGDATA 与必要 socket，运行每日 full base、pg_dump、保留清理及副本同步；一处调度，主机/容器重启自动恢复，互斥防止重复。使用 PG 本地 peer 的受限运维路径；不把超级用户凭据给 web/jobs，不扩 app/migrator/readonly 权限。

endpoint、region、bucket/prefix、path-style、CA 和两组独立凭据可配置；明确关闭实例元数据凭据探测。[_WAL-G 存储文档_](https://wal-g.readthedocs.io/STORAGES/)给出 S3 配置能力；包装器从文件装配配置，不将 key 置于 Docker ARG、argv 或日志。备份流直接上传，不在磁盘保存全量 base；dump 的受限临时文件有空间预检和清理。连接、压缩、上传并发与磁盘速率有明确小机预算。

默认每日备份覆盖最近 7 天，每周固定 UTC 锚点保留最近 4 周；同一 full base 可同时作为 daily/weekly。保留整条从最早保留 base 到承诺恢复上界的 WAL/timeline history，清理先形成保留计划并 dry-run，受保护 weekly anchor 不得被 count-only 删除。采用固定 WAL-G 的标记/删除机制实现锚点保护并在隔离存储验证 WAL 删除语义，宁可暂多保留，也不截断恢复链。对象桶 lifecycle 不独立按对象年龄删 WAL。新备份未完整成功不删除上一份可用备份；归档或副本缺口时跳过破坏性清理并失败告警。

pg_dump 每日 custom-format 保存所有业务及引擎 schema，另记录角色/授权的恢复材料，明确敏感角色资料按 secret 保护。逻辑备份跨版本迁移另验，不充当 PITR；日/周配置与归档/同步/逻辑备份最近成功时间、失败计数写脱敏状态，runbook 查询 `pg_stat_archiver`、空间/WAL 增长并规定告警，不引入一套新的监控平台。

### 7. PITR 与恢复演练（B3、B4、§6.7）

`restore.sh` 接受 S3 配置文件、明确 UTC 时间/时区、backup ID、目标新目录/卷及匹配 PG17 镜像。拒绝生产卷、非空目录和无法确认的路径；获取早于目标且可恢复到目标的 base，经 wal-fetch 重放，恢复达到指定点并停在受控状态。WAL 缺失/时间越界非零退出，不能自动改成“最新”。只在校验后显式 promote/切流量；恢复时 jobs 不启动、无外部 API 出站，归档写入关闭，避免误发邮件、再次支付和污染原备份 timeline。

PG 物理恢复涵盖整个 cluster 的业务数据、角色、`job_engine` 与 `dbos`，不是仅 public 表；密钥、TLS、ownership 环境及镜像清单由操作者独立安全保存并在新机重建。外部 S3 用户文件/第三方副作用不随 PG 回退，runbook 说明对象一致性和幂等核对。不能把旧机 owner 文件原样复制到新机来证明退出，复用 B 签收的恢复边界。[PG17 PITR 文档](https://www.postgresql.org/docs/17/continuous-archiving.html)作为恢复流程依据。

`restore-drill.sh` 创建独立 Compose project/卷/内网 PG，无公网端口、无生产 jobs。测试生成时间点前后的业务 marker，真实归档到 S3，再从备份恢复；要求前 marker 存在、后 marker 不存在，schema/约束/角色正确，启用 credits 时校验余额对账，任务 inbox/checkpoint/event/调度元数据一致。失败保留脱敏诊断，成功仅清理脚本拥有的临时资源；记录 backup ID、目标/实际恢复点、耗时与校验结果，不输出数据正文或凭据。本地 S3 兼容测试服务只作为隔离夹具，不决定 C 的业务存储默认。

### 8. 独立凭据副本（B5）

提供可重复的复制入口：向独立凭据的 S3 目标复制完整 base、dump、WAL 和 timeline history；通用能力仍允许不同供应商/账号。本次按 2026-10-16 用户决定，主目标为 R2 `selfhost-backups`，副本为同一账号下的 `selfhost-backups-replica`，使用彼此独立且仅限对应桶的最小权限 token，保留同一 cluster 身份与路径布局。选择完整恢复链异步复制，不用“主存储故障时才写另一桶”冒充双副本。复制不传播源端删除；目标独立保留策略，按清单、大小和可用校验和确认完成，不能假设 multipart ETag 就是内容散列。

每次 base/dump 后同步并定期补齐 WAL，报告目标的最近连续恢复上界和同步延迟。副本失败使备份周期报告失败，但不回滚已成功主归档、不阻塞 PG 为等待第二副本而停止所有写入。明确副本的 RPO 由同步延迟决定；默认不承诺零损失。演练禁止访问主目标，只凭第二目标和其独立凭据恢复同一指定时间点，证明主目标凭据不可用时仍可恢复；本次同账号 R2 方案不证明账号丢失或供应商故障后可恢复。

## Risks / Trade-offs

- [失去供应商独立性] → 本次主备份及副本在同一 R2 账号；独立桶/token 仅隔离桶权限与凭据失效，不抵御账号封禁、账号级凭据泄露、全账号误删或供应商故障。用户已于 2026-10-16 接受此范围；不以副本恢复成功宣称跨供应商/独立账号容灾。

- [主机空间/内存不足] → 空白主机预检；整机测量加备份/迁移峰值；现有 ECS 不默认为可用，备选方案见 Open Questions。
- [归档失败令 pg_wal 持续增长] → 非零失败、归档延迟和磁盘余量可观察，上传限额与失效注入；不静默丢 WAL。
- [错误保留策略切断 PITR] → daily/weekly 锚点与 WAL 依赖同计划；清理边界、缺段、失败周期和最老 weekly 恢复都实测。
- [镜像更新与长任务版本不兼容] → B 同版本恢复契约；升级先排空或保留对应 handler，不用 SHA 检查替代兼容性判断。
- [owner 记录跨容器/宿主重启不兼容] → 协调者/B 单独签收退出证据；未解除依赖不放行部署恢复验收。
- [Dokploy 注入网络或 secret 权限改变安全边界] → 检查最终 Compose、实际 UID/挂载和外部端口，Traefik 不接 data。
- [生成器开关影响多模块] → 唯一 owner 集成 config/注册入口，CF 默认回归与 selfhost 全关真实副本验证；不只做文本快照。

## Migration Plan

1. 本轮只提交 planning artifacts 并 strict validate。A/B/C 的现有 tasks、主规格与运行代码不改；不连接服务器。
2. 后续 apply 先由协调者确认共享文件所有权和 B/D ownership 依赖，再独立推进 CI/bundle、生成器、备份；部署/恢复入口消费这些产物。
3. 本地/CI 两架构镜像与功能裁剪验证；隔离 PG/S3 真实 PITR、次供应商独立恢复；初始化在临时 Ubuntu/Debian VM 验证，VM 重启后核对所有常驻服务及 SHA。
4. 用户作出以下主机/入口/运维选择并提供合法测试资源后，才执行服务器初始化/部署/重启或真实备份演练。现有生产机的任何改动都需要单独明确授权；未满足时 tasks 的服务器项标为 BLOCKED，不能用本地证据勾选。
5. 保留前版本 bundle 和 PG 卷，应用回滚受决策 3 兼容性约束；灾难恢复到新卷并核对匹配代码版本后切入口。不要 down -v 生产、降级 PG 主版本或修改 DBOS 内部表。同步与归档仅由协调者在全部任务合并后处理。

## Open Questions

### 2026-10-16 已确认的主机、入口与存储决定

用户授权 `ssh product-res-ecs`（Ubuntu 22.04、2 vCPU、约 3.5 GiB 可用物理内存、约 14 GB 空闲磁盘），入口为模板 Caddy，域名 `selfhost.ezarouter.cc`，DNS only A 指向 `43.106.17.72`。复用既有 Docker，不运行空白 init、不重装 Docker、不改变防火墙默认策略或 SSH。仅创建/配置 selfhost 专用资源，不触碰生产 Cloudflare 与 staging。

业务文件、主备份和副本都用 R2，分别为 `selfhost-files`、`selfhost-backups`、`selfhost-backups-replica`；各桶独立受限 token，应用不拿备份凭据。主桶遵循 7 天 daily/4 周 weekly 与完整 WAL 链保留，副本独立 retain-all，不传播删除。Bucket Lock 与生命周期按 runbook 设置，不允许按对象年龄独立删除 WAL/history；保留清理需明确验证锁策略与脚本的相容性。

为 6.4 整机预算，用户追加授权仅停止 sub2api-deploy 组、new-api 组、openclaw 容器与宿主 warp-svc：先向 `/root/selfhost-prep/` TSV 追加原容器重启策略，改为 restart=no 后 docker stop；记录 warp-svc 原 enabled 状态后 systemctl stop。仅停止，不删除容器、卷、镜像、数据或缓存，不改其他服务。既有 d2market 停止记录保留。**整机 reboot 已于 2026-10-16 追加获准**：7.1、foundation 7.4、job-engine 6.4、7.2 完成后可直接执行。重启前记录时间和各服务状态；按 §6.8 验证自动恢复、完整 SHA、数据/任务和备份调度，已停止的非 selfhost 服务不得被重新启用，不用容器 restart 代替。

这些决定解除主机/入口/供应商选择门，不构成验收成功；同 SHA 正式 bundle、readiness、资源、R2 恢复和 reboot 证据仍须逐项取得。

### 历史候选方案（2026-10-13，已由上述决定取代）

任务提供的 **2026-10-13 只读探测摘要**：候选 ECS（`product-res-ecs`）2 CPU、3.4 GiB RAM，仅约 530 MiB 空闲；磁盘使用 78%。已运行 d2market、product-res-pilot、sub2api、openclaw、new-api、postgres/redis、cloudflared 等生产服务；80/443/3000/8080 已占用，Dokploy 未安装。此处仅转述任务输入，本 worker 未连接、也不会连接或修改该主机。

| 可选决策 | 收益 | 代价与条件 |
|---|---|---|
| 单独的新加坡服务器 | 隔离生产负载，能按空白初始化/重启验收，独立安排 80/443 | 新主机费用与维护；用户确定规格/磁盘，含备份峰值容量验证 |
| 升级现有服务器 | 复用机器与现有服务设施，增加 CPU/RAM/磁盘余量 | 升级可能需停机，生产影响需用户授权；升级不解决已有端口冲突，P4 空白脚本仍不适用 |
| 复用既有反向代理或 cloudflared，仅内部端口 | 不占 80/443/3000/8080，新服务可接专用 ingress | 必须确认实际代理/隧道网络、域名/TLS/可信 IP 链及权限；仍需解决资源缺口，与新机/升级选择组合 |
| 不安装 Dokploy，采用 plain Compose | 无额外面板/Traefik资源和端口竞争，符合官方交付 | 运维依靠 SSH/runbook；旧机需结合既有入口，新机可用内置 Caddy |
| 在用户选择的充足新机安装 Dokploy | 可用推荐运维界面管理同一 Compose 和 Traefik | 增加资源与维护需求；安装/80/443 接管需用户明确授权，不能照搬到现有生产机 |

容量方案和入口/运维方案可组合，互不替代。待用户决定主机（新机或升级/复用）、入口、是否使用 Dokploy，并确认域名、磁盘/备份存储与允许的重启窗口。**本提案不假设部署到该 ECS**；服务器 tasks 在决定和授权完成前持续 BLOCKED。

### 协调者/B 签收：容器与宿主重启退出证据

当前 `exited` 限制已在上述事实与决策 3 指明。由 B owner 给出与容器 recreate、主机 boot、独立临时恢复匹配的可信生命周期实现并复验；D 接线并验收，不扩大为 D 自行重写引擎。验收行为固定，具体 B 内部机制的修改不在本 propose-only PR 中。

### 实施配置

固定 WAL-G/Ubuntu/Debian/Dokploy 支持版本、每日备份 UTC 时刻、同步间隔和上传限额在首批兼容验证中锁定；本次两备份目标按上述用户决定使用同一 R2 账号的独立桶/token。保留行为、独立凭据、主机选择门和镜像/安全契约不因这些参数改变。
