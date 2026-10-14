# Proposal

## Why

核心功能完成后，模板还缺少上线运营所需的可观测性（错误追踪、结构化日志、流量统计），以及一批按站点需要开关的可选功能（站内通知中心、公开 API、Waitlist、Newsletter）。另外，模板的价值在于能被快速复制成新项目，需要一份「从模板创建新项目」的脚本与给 AI 编码助手的约定文档（`docs/08-roadmap.md` Phase 7）。

## What Changes

- 可观测性：Sentry（web + jobs，带 release 与 source map）、带 requestId / workspaceId / userId 的结构化日志、Cloudflare Web Analytics；可选的产品分析接入点。
- 站内通知中心（未读数、标记已读）与内部运营通知（新订单、退款申请、关键告警推送到 Telegram / Discord）。
- 公开 API（`features.publicApi`）：API Key 管理、OpenAI 兼容的对话接口子集、媒体任务接口；计费、权益、限流与站内一致。
- Waitlist（`features.waitlist`）与 Newsletter（订阅、确认、退订）。
- 根目录 `CLAUDE.md` / `AGENTS.md`：模块说明、约定、常用命令。
- 「从模板创建新项目」脚本：改名、生成配置、列出需要创建的基础设施与密钥清单。
- 决定待决事项 Q3（产品分析）。

## Capabilities

### New Capabilities
- `observability`: 错误、日志与流量数据的采集范围与隐私约束。
- `notifications`: 站内通知中心与面向运营者的内部通知。
- `public-api`: 以 API Key 访问 AI 能力的公开接口。
- `waitlist`: 上线前的等候名单收集。
- `newsletter`: 邮件订阅、双重确认与退订。
- `project-bootstrap`: 从模板生成新项目的脚本行为。

### Modified Capabilities
（无。公开 API 复用 `ai-chat` 与 `ai-media-tasks` 的计费与权益规则，不改变其要求。）

## Impact

- 依赖前面所有 change；公开 API 依赖 `add-ai-text-chat` 与 `add-ai-media-generation`。
- 新增外部服务：Sentry、Telegram / Discord Webhook（可选）、产品分析服务（可选）。
- 新增表：`waitlist`（已在数据模型中）、`newsletter_subscriber`。
- 新增根目录文件 `CLAUDE.md`、`AGENTS.md` 与 `scripts/create-project`。
