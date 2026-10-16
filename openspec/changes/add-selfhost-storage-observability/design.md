# Design

## Context

动机、S1/S2/O3/E1 和 C/D 边界见 [proposal.md](proposal.md)，行为见 [specs](specs/)。设计基于 2026-10-13 checkout 的源码与已合入 A/B；较早文档仍有“B 尚未装配”的阶段描述，不能据此忽略当前实现。

- `packages/storage/src/storage.ts` 已有中立 Storage；`src/media.ts` 的 MediaOutputCopier 和 persistMediaOutputs 已隔离持久化业务。`package.json` 只有中立/Cloudflare exports；CF `presign.ts` 仍固定 R2 endpoint 与桶。`files.ts` 已实现 pending/ready、实际 HEAD、空间锁、配额、分享与墓碑重试；不需要更换这些业务实现。
- `apps/web/src/node/runtime.ts` 的 files、downloadFile 和媒体 workflow 均 unavailable；文件 HTTP/RPC 已通过中立接口调用，能力检查早于 DB/预扣。jobs `src/node/runtime.ts` 的 files unavailable，registration 允许跳过未装配文件清理。`JobsContext.files.delete` 当前接受 string|string[]，而 Storage.delete 只接受 string，装配时须处理该差异。
- Node web 的 observability 关闭，server.node 顶层 catch 只日志；jobs 使用 logJobObserver。CF 包装器复用 `packages/shared/src/log.ts` 的 sentryBeforeSend；`redact.ts` 按字段名脱敏，不扫描任意 Error.message/stack/cause 中的凭据，这是新增 SDK 自动采集必须处理的真实边界。
- `packages/config/src/email-env.ts` / node-schema 已有 log/resend 和 `_FILE` allowlist。email 的 EmailSender 与 React Email 模板中立，Resend 使用 fetch 和稳定 idempotency-key；不是缺少 Node Resend SDK。
- B 最终选择 **DBOS 5.2.11 + 自有事务消息 inbox**，不是 pg-boss。Node email 已注入 DeadLetterSink；有效失败先持久写 DLQ，再确认。原始 body 在受控 inbox 中，DLQ 摘要不含正文；C 不改变 B 的保留期。
- 完整读过 deploy/selfhost 全部文件：当前 image-only Compose，PG/Valkey/web/jobs/Caddy 常驻内存上限合计 3328 MiB，CPU 1.7；一次性 migrate 512 MiB/0.3 CPU。仅 Caddy 对外 80/443；没有对象存储服务。CF release/source map 上传仅覆盖 dist，Node `.output` 尚未接入；web Node 已 hidden maps，jobs esbuild 未输出 maps。

主 specs 尚无 file-storage/observability，相关未归档 delta 已存在。沿用同名领域、只追加独立 Node 要求；协调者同步时保留既有权限/脱敏条款，不在本 PR 同步或归档。

## Goals / Non-Goals

**Goals:** 将目标差异限制在 packages 的显式 Node 子入口和 composition；真实 S3 和 SMTP 协议验证安全与失败路径；保留 CF 默认行为及 A/B 生命周期。

**Non-Goals:** 不创建第二套文件数据模型、队列或观测总线，不改 r2Key 列名、不迁移桶内对象；不实现 B 5.3/5.4 或部署 D 的镜像/服务器/备份。C 提供 MediaOutputCopier 是存储交接，不代表媒体 Workflow 已启用。

## Decisions

### 2026-10-16 用户决定：外部联通仅使用 R2

本次 1.7 外部服务验收只使用 Cloudflare R2 S3 API，不再要求第二个外部兼容端点。使用独立私有 `selfhost-files` 桶和仅限该桶的应用凭据；应用身份不读取备份桶，备份身份不交给 web/jobs。通用 endpoint/region/bucket/path-style 能力与已有协议测试保持，不能把本地夹具写成真实 R2 联通证据。R2 外部路径须在关闭自带 profile 时验证上传确认、短期下载、权限/配额和失败清理，交付 storage/copier 证据。

### 1. 通用 S3 Node 适配器与配置（S1）

选择 `@aws-sdk/client-s3`、`@aws-sdk/s3-request-presigner`，流式 multipart 使用 `@aws-sdk/lib-storage`；均只由 `@saas/storage/node` 加载。相比继续扩展 aws4fetch 的固定 R2 实现，通用 SDK 直接处理 endpoint/region/path-style、HEAD/DELETE 和 multipart；不引入厂商专用 SDK。CF 工厂和其绑定保持原路径；API 用法参考 [官方 JavaScript S3 示例](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)。

部署配置采用 `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_FORCE_PATH_STYLE`（严格解析布尔，默认 true）、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；密钥加入 A 的固定 `_FILE` allowlist。前三项不填厂商默认值。完全未配置则 files unavailable，公开页正常；任一原始存储参数出现即按启用处理（schema 自填的默认 path-style 不算用户启用），全部必需项校验成功才装配。endpoint 限 HTTP(S)，禁止内嵌凭据/query/fragment；生产浏览器端点使用 HTTPS，测试内网可用 HTTP。SDK 显式使用配置凭据，不隐式读取云主机 metadata。

**一个浏览器可达的 endpoint 同时用于签名与服务端操作。** 不在签名后替换 Host、桶、协议、路径或查询，也不签发容器域名。自带存储使用独立 HTTPS 子域，Node 通过同一公开地址访问；额外内网 endpoint 优化留待实际需求。path-style=false 要求服务端支持 bucket 子域与对应 DNS/TLS。region 即便外部服务不关心也显式配置。R2 S3 API 的 endpoint、region=auto、桶来自部署配置，属于有效外部服务，不依赖 CF binding。

上传沿用 600 秒 PUT、Content-Type，签入且返回 `If-None-Match: *`；下载沿用 300 秒 GET，attachment disposition 参与签名。SDK 默认额外 checksum/hoisting 行为须按锁定版本验证，不能让浏览器被要求发送未返回的头。key 校验兼容普通 `ws/<workspace>/<file>` 和媒体 `ws/<workspace>/ai/<task>/<index>`，拒绝路径穿越段。

HEAD 只有 NoSuchKey/404 映射 null，403/网络错误必须传播为脱敏 AppError；delete 幂等且失败传播。租户授权和配额仍由现有 files/media/scoped 控制，桶保持私有，不把预签名当作空间权限检查。外部服务若不支持原子的条件 PUT，不能退回 HEAD→PUT 或移除保护；记录不兼容并由协调者处理。SDK driver 原文、URL 和 cause 不进入日志。

web 启用 files 与 downloadFile，jobs 注入仅所需的删除 adapter；为现有 string|string[] 形状在 composition 做小型逐 key 桥接，不扩展中立 Storage 或重写 cleanup。移除已装配时的跳过清理限制，保留未配置时的 unavailable 路径。预渲染不读取部署密钥、不创建 SDK/外部连接。

### 2. 安全转存与 B 交接

Node copier 复用既有来源白名单/MIME/限额规则，HTTPS fetch 使用 redirect:error。Content-Length 只供早拒绝，实际流经字节计数；缺长度同样受限。使用受控 partSize（至少 5 MiB）与低并发流式上传，不整文件 buffer；异常取消 source reader、abort multipart 并清理未完成对象，不能吞掉清理失败。断开/超限/错误响应都释放连接。

现有 copier 输入还允许已取得的 Uint8Array/ReadableStream；Node 保持该类型契约，对这些输入复用 MIME/实际字节限制和流释放，无 URL 时不虚构来源检查，也不启用 Node Workers AI。

确定性对象 key、pending/ready、空间锁、最终配额与重放仍归 persistMediaOutputs；copier 返回实际 `{mime,size}`，不跨 workflow step 持久化 stream。重点验证对象成功而业务确认失败后的重放、失败清理锚点以及未知长度流的内存界限。

C 交付存储工厂、copier、类型与真实 S3 证据，供 **B 5.3** 外壳注入；**B 5.4** 才接媒体 create/status/sendEvent/terminate。C 不注册媒体 workflow，不改 B tasks；仅存储 ready 时媒体仍在 hold 前拒绝。此项避免“解除文件限制”意外放开未移植媒体路径。

### 3. 可选对象存储评估与 profile（S2）

以下是 **2026-10-13 官方资料和镜像 manifest 的核验**，不是本项目运行测量。许可仅记录上游声明，分发须保留相应许可；不从协议兼容推导所有 S3 操作完全等价。

| 候选 | 许可/当前发行 | 双架构 | 预签名与兼容 | 2 CPU / 4 GB 判断 |
|---|---|---|---|---|
| Garage | AGPLv3；v2.4.1（2026-09-08），官方二进制和 dxflrs/garage 镜像仍提供 | 官方 tag manifest 有 linux/amd64、linux/arm64 | 官方矩阵列出 SigV4、预签名、PUT/GET、path-style 与 bucket CORS；不能据此保证条件写入等全部安全门槛 | 官方定位轻量；单副本模式可用但官方不推荐无冗余生产。低负载可能可行，未测全栈峰值 |
| MinIO Community | AGPLv3；source-only，新官方预编译二进制/镜像已停止。2026-04-25 官方仓库归档，不再维护 | 源码可编译两架构；历史镜像不是当前受维护发行 | 有 SigV4/预签名实现；社区 CORS 使用全局配置而非 bucket API | 可单机，但模板承担构建/安全维护；没有全栈 4 GB 保证，不选作新 profile |
| SeaweedFS Community | Apache-2.0；4.48（2026-09-28），有社区 release 与官方 chrislusf/seaweedfs 镜像，独立于 Enterprise | 4.48 manifest 有 linux/amd64、linux/arm64 | 官方列出 SigV4、预签名 PUT/GET、bucket CORS；4.48 源码有条件头和写锁路径，仍需真实并发拒覆盖验证 | 单进程 mini 官方支持部分单机生产；对象索引/维护会消耗内存，低流量有条件可行，不能宣称整栈达标 |

官方证据：[Garage 发行](https://garagehq.deuxfleurs.fr/_releases.html)、[兼容矩阵](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)、[单机边界](https://garagehq.deuxfleurs.fr/documentation/quick-start/)、[镜像 manifest](https://hub.docker.com/v2/repositories/dxflrs/garage/tags/v2.4.1)；[MinIO README](https://github.com/minio/minio/blob/master/README.md)、[停止镜像分发的维护者说明](https://github.com/minio/minio/issues/21647)、[社区 CORS 边界](https://github.com/minio/minio/discussions/20841)；[SeaweedFS releases](https://github.com/seaweedfs/seaweedfs/releases)、[许可证/发行说明](https://github.com/seaweedfs/seaweedfs/blob/master/README.md)、[镜像 manifest](https://hub.docker.com/v2/repositories/chrislusf/seaweedfs/tags/4.48)、[S3 API](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)、[CORS](https://github.com/seaweedfs/seaweedfs/wiki/S3-CORS)、[条件写源码](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/s3api_object_handlers_put.go)。

**推荐只提供 SeaweedFS Community profile `object-storage`，默认仍为外部 S3。** 当前有双架构上游发行、宽松许可与官方单机生产定位，维护路径比已归档 MinIO 更适合本模板；Garage 作为备选记录，不增加第二个 profile。实施使用 4.48 与审阅的 manifest digest，核验值为 `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`，应用前重新核对双架构。上游引用/测试不承接 D 的应用镜像构建发布。

使用单机 `weed mini` 的最小存储配置，禁用非必需 WebDAV/Admin/Iceberg 等入口；配置认证后才允许服务开始接流量，不能沿用无凭据 Allow All。bootstrap 管理密钥与应用 bucket 范围密钥分离；bucket/CORS 初始化可幂等重跑但不赋予应用管理权限。上游 `_FILE` 未保证支持时，以受控非 root wrapper 读取挂载文件再交给子进程，不把值放 argv/日志。数据与元数据均落持久目录；显式非 root UID、可写目录属主在启动前准备，不能靠 root init 容器。health、restart、logging、安全选项与 A 一致；外部 profile 关闭时不要求此服务的 secret。

对象服务只接专用 object 内网；受控代理接该网而非 PG data 网，只有代理映射 80/443。配置独立 `S3_PUBLIC_DOMAIN` 和 SeaweedFS `-s3.externalUrl` 对齐签名 endpoint，保留 Host/原始路径/query，关闭包含签名 query 的访问日志。[官方 mini/代理配置](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini) 说明了反向代理签名需求。CORS 只允许 APP_URL origin 的 PUT/GET/HEAD、Content-Type/If-None-Match 和必要响应头；必须用浏览器验证 OPTIONS，不以 curl 代替。

**资源是待测门槛。** 不能在 A 的 3328 MiB 上机械加 512 MiB 然后声称 4 GB 满足。profile 初始预算拟为 PG 1024、Valkey 384、web 768、jobs 512、代理 128、存储 512 MiB（合计 3328 MiB）；CPU 沿用常驻 1.7 加存储 0.3，共 2 核。一次性 migrate 在应用前运行。web/jobs 降低上限只应用于 profile 的明确配置，不静默改变外部 S3 默认；保留约 768 MiB 的主机预算仍不证明可行。需在整体 2 CPU/4 GiB 边界测 idle、预期上传并发、未知长度转存、后台维护和重启的 RSS/working set/CPU/连接，无 OOM 且有余量，记录最大安全并发。无法通过则维持默认外部 S3，并报告自带 profile 资源验收未完成，不以换候选或放宽基线偷偷过关。备份/恢复仍归 D；单机 profile 不承诺 HA。

### 4. 可选 Node Sentry（O3）

`@sentry/node` 只在 Node composition 初始化，沿用 CF 的 DSN + staging/production/smoke 开启条件；缺 DSN 或 development 不初始化、不发网络请求。版本与既有 Sentry 依赖系列对齐锁定，不新增万能观测 package；通过现有 WebRuntime.observability / JobObserver 注入。Node ESM 初始化必须早于需要观测的模块，按 [官方 Node ESM 指南](https://docs.sentry.io/platforms/javascript/guides/node/install/esm/) 接入且保持构建期不初始化。

web 共享 captureServerError 和顶层 fetch catch 都接 observer，继续过滤 redirect/notFound/非服务端 AppError，避免同一错误两次上报。jobs 每批成员与 Cron 单元用 isolation scope 获取共享 log context，不对全局 scope 设置用户；主动 retry 的失败仍有采集点，捕获不改变业务错误传播/DLQ。未处理异常通过 SDK 受控捕获，保留原进程退出策略。

复用 sentryBeforeSend，关闭 PII、tracing、HTTP body/query、DB/AI/queue payload 与变量采集，按 Node 实际 SDK API 配置而非照抄 CloudflareOptions。只启用必要 integrations，去掉 breadcrumbs。对任意异常文本做最后的安全边界：移除外部 cause/消息中的敏感原文，保留安全机器码、异常类型与结构化 stack frames；新增 S3/SMTP 错误在源头转换。用带签名 URL/密码的 Error 和并发上下文测试 **实际发送 envelope**，不能把按字段名 redact 当成文本扫描保障；shared 若需最小改动由协调者独占并保留 CF 回归。

release 使用构建固化完整 SHA；区分 CF 的现有 dist `web/jobs` 与 Node 的 `web-node/jobs-node`，避免同 SHA 两目标路径混用。核验 Nitro server map，给 jobs esbuild 生成 hidden map；现有 CLI release→inject→upload 流程增加 Node `.output/server` 路径与对应 dist，token 仅在上传步骤取得，不进入应用 env/镜像/构建 ARG。不修改 staging 发布的目标与触发器，不实现 D 的发布流水线；C 交付可复用上传入口和本地/CI fixture，真实项目源码映射验收有凭据才勾选。客户端继续原流程移除公开 maps，Node server maps 同样不可经静态路由读出。

shutdown 接 A 现有 deadline，停止业务领取/排空后在剩余时间调用 SDK flush/close；失败只记安全摘要、不无限延长停机，见 [官方 SDK APIs](https://docs.sentry.io/platforms/javascript/guides/node/configuration/apis/)。未启用时此 hook 无副作用。

### 5. SMTP 接现有发送接口与队列（E1）

新增 `@saas/email/node` SMTP sender，使用 Nodemailer 通用 SMTP transport，只由 jobs Node 入口装配；共享 EmailSender、模板、Resend fetch 不改。相比直接在 consumer 内连接 SMTP，sender 保持现有错误分类/模板边界。需要的 transport factory 注入点由 coordinator 在现有 email consumer 做最小接线；CF 只支持原 log/resend，Node 选择 smtp 不能让 CF 构建 import Node 模块。

Node 配置增加 `EMAIL_TRANSPORT=smtp`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_TLS_MODE=implicit|starttls|none`（默认 starttls）、`SMTP_USER`、`SMTP_PASSWORD`；复用 EMAIL_FROM/EMAIL_REPLY_TO。user/password 同时配置或均缺（受控匿名中继）；password 支持 `_FILE`。隐式 TLS 通常 465，STARTTLS 通常 587，但端口允许配置；none 是显式受控内网/测试，不自动降级。验证证书、禁止 ignoreTLS/rejectUnauthorized:false 捷径，连接/greeting/socket 超时有界。初期不池化，由既有队列并发限制连接数；不引入发送器内部业务重试。[官方 transport](https://nodemailer.com/smtp) 定义 TLS/超时选项，[错误参考](https://nodemailer.com/errors) 定义 code/responseCode。

SMTP 接受后返回成功；先按 responseCode 分类，4xx（包括临时认证 454、临时 RCPT 拒绝）为 retryable，永久 5xx（包括认证拒绝535）为 non-retryable；认证状态依据 [RFC 4954 §6](https://www.rfc-editor.org/rfc/rfc4954.html#section-6)。没有 SMTP状态时，连接失败/超时可重试，本地非法配置/地址为不可重试；不能只因 Nodemailer code 是 EAUTH/EENVELOPE 就把携带4xx的错误判为永久。只输出固定安全码，不输出 response/message、收件人/正文或驱动 cause。debug/logger 关闭，邮件仅由现有渲染结果组成，不允许文件/URL 自动附件读取。服务不可达不作启动联通硬门槛，以保留已入队请求成功和后台重试；语法或所选通道必需配置缺失则启动拒绝，不回退 log/Resend。

队列仍首次+5重试、30秒指数退避封顶900秒；有效终态失败先 await DeadLetterSink，失败不可先 ack；无效消息按原确认。B inbox/DLQ 保留期和权限不变。稳定 idempotencyKey 继续用于 Resend，SMTP 使用稳定 Message-ID 便于追踪但不宣称服务器去重：DATA 被接受后本地未确认的窗口可能重复发送。同步 EmailMessage.idempotencyKey 的注释，明确去重取决于通道，接口形状不变。不得自动跨通道补发，不用 exactly-once 掩盖 SMTP 现实边界。

## Risks / Trade-offs

- [外部服务实测仅覆盖 R2] → 本次不证明第二家真实端点联通；通用 S3 配置和本地协议矩阵继续保留，换供应商时重新验收。
- [S3 兼容实现/SDK 版本差异] → 真实条件 PUT、HEAD、attachment、CORS、签名过期与两种寻址验收；拒绝削弱不覆盖保护。
- [自带存储占用 4 GB 余量] → profile 专门预算、整体 cgroup/主机测量；不把单服务低 RSS 当作全栈证明。
- [预签名经代理被改写] → 独立子域、原 Host/path/query 与 externalUrl，一条真实浏览器链路验证。
- [Node 自动观测泄漏异常文本或串空间] → 精简 integrations、隔离 scope、发送 envelope 和恶意异常 fixture 验证；新外部 adapter 只抛脱敏错误。
- [SMTP 接受后崩溃重复投递] → 稳定身份、保留至少一次与不确定窗口；不添加第二套发送重试。
- [共享入口/config/manifest 并发冲突] → 三组独占新增目录；共享文件 coordinator 串行整合，B 媒体入口由 B 独占。

## Migration Plan

1. 基于已合入 A/B 接口协调共享配置/入口所有权；先并行交付 S3、Node Sentry、SMTP 独立 adapter 与目标测试，再串行装配，CF 继续默认。
2. 在隔离本地 PG/缓存/S3/SMTP fixtures 验证文件和真实持久邮件链路；提案只定义这些验收，不启动实现。S2 使用固定上游镜像测试，不发布应用镜像。
3. 外部 S3 与 object-storage profile 分别验收签名/浏览器/资源；Sentry 无 DSN 与可控 transport 先验，真实 release/source map 在已授权凭据环境另验。服务采购、真实邮件发送和 D 的服务器发布不是本提案操作。
4. 把 storage/copier 与安全测试证据交给 B 5.3/5.4，再由 B 验证媒体工作流；C 不更新 B 勾选状态。
5. 回滚时停流量/领取后按 A 排空；回退适配器配置或关闭 profile，保留对象卷与 PG inbox，不删除 bucket/任务表。切换 endpoint 不自动复制既有对象，迁移数据需另行协调；不承诺旧版本能读取新 endpoint 的对象。

## Open Questions

- profile 的最终 CPU/内存、对象索引、partSize/最大安全并发及非 root 卷权限参数，按上述整体资源和协议门槛实测收敛；当前数值为起点，不是通过证据。
- 所选 Node Sentry/S3/Nodemailer 精确锁定版本与 Nitro map 文件路径，在真实目标构建/fixture 验证后记录；不会改变既定接口与功能范围。
- 真实 Sentry 项目源码映射按 2.5 证据签收；1.7 的 R2 受限凭据通过控制台安全落盘后验收。2026-10-16 用户已取消第二个外部 endpoint 的验收要求，不能以本地 fixture 代替真实 R2。
