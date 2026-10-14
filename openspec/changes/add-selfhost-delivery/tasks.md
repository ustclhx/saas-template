# Tasks

本轮 **propose only**，以下均为未来实施项，保持未勾选。执行 apply 时只领取分配编号；根检查通过不表示镜像、备份或服务器验收完成。不改 A/B/C tasks，不归档，不提交 worker 迁移 SQL，不手工部署共享 CF staging。

文件所有权：CI owner 独占新增 selfhost workflow/bundle；deployment owner 独占 deploy/init/代理配置；backup owner 独占 backup/restore/同步脚本与工具镜像；generator owner 独占 create-project/功能裁剪。共同 `compose.yaml`、PG Dockerfile/入口、`.env.example`、README、template/config/server、manifest/lockfile 由协调者指定唯一 owner 串行集成，不能让上述 owner 同时写。B 引擎 ownership 改动交 B owner，不在 D 偷改。

波次：1.1 →（1.2–1.3 ∥ 2.4–2.5 ∥ 3 ∥ 4.1–4.4，文件互斥）；2.1–2.3 依赖镜像与 1.5 的 B 签收；4.5–5 依赖备份；1.4 在部署/初始化/备份/恢复脚本交付后打包完整 bundle；6 集成前述成果；7 全组 **BLOCKED（用户主机决策/授权/资源）**。本地临时 VM 验证不解除真实服务器决策门。

## 1. 镜像发布与集成交接（P1，协调者/CI owner）

- [x] 1.1 固定各 worker 文件所有权、A/B/C 依赖与 capability 同步顺序，记录 B/D 容器 recreate、boot 与恢复退出证据的签收清单。验证：交接文档含确切文件/接口、未完成 A/B/C 项和第 7 组阻塞原因；无重复 requirement 名、无越权归档。
  - 2026-10-14：交接草案见 `docs/runbooks/selfhost-delivery-handoff.md`；已记录实际 ownership 补修与剩余依赖，待协调者审阅后勾选，worker 不勾选。
- [x] 1.2 基于 A Dockerfiles 建立两个架构的 CI 构建/运行矩阵，核对各基础 digest 为 multiarch manifest；配套 PG/Valkey/Caddy 和备份镜像纳入同 SHA 集合。验证：buildx manifest 含 linux/amd64、linux/arm64，各架构非 root 启动与原生依赖 smoke 通过，web/jobs 固化完整 SHA，无 build secret/CF 平台依赖；记录实际版本。（P1）
  - 2026-10-14：只读 CI 矩阵与现有七镜像 build/runtime smoke 已实现；五个基础 digest 已实查含两架构。backup 工具仍依赖 4.1，完整集合及双架构 CI 验收未齐前不勾选。
- [x] 1.3 新增独立 GHCR 发布 workflow，支持显式 OCI namespace、最小 registry 写权限、受信提交发布、不可覆写 SHA 与完整集合 gate。验证：PR 没有写权限/服务器密钥，失败架构不发布可部署 release，成功 registry manifest/digest/revision 与源 SHA 相符；更新发布说明，CF CI/staging 原路径不变。（P1）
  - 2026-10-14：独立手动发布 workflow、集合/信任/不可覆写 gate 与发布说明已实现。缺 backup 时只读阶段阻断；合并前不真实发布，registry 验收由协调者按 `deploy/selfhost/images/README.md` 首次触发后签收，此前保持未勾选。
- [x] 1.4 打包同 SHA 的部署 release bundle，包含 Compose/脚本/示例及镜像 digest 清单，更新 image-only `.env.example` 和 README 的过时 B 状态。验证：从干净目录仅拉 bundle/镜像即可 `compose config`，无服务器构建/源码依赖、无真值；所有必需服务的引用与 release SHA 一致。（P1、P2）
  - 2026-10-14 d-bundle：已读取成功发布run38573156122的真实image-set，并从80983d2完整SHA的Git对象生成正式17项部署bundle；包内原版verify与干净目录config通过。当前补齐未来SHA的24项完整恢复/副本/示例白名单，旧SHA不混入未发布修复；新版真实提交结构与全部override config通过。原SHA仍缺7项完整恢复材料，正式完整bundle需协调者决定后续发布，保留未勾选。证据：`docs/runbooks/evidence/selfhost/d-bundle-2026-10-14/`。
  - 2026-10-14 d-bundle2：第二次已批准发布run38588820873成功；从081305013b022f457c561eecf5828b1959e13908的Git对象及真实image-set生成24项完整恢复bundle，manifest与正式发布artifact一致。包内verify、干净目录基础/全部override config、只读CI38596482116匿名拉八服务digest后空卷部署/自然heartbeat/web与jobs完整SHA/TLS/UID/端口/secret隔离通过，临时资源全部清理；下载验收tar的28文件/27checksum/隐藏示例/执行权限与包内verify/config再次通过。根检查与7项bundle单测通过。证据：`docs/runbooks/evidence/selfhost/d-bundle2-2026-10-14/`。2.1/2.3仍依赖1.5签收且未勾选，未触发发布或连接真实服务器。
- [x] 1.5 **依赖 B owner：** 协调者取得可信容器重建/宿主 boot/异机恢复退出证据实现的签收，再由 D 接入持久 ownership 卷、executor ID、hostname/namespace 和版本配置。验证：旧进程仍活时拒绝重用、真实退出后可恢复、container recreate/reboot 不卡住；不删整个 owner 目录、不以 TTL 或 pid:host 猜测绕过。B 改动单独交付，未签收时 2 的恢复与 6.3/7.3 保持 BLOCKED。（§6.8）
  - 2026-10-15 d-vm2：正式598d1f68b6ef7b19e8a6d30c13575bac1701b7c2镜像/bundle在新Debian12 arm64 VM通过exit/namespace/recreate/实际reboot；旧进程仍活且DB锁已释放时明确拒绝，真实退出后恢复，原任务/deadline/成功step保持，无源码补修挂载或pid:host。按协调者已定范围签收本机生命周期；修复前镜像从未上真实服务器，旧缺machineId/token锁记录无迁移路径、要求新卷部署；异机退出证明保留后续开放设计。证据：`docs/runbooks/evidence/selfhost/d-vm2-2026-10-15/`。
  - 2026-10-15 d-vm：正式0813050在临时VM复现同boot跨namespace误接管；补修增加machineId/同机boot证明、跨namespace拒绝、OS flock及可信dead guard恢复，Linux15项与真实PG3项通过。正式/补修独立任务fixture均完成真实reboot、recreate、原deadline与成功step不重放；补修拒绝仍活旧进程且真实退出后恢复。补修未进入固定正式镜像，旧缺machineId记录迁移及异机退出证明未签收，保留未勾选。证据：`docs/runbooks/evidence/selfhost/d-vm-2026-10-15/`。

2026-10-14 协调者签收：1.1 交接清单经审阅（[selfhost-delivery-handoff](../../../docs/runbooks/selfhost-delivery-handoff.md)）；1.2 与 4.1 由 main 70496c6 的 Selfhost images 双架构 CI（run 38555725385）完成 backup 在内的完整集合构建与真实备份/恢复 runtime smoke，arm64 另有 #177 本机证据。1.3：首次正式发布 [run 38573156122](https://github.com/ustclhx/saas-template/actions/runs/38573156122)（SHA 80983d2）与第二次 [run 38588820873](https://github.com/ustclhx/saas-template/actions/runs/38588820873)（SHA 0813050）均成功，`ghcr.io/ustclhx/saas-template/*` 8 个服务为 linux/amd64+arm64 index、revision 与源 SHA 一致、非 root，image-set artifact 已产出；同 SHA 重复触发 [run 38588626877](https://github.com/ustclhx/saas-template/actions/runs/38588626877) 在只读 trust 阶段 7 秒内以 `immutable SHA already exists` 拒绝、未构建未写入（#193）。

## 2. 发布、回滚、入口与初始化（P2–P4，deployment owner）

- [x] 2.1 实现显式 host/dir/SHA 的 SSH 与本机部署入口、文件锁、release 校验、pull、旧 web/jobs 排空退出、强制目标 migrate、成功后 up 的顺序；保留前成功版本。验证：隔离 Compose 初始部署/已有版本升级通过，迁移失败不启动目标 app，发布并发串行，拉取失败不更改运行版本；复用现有脱敏脚本测试风格覆盖关键失败路径，写部署 runbook。（P2）
  - 2026-10-15 d-vm2：正式598d1f6 bundle的严格host key/BatchMode SSH部署、初始新卷及已有版本升级、真实migrator权限失败阻止目标app通过；独立VM内八项机制最终全过，含pull失败保留旧app与并发发布串行。1.5正式flock签收已解除本机依赖，任务勾选；仅本地VM，不代验真实服务器。证据：`docs/runbooks/evidence/selfhost/d-vm2-2026-10-15/`。
  - 2026-10-15 d-vm：临时VM补齐正式0813050完整backup空卷部署、严格host key的显式SSH传输部署和八项隔离发布机制；SSH环境继承宿主代理导致首轮readiness失败已留证，夹具限定NO_PROXY后通过，入口探针补修使用白名单环境，新增真实HTTP回归通过。正式升级/失败门证据见同目录runtime.json；仍依赖1.5签收，保留未勾选。证据：`docs/runbooks/evidence/selfhost/d-vm-2026-10-15/`。
  - 2026-10-14 d-bundle：正式GHCR80983d2 bundle空卷部署、metadata-only本地registry第二版更新、真实角色迁移失败阻止目标app、health失败保持成功记录通过；原隔离registry八项机制测试补齐pull失败和并发串行。只读CI38583108140成功，PG/DBOS为正式镜像的真实迁移与自然心跳，控制路径已完成，但tasks波次明确2.1–2.3依赖1.5的B签收，正式签收仍保留未勾选；未完成任务恢复/真实SSH服务器不代验。
- [x] 2.2 实现有界 health readiness/完整 SHA 检查及 jobs 版本确认，等待窗口覆盖首次五分钟心跳；失败非零退出、输出目标/观察 SHA 和回滚命令。验证：成功/旧 SHA/503/半开请求/任务版本不符在隔离 HTTP 或真实服务上得到正确结论，无连接串和凭据输出。（P3）
  - 2026-10-14：health门默认360秒覆盖五分钟slot，独立web/jobs完整SHA与依赖/成功心跳；9项精简部署/HTTP测试覆盖旧SHA、503、半开响应、jobs版本及脱敏，隔离Compose旧SHA失败返回非零和回滚命令。
- [x] 2.3 实现上一成功 bundle/镜像回滚入口与 schema/DBOS handler 兼容门，不自动 down migration；不兼容指向新卷恢复。验证：兼容双版本更新→失败→回滚后 SHA 正确、卷和任务状态保留；不兼容案例明确阻止并给出匹配备份操作步骤，未执行生产数据倒退。（P3）
  - 2026-10-15 d-vm2：同正式bundle/镜像及仅版本元数据的本地registry第二版完成更新→真实迁移/HTTPS health失败→兼容回滚，返回598d1f6完整SHA，不跑旧migration；真实PG/DBOS/任务状态及卷保持。八项机制含不兼容前置拒绝/匹配备份新卷恢复指引通过。1.5已签收；无第二正式发布、不执行生产倒退，异机恢复仍后续。证据：`docs/runbooks/evidence/selfhost/d-vm2-2026-10-15/`。
  - 2026-10-15 d-vm：正式GHCR与只改版本元数据的本地registry双版本回滚验证见runtime.json；不把补修源码挂入正式镜像。兼容门与并发/失败编排另有八项机制证据；恢复签收仍依赖1.5，保留未勾选。证据：`docs/runbooks/evidence/selfhost/d-vm-2026-10-15/`。
  - 2026-10-14 d-bundle：CI38583108140从正式GHCR版本更新至只改固化SHA的本地registry fixture；迁移/health失败后回滚至GHCR完整SHA，真实已完成schedule_run/DBOS workflow/checkpoint、578列schema、三角色元数据及卷保持，未跑旧migration。不兼容前置拒绝由八项隔离机制测试补齐。真实业务/inbox为空；未完成任务重放和可信ownership仍依赖1.5，保留未勾选，不把终态保留冒充恢复签收。
- [x] 2.4 写同 Compose 的 Dokploy/Traefik 与既有代理/cloudflared 接入说明，配置关闭 Caddy、只接 web ingress、确切 trusted proxy 与 secret 权限。验证：plain config 和外部代理最终渲染均无 build/额外数据端口，TLS/恶意 XFF/非 root 通过；Dokploy 实机演示需获准测试资源，否则只记录文档/静态证据，留第 7 组实际验收。（P2）
  - 2026-10-14：同Compose代理override及Dokploy/Traefik/cloudflared runbook交付；plain/external最终渲染、实际TLS/未知CA拒绝/恶意XFF清洗/UID与无数据端口通过，实际Dokploy/Tunnel留第7组。
- [x] 2.5 实现 init-server.sh 单命令入口，固定支持的 Ubuntu/Debian/架构与 Docker/Compose 版本，安装并启用开机启动、配置保留 SSH 的 22/80/443 防火墙、受限目录和无真值 env 骨架。验证：临时空白 VM 安装与重复执行通过，已用主机/冲突端口拒绝且未覆盖配置；从 VM 外部验证 Docker 防火墙后端下实际端口，不 flush 规则、不默认安装 Dokploy；同组交付初始化 runbook。（P4）
  - 2026-10-14：临时Debian12 arm64 Lima VM实际安装/幂等/拒绝已用和冲突/哨兵不变；VM外部22/80/443可达、Docker发布8080/5432被阻止，daemon restart与实际VM reboot恢复。8安全用例通过；其它OS/架构实机、全栈/B恢复仍留6.3/第7组，VM已删除。

## 3. 项目生成与功能关闭（P5，generator owner，共享配置串行）

- [x] 3.1 将生成器 `--target` 专用于 cloudflare/selfhost、输出迁至 `--output`，同步交互/help/docs/create-project.md 的 breaking 迁移提示。验证：现有边界用例扩展目标默认/非法/旧路径提示，保留防覆盖和源树保护；`pnpm test:create-project` 通过。（P5）
- [x] 3.2 生成 selfhost 的 namespace、发布 CI、Compose 和无真值运维/secret 清单；补路径排除 secrets/certs、无扩展名密码、私钥、ownership/备份/release 状态。验证：已有 fixture 用哨兵证明不复制、不读取真值，保留 example/脚本；真实副本再次生成新项目名称与 namespace 正确。（P5）
- [x] 3.3 在既有 template/config 中表达 billing/credits/营销/i18n 启用状态与关闭组合，保持默认开启行为和三层配置归属。验证：config 精简用例校验有效/无效依赖组合，关闭模块不再要求其 secret/seed；同步功能开关文档，不增加业务分叉。（P5）
- [x] 3.4 接线关闭 billing/credits 时 web 入口、导航/权限和 jobs 注册；保留 auth/workspace/email/operations/成功 heartbeat，不删历史账本。验证：复用相关 Node 用例覆盖全关组合无计费/积分任务、无 seed 依赖，正常认证与空间仍可用；CF 默认业务测试通过。（P5）
- [x] 3.5 接线关闭营销的应用首页及关闭 i18n 的单语言构建/路由，调整生成的启用功能清单。验证：实际 Node SSR/静态资源与登录后入口可用，未启用的营销/多语言入口不注册，启用时既有 marketing/i18n/SEO 用例保持；记录单语言行为。（P5）
  - 2026-10-14：PR #186 实施并验收；三种真实副本安装/typecheck/单测/Node build 全通过，独立只读 CI 在空卷中验证中文 SSR、静态资源、关闭入口、验证邮件/登录/空间、成功 heartbeat 与 web/jobs 完整 SHA。证据：`docs/runbooks/evidence/create-project/2026-10-14/selfhost-features.json`，CI run `38563638983`；单语言行为见 `docs/create-project.md`。
- [x] 3.6 扩展真实副本验证，至少 CF 默认、selfhost 默认及 selfhost 全关 billing/credits/营销/i18n（AI 可关闭）三个组合。验证：`pnpm test:create-project`、`pnpm test:create-project:verify` 与各副本 Node build 通过，CI 构建全关副本镜像并在空卷 Compose 实际启动、登录/空间/heartbeat/完整 SHA 通过；不能仅文本快照宣称可运行。（P5）
  - 2026-10-14：PR #186 实施并验收；三种真实副本安装/typecheck/单测/Node build 全通过，独立只读 CI 在空卷中验证中文 SSR、静态资源、关闭入口、验证邮件/登录/空间、成功 heartbeat 与 web/jobs 完整 SHA。证据：`docs/runbooks/evidence/create-project/2026-10-14/selfhost-features.json`，CI run `38563638983`；单语言行为见 `docs/create-project.md`。

## 4. 基础与逻辑备份（B1、B2，backup owner）

- [x] 4.1 为 selfhost PG/工具镜像安装固定 checksum WAL-G（两架构），增加文件 secret、S3 endpoint/region/prefix/path-style/CA、禁用元数据探测与非 root 配置。验证：独立 S3 兼容夹具、两架构 UID/secret读取/TLS失败边界通过，app 三角色权限不变，web/jobs 无备份管理凭据；写配置说明。（B1）
- [x] 4.2 启用 PG WAL 归档及 wrapper、归档延迟/失败状态查询；设置一处持久调度与互斥，每日 full base，配置备份资源/上传限额。验证：真实写入→S3 base/WAL/timeline 可查询，重启后调度恢复，目标不可达非零失败/不丢 WAL；记录空间和连接预算，不改 CF infra/postgres。（B1）
- [x] 4.3 实现 7 天每日+4 周每周锚点的可调保留计划、dry-run、WAL链保护和失败禁止破坏性清理。验证：精简保留边界用例及隔离 S3 清理证明最老 weekly base 仍可 PITR；缺段/新备份失败/副本失败保留可用链；固定 WAL-G 删除行为有实际证据，runbook禁止独立年龄删 WAL。（B1）
- [x] 4.4 实现每日 custom-format pg_dump 与角色/权限恢复材料、受限临时空间、成功后上传、失败清理和状态。验证：`pg_restore --list` 与隔离完整恢复成功，业务/任务 schema 和角色权限一致，磁盘不足/上传失败明确非零、日志无真值；写逻辑备份用途与保留说明。（B2）
- [x] 4.5 实现 backup 状态查询与 runbook（最近 base/dump/归档/副本成功、连续上界、失败计数、pg_stat_archiver/磁盘），整合工具服务健康/重启/资源/log rotation。验证：失效注入状态正确、重启自动恢复调度，CPU/RSS/连接/WAL/磁盘峰值记录，不用“进程活着”冒充备份成功。（B1、B2）

## 5. PITR、演练与第二供应商（B3–B5，backup owner）

- [x] 5.1 实现新空目录/卷 restore.sh：目标 UTC 时间/backup ID 校验、匹配 PG17、base+WAL 恢复、暂停/校验/显式 promote 边界。验证：隔离数据目标前/后 marker 正确，非空/生产路径、缺 WAL 和目标越界非零失败；无 jobs/外部副作用/主归档写入；交付新服务器恢复 runbook含 secret/TLS/ownership/外部对象边界。（B3）
- [x] 5.2 实现独立 project/volume 的 restore-drill.sh 和 schema/角色/业务/任务校验，复用积分余额对账（启用时），输出恢复点/耗时脱敏报告。验证：从实际 S3 恢复通过，失败保留诊断，清理仅本脚本资源，PG无公网端口且生产未改；提供可重复命令。（B4、§6.7）
- [x] 5.3 实现独立第二目标配置与 base/dump/WAL/history 复制入口、完整性清单、连续上界/延迟、独立保留及不传播删除。验证：两个隔离 S3 目标的重复同步/中断/源删除/第二目标故障通过，主归档独立成功且副本失败可见；写调度/RPO/权限说明。（B5）
- [x] 5.4 禁止访问主目标，以第二目标独立凭据恢复相同时间点并校验完整恢复链。验证：只靠副本 base/WAL/history 与独立恢复材料成功，记录可恢复上界及同步延迟；两个本地桶只证明机制，真实不同供应商账号验收仍待 7.2。（B5、B3）

## 6. 本地与 CI 集成验收（各 owner 完成后协调者验收）

- [x] 6.1 在本地/CI 空卷使用 registry 预构建镜像与 release bundle 验证 plain Compose、已有版本更新和 rollback；检查非 root、TLS、端口、secret隔离、持久卷与 Node health/任务 SHA。验证：脱敏 config/ps/版本/迁移失败/回滚证据齐全；不把应用健康当完整 backup 成功，不代勾 A/B/C。（P1–P3）
  - 2026-10-14 d-bundle：只读CI38583108140通过，匿名pull八个正式GHCR digest；空卷plain Compose、metadata-only本地registry第二版更新、真实迁移/HTTPS health失败→兼容回滚、自然五分钟heartbeat与web/jobs完整SHA、PG verify-full/CA/hostname失败、HTTPS未知CA拒绝、非root/端口/secret隔离、真实终态DBOS记录与卷保留通过。证据位于`docs/runbooks/evidence/selfhost/d-bundle-2026-10-14/`；1.5/未完成任务重放/完整backup/真实服务器未代验。
- [ ] 6.2 正式运行一次 S3 指定时间点恢复演练并从第二目标独立重复，记录业务/角色/引擎数据校验和资源/RTO/RPO。验证：§6.7 本地通过，至少一组最老受保留 weekly base 可恢复，失败路径不伤生产；真实存储资源尚未提供时其外部验收保持待办。（B1–B5、§6.7）
- [x] 6.3 在临时 Ubuntu/Debian VM 验证单命令初始化、幂等与拒绝已用主机，然后部署并实际 reboot。验证：SSH保持、外部只允许22/80/443、Docker开机启动，全部常驻服务（含backup）自动恢复、一次性迁移不循环、health/jobs完整SHA，B退出证据/任务恢复通过；1.5未签收保持BLOCKED。这是本地VM证据，不替代7.3。（P4、§6.8）
  - 2026-10-15 d-vm2：正式598d1f6新卷全栈部署与实际VM reboot通过；SSH保持、外部22/80/443与Docker发布8080/5432阻断、init幂等/已用及冲突拒绝、Docker/防火墙自启均通过。PG/Valkey/web/jobs/Caddy/backup及受控任务自动恢复；migrate ID/完成时间/restartCount不变，fresh自然heartbeat与web/jobs完整SHA、backup scheduler/成功slot及数据卷保持。1.5正式flock本机签收已通过；本地VM不替代第7组。证据：`docs/runbooks/evidence/selfhost/d-vm2-2026-10-15/`。
  - 2026-10-15 d-vm：新建Debian12 arm64 2C/4GiB临时Lima VM，完成init/幂等/拒绝已用及冲突、外部22/80/443与真实Docker数据端口阻断、完整backup及真正宿主reboot。第二轮常驻服务自动恢复、migrate未重建或重跑、自然heartbeat与完整SHA、备份成功slot和持久状态保持通过；首轮/tmp夹具失败如实保留。固定正式B缺口与1.5未签收使本项仍BLOCKED；第7组不变。证据：`docs/runbooks/evidence/selfhost/d-vm-2026-10-15/`。
- [ ] 6.4 集成后执行 `openspec validate add-selfhost-delivery --strict`、根 `pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm dedupe --check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 及 Node/生成器相关新增验证。验证：全部通过，双目标未串产物或削弱 CF 测试/staging；合入后 main 自动 staging/health 回归由协调者记录，未获得发布证据不冒充通过。（集成）

## 7. 服务器验收（全部 BLOCKED：等待用户决策与资源）

本组依赖 design Open Questions 的用户选择：单独新机或升级/复用、入口（Caddy/既有代理/cloudflared）、是否使用 Dokploy；以及实际主机授权、域名/TLS、独立存储账号和重启窗口。不得假设是已有 product-res-ecs，不连接或修改它。用户决定后协调者放行相应编号；不用本地验证提前勾选。

- [ ] 7.1 **BLOCKED（用户主机/入口/运维决策）**：在选定且获授权的新加坡测试主机从 release bundle 部署；空白主机才运行 init，复用主机仅按获准方案接内部代理。验证：无供应商专有配置/服务器构建、正确SHA/任务readiness；选择Dokploy时同Compose由其Traefik提供入口、无Caddy抢端口；资源/磁盘/备份峰值有余量。（P1–P4）
- [ ] 7.2 **BLOCKED（用户提供独立备份资源和演练窗口）**：验证每日 base+WAL、pg_dump、保留策略及第二供应商真实独立账号；服务器临时实例执行指定时间点恢复。验证：§6.7通过，主目标不可用时副本单独恢复通过，数据/角色/任务校验、RTO/RPO/状态报告齐全，未触及已有生产卷。（B1–B5、§6.7）
- [ ] 7.3 **BLOCKED（用户批准真实重启窗口且1.5签收）**：实际重启所选服务器。验证：全部常驻服务无手工修补恢复，health/jobs目标完整SHA、数据及同版本任务状态正确、备份调度恢复；失败如实记录且不影响已有未授权服务，不用容器restart代替整机reboot。（§6.8）
- [ ] 7.4 **BLOCKED（以上服务器证据齐全）**：协调者审阅需求/证据矩阵并确认未完成项。验证：P1–P5/B1–B5/§6.7–8逐项有证据，所有分配项验收通过才勾选；PR列出仍需用户事项，同步和归档只由协调者执行。（集成）
