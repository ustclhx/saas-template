# Proposal

## Why

Node 自托管目标已有基础运行时和 DBOS 任务引擎，但文件能力仍不可用，错误监控仅输出日志，邮件只支持 Resend。补齐这些适配器可以复用现有业务流程，并为 B 5.3/5.4 的媒体工作流移植提供存储前置能力。

## What Changes

- **S1**：默认连接外部 S3 兼容服务，endpoint、region、bucket、path-style 可配置；采用通用 S3 SDK，预签名 URL 不固定域名。R2 经 S3 API 属于有效外部 S3。
- 在现有 `packages/storage` 中立 `Storage` / `MediaOutputCopier` 接口后新增 Node 适配器，装配 web 文件能力和 jobs 文件清理，解除已配置 Node 文件能力的 unavailable 限制；保留租户授权、配额、短期签名、安全转存与失败清理。
- **S2**：Compose 增加默认关闭的自带对象存储 profile。design 比较 Garage、MinIO、SeaweedFS 的许可、当前发行方式、双架构、S3 兼容及 2 核 4 GB 预算，并给出推荐与验证门槛。
- **O3**：web/jobs 按目标装配可选 `@sentry/node`，沿用脱敏、上下文、release 和 source map 流程；未启用时保持共享日志。
- **E1**：Node 邮件可选择 Resend 或通用 SMTP，保留现有模板与持久 EMAIL_QUEUE、错误分类、重试和有效失败先死信再确认的语义。现有开发用 log 通道保留。
- tasks 分为存储、Sentry Node、SMTP 三条可并行工作线，共享配置/入口/依赖由协调者串行整合。所有实施任务保持未勾选。

### Scope and dependencies

本 change 只覆盖 S1、S2、O3、E1；继承 A 的 R3/R4 配置校验和文件密钥、H4 入口隔离与非 root、P6 Cloudflare 主目标兼容约束，以及 B 的 Q1 邮件重试/死信契约，不重复承接其验收。

依赖已合入的 `add-selfhost-foundation` 与 `add-selfhost-job-engine` 接口和入口。C 的存储交付是 **B 5.3/5.4 的前置依赖**，C 不移植/启用 Node 媒体 Workflow，不勾选 B 任务；媒体提交仍需工作流能力和存储同时可用。

非目标：应用镜像构建/发布、服务器部署、Dokploy、备份恢复、create-project（均归 D），以及新增监控平台或邮件服务器。S2 的可选 Compose 服务及最小配置属于本 change，但其上游镜像引用验证不等于 D 的镜像发布或 ECS 验收。

## Capabilities

### New Capabilities

- `file-storage`：增加 Node 通用 S3、自带对象存储可选 profile 与安全转存要求；沿用未归档 `add-ai-media-generation` 的同名 capability，不另建重复领域。
- `observability`：增加 Node 可选错误上报、隔离上下文与同版本源码映射要求；沿用未归档 `add-observability-and-optional-features` 的同名 capability。
- `email-delivery`：定义部署级 Resend/SMTP 选择、发送结果分类和持久队列兼容。

`file-storage` / `observability` 尚未同步到主 specs，本 change 仅添加名称不重复的要求；由协调者按已有 delta 的顺序同步，不复制或覆盖既有上传/权限/脱敏条款。

### Modified Capabilities

无。现有 `user-auth` 异步邮件要求继续适用；A 的 runtime-config delta 定义的启动校验与 `_FILE` 规则继续适用，不在 C 重写。

## Impact

实施涉及 packages/storage、email、config，web/jobs Node composition 和观测边界、文件能力装配、相关目标测试及 source map 上传脚本，和 deploy/selfhost 的 S2 profile/配置示例。预计新增 Node 专用 S3 SDK、SMTP 与 Sentry 依赖；中立/Cloudflare bundle 不加载 Node 适配器。

本提案 PR 只包含 `openspec/changes/add-selfhost-storage-observability/`，没有代码、部署、凭据或迁移变更。外部服务联通和自带存储资源预算必须在实施阶段取得证据，不能由提案校验替代。
