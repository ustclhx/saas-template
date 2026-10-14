# Tasks

本轮 **propose only**，所有实施项未执行且保持未勾选。依赖已合入 A/B；先按 apply 技能读取 artifacts，仅实施协调者分配的编号。C 存储是 B 5.3/5.4 前置能力，不修改或勾选 B 媒体任务。

并行安排：**存储 1 ∥ Sentry Node 2 ∥ SMTP 3** 的新增 adapter/目标测试各有独占 owner；各组的配置/入口接线由协调者分批串行整合，然后执行 4 的跨组验收。共享文件包括 packages/config、shared 脱敏、web/jobs Node runtime、handlers/registration、manifest/lockfile、构建/上传脚本、deploy/selfhost 和 CI；任何 worker 不同时改这些文件，协调者合并各组明确补丁。中立 Storage、EmailSender 和平台契约不随意扩展；不提交数据库迁移、不改 D 的生成器/镜像发布/部署/备份。

所有资源只用隔离本地/CI 配置，密钥经既有 env/`_FILE` 读取，不进入命令输出或仓库。下述新增 `test:node:s3` / `test:node:smtp` / Sentry 目标 fixture 命令是本 change 应交付的验证入口，当前尚不存在，不能写成已通过。每组同步其文档与精简核心用例；不为 SDK 转发或 getter 写重复测试。

## 1. 存储（S1/S2，storage owner；共享接线协调者串行）

- [x] 1.1 实现 `packages/storage/src/node/` 通用 S3 adapter 与 `./node` export，保持 Storage/MediaOutputCopier 中立，显式传配置与凭据；协调者接入 S3 schema/布尔校验/固定 `_FILE` allowlist，未配置 unavailable、部分配置启动拒绝。验证：config 的缺项/非法 URL/文件冲突/无值泄漏用例、storage typecheck/node-import 及 `pnpm check:deps` 通过；README 记录外部 S3/R2 参数与一条公开 endpoint 规则。
- [x] 1.2 实现 HEAD/幂等 delete/600 秒 PUT/300 秒 GET、签名 MIME 和 If-None-Match、attachment 与既有两类 key 校验；SDK 版本与 checksum/签名头策略锁定。验证：新增真实 S3 fixture `pnpm --filter @saas/storage test:node:s3` 覆盖 PUT→HEAD→GET→DELETE、403 不伪装 missing、过期/篡改签名、重复/并发条件 PUT 拒覆盖、path-style 两模式（虚拟主机模式提供 fixture DNS/TLS）；复用 CF presign 断言并保留原测试，文档列支持操作及不兼容处理。
- [x] 1.3 实现安全流式 Node MediaOutputCopier，复用 HTTPS 白名单/无重定向/MIME/实际大小限额，支持既有 binary 输入；multipart 有界内存、异常 cancel/abort/清理，不吞删除失败。验证：fixture 覆盖恶意重定向、缺/伪造 Content-Length、MIME 错误、实际超限、断流、残留分片、对象成功而确认失败后的确定性重放与配额仅一次；storage README 记录接口与清理失败重试，不称 B 工作流已移植。
- [x] 1.4 协调者装配 web files/downloadFile 和 jobs delete capability，处理 jobs string|string[] 桥接并启用已装配的十分钟文件清理；保留未配置/预渲染 unavailable 和独立 workflow gate。验证：Node 文件业务测试复用实际大小、并发配额、跨租户/失效会话/分享撤销、清理失败锚点；真实 HTTP 上传/确认/下载可用，而 storage-only 媒体仍 503 且 task/hold 数不变；更新平台能力和 C→B 5.3/5.4 交接文档，不改 B 勾选。
- [x] 1.5 为 deploy/selfhost 增加默认关闭的 `object-storage` SeaweedFS Community 4.48 profile 与无真值配置，固定并复核 manifest 双架构；最小组件、私有 bucket、管理/应用权限分离、幂等 CORS 初始化、非 root/文件密钥/持久卷/health/资源/滚动日志，公开 API 经独立 HTTPS 子域。验证：profile 关/开分别 `docker compose config`，关时无本地 secret 前提；真实空目录启动与重启 UID 非零、对象保留、匿名读取拒绝、管理接口无公网端口，代理仅80/443且保留签名 Host/path/query；README 记录初始化与关闭保留数据方式，不建/发布 D 应用镜像。
- [x] 1.6 验收 profile 的真实浏览器 CORS/预签名与整个 2 CPU/4 GiB 栈资源预算，收敛 profile 的 web/jobs/storage 限额与安全并发。验证：APP_URL 的 OPTIONS/PUT/GET/HEAD 及 Content-Type/If-None-Match 成功，未授权 origin 被拒；记录 idle/并发上传/未知长度转存/维护/重启 CPU、峰值内存与余量，无 OOM，不能仅测存储单服务；报告初始预算与最终预算区别，未通过不勾选 S2。
- [ ] 1.7 验收外部 S3 默认路径，包括 R2 经 S3 API 的可配置端点与另一个兼容端点；交付 B 可使用的存储/copier 证据。验证：使用同一业务/SDK 验收上传确认/短期下载/权限配额/失败清理，关闭 profile 无自带服务；没有外部凭据时写明未完成而不以本地服务冒充外部联通，不实际移植 B 5.3/5.4。

## 2. Sentry Node（O3，Node 观测 adapter owner；共享文件协调者串行）

- [x] 2.1 在 web/jobs Node 专属模块装配 `@sentry/node`，经现有 observer 接线、早期 ESM 初始化、DSN+环境可选开启，复用 beforeSend；协调者整合入口/manifest 与必要的最小脱敏补丁。验证：Node observer fixture 缺 DSN/development 零初始化/零网络、HTTP与后台异常可采集、redirect/notFound/低于500 AppError仍过滤，Node bundle 不加载 CF SDK，CF 原有 Sentry测试不变；文档记录开启条件与目标边界。
- [x] 2.2 完成并发请求/消息 isolation scope、标签与安全异常 envelope，禁 PII/正文/自动 DB/AI/Queue内容和 breadcrumbs，保护 Error.message/stack/cause 中的链接/凭据。验证：实际 transport envelope 的两个空间并发事件各自身份正确，恶意异常中的 Authorization/Cookie/OTP/签名 query/S3/SMTP凭据/正文不出现，安全码与源码 frames 保留；重复捕获不重复上报，监控出站失败不改业务/DLQ结果，shared/CF 脱敏回归通过。
- [x] 2.3 补齐 Node web/jobs server maps，并复用现有 release→inject→upload 流程增加 `.output/server` 与 dist `web-node/jobs-node`；token 仅上传步骤使用，产物无公开 maps。验证：`pnpm build:node` 的两输出含预期 source map/debug id、完整 SHA和正确 dist，上传 fixture 选中 Node 路径且不串 CF；生产 HTTP 对 map 访问不可用、无凭据 build/预渲染仍通过；记录运行命令，不改 staging 触发器或承接 D 发布流水线。
- [x] 2.4 把 flush/close 接入 A 剩余 shutdown deadline，正常退出/未启用/监控断网都不延长预算。验证：真实 Node 子进程 capture 后 SIGTERM 的可达/不可达 transport 退出在上限内，没有改变 DBOS停止领取/排空/业务池关闭顺序，未启用无副作用；文档记录可能未发出事件的边界。
- [x] 2.5 在已授权 Sentry 测试项目验证同版本 Node web/jobs 可读源码堆栈与受控错误采集。验证：事件的完整 SHA、dist、requestId/任务标识与源码位置有脱敏记录，既有实时admin/同源/先审计异常入口保护保持；无项目凭据时保持此项未完成，transport fixture 不能代替真实 source map 验收。

2026-10-14 验收记录：release 70496c6（environment smoke，本地 Node 生产输出）web-node 事件顶帧映射 `apps/web/src/server/sentry-test.ts:30`、jobs-node 事件映射 `packages/email/src/node/smtp.ts:165`，源码上下文可读、各 1 事件、无凭据/正文，见[核验证据](../../../docs/runbooks/evidence/selfhost/c-2.5-sentry-node-verification-70496c6.json)；此前 65c0413 的 web-node 映射失败由 #179 修复，[原失败证据](../../../docs/runbooks/evidence/selfhost/c-2.5-sentry-node-verification.json)保留。

## 3. SMTP（E1，email Node adapter owner；共享配置/consumer协调者串行）

- [x] 3.1 实现 `@saas/email/node` Nodemailer SMTP sender；协调者加入 Node smtp 通道/host/port/TLS模式/成对认证/password `_FILE` 校验和现有 consumer sender 注入，保留 CF log/resend 及稳定 Resend 幂等键。验证：config 与 email 现有测试通过，smtp 无 Resend key 可装配、显式通道缺项启动拒绝且不回退；中立/CF 导入不加载 Node SMTP，文档记录配置与内部明文模式边界。
- [x] 3.2 复用模板/from/replyTo/list headers，SMTP 隐式TLS/强制STARTTLS/受控内部none模式有界发送；按 responseCode 优先分类网络/4xx/永久5xx/本地配置错误为安全 EmailSendError，debug关闭、禁止附件文件/URL读取。验证：新增 `pnpm --filter @saas/email test:node:smtp` 的本地真实协议 fixture 验证模板接收、465式TLS/STARTTLS、证书验证拒绝、不降级、451/454认证临时失败 retryable、535/550 non-retryable、超时/断流脱敏；不测试 Nodemailer 内部实现，README列TLS与错误策略。
- [x] 3.3 在 B 的真实 Node inbox/DBOS consumer 接 SMTP，保持初次+5重试、原退避、混合批次成功独立确认、有效失败先DLQ/无效消息确认；不加入第二套重试或跨通道回退。验证：jobs `test:node` 与 `test:node:integration` 在隔离 PG/SMTP fixture 中证明暂时失败后成功、永久/第六次边界写持久DLQ、sink失败不提前ack；已有真实六次生产时钟证据仍归 B，不把构造第六次称为完整时间轴，文档保持 inbox/DLQ权限与保留期。
- [x] 3.4 通过真实持久邮件链路验证注册验证/重置密码等认证邮件，记录稳定 Message-ID 和 SMTP接受后确认前故障的至少一次边界。验证：Node auth HTTP/e2e + 本地 SMTP捕获fixture 完成入队→收件→验证链接，不查DB token代替送达；临时 SMTP故障不使成功入队请求失败，不确定结果允许原身份重试且不自动切Resend；文档明确潜在重复投递，不承诺 SMTP幂等或 exactly-once。

## 4. 跨组集成验收（协调者，依赖已完成的各组）

- [x] 4.1 集成共享入口/配置/依赖/构建/Compose 补丁后，执行 `openspec validate add-selfhost-storage-observability --strict`、根 `pnpm check`、`check:deps`、`check:singletons`、`dedupe --check`、`typecheck`、`test`、`build`、`build:node`，以及各组三种 Node 目标验收。验证：记录命令/结果，CF默认构建和既有用例通过，无Cloudflare bundle引入Node adapter，已知失败先处理，不弱化断言或删除测试。
- [x] 4.2 核对 S1/S2/O3/E1 与 C→B 交接证据、未完成外部凭据验收和 D 边界，确认只勾选有真实证据的 C 项。验证：review记录逐项映射需求/用例/文档，存储-only媒体gate仍正确、B任务未提前完成，S2全栈资源与真实source map证据缺失时明确保持对应项待办；不以PR合入替代部署、不手工部署分支到staging、不由worker同步或归档change。

2026-10-15 协调者签收（4.1）：b43c6b3 上 strict validate、根 check/check:deps/check:singletons/dedupe --check、无缓存 typecheck/test/build 与 build:node 通过；三种 Node 目标：存储 `test:node:s3` 28 项与 `test:node:storage` 18 项、SMTP `email test:node:smtp` 22 项与 `jobs test:node:smtp` 6 项、Sentry observability 5 项/jobs node-sentry 6 项/`sentry-node-maps` 3 项全部通过。CF web server 2082 与 jobs 829 个 source 无 Node S3/SMTP/Sentry adapter，Node 输出无 CF adapter。首次缓存测试的 routeTree 生成物缺失经无缓存 typecheck 恢复，未改断言或测试。证据：[签收记录](../../../docs/runbooks/evidence/selfhost/signoff-2026-10-15.json)。

2026-10-15 协调者 review（4.2）：

| 需求 | 任务 | 用例/证据 | 文档 | 结论 |
| --- | --- | --- | --- | --- |
| S1 Node 通用 S3 配置/文件一致性/安全转存 | 1.1–1.4 | config 用例、`test:node:s3`、`test:node:storage`（含 storage-only 媒体 503 且 task/hold 不变） | storage README、[selfhost-c-storage](../../../docs/runbooks/selfhost-c-storage.md) | 本地/fixture 通过；外部 R2 与第二兼容端点 1.7 无凭据，保持待办 |
| S2 可选自带对象存储 | 1.5–1.6 | #144 profile 开关 config、真实 CORS/预签名与 2C/4GiB 全栈资源 | [selfhost-c-profile](../../../docs/runbooks/selfhost-c-profile.md)、[资源记录](../../../docs/runbooks/selfhost-c-profile-resources.json) | 有真实全栈资源证据，已勾选项成立 |
| O3 Node Sentry | 2.1–2.5 | observability/node-sentry/maps fixture；真实项目 source map 证据 | [sentry-node-adapter](../../../docs/runbooks/sentry-node-adapter.md)、[2.5 证据](../../../docs/runbooks/evidence/selfhost/c-2.5-sentry-node-verification-70496c6.json) | 真实 source map 证据存在，已勾选项成立 |
| E1 SMTP | 3.1–3.4 | `email`/`jobs test:node:smtp`、jobs 持久 DLQ、认证邮件链路 | email README、[3.4 证据](../../../docs/runbooks/evidence/selfhost/c-3.4-auth-smtp.json) | 本地 SMTP fixture 通过；无外部 SMTP 服务承诺 |
| C→B 5.3/5.4 交接 | 1.4、B 5.3/5.4 | C 只交付工厂与独立 gate；B 5.3/5.4 由 B 的 #173/#174 以自身证据勾选 | [selfhost-c-storage §C→B](../../../docs/runbooks/selfhost-c-storage.md) | 无提前代勾 B 任务 |
| D 边界 | — | C 未承接镜像发布/部署/备份；S2 上游镜像引用不等于 D 发布 | proposal 非目标 | 边界保持 |

只勾选 4.1/4.2；1.7 外部 S3 联通明确保持待办，change 因此不可归档。未部署、未手工发布 staging、未同步或归档。
