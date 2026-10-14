# Design

## Context

可观测性方案见 `docs/07-infrastructure.md` §7，公开 API 见 `docs/06-ai.md` §6；动机见 proposal.md。前面的 change 已经写入 `notification` 表（媒体任务完成通知）、提供 `EVENTS_QUEUE` 与 Better Auth `apiKey` 插件的接入点；本 change 补齐用户界面、外部推送与公开接口。

## Goals / Non-Goals

**Goals:**
- 所有可选功能都由 `template.config.ts` 的开关控制，关闭时不暴露路由也不加载代码路径。
- 公开 API 直接复用站内的对话与任务服务层，不复制计费逻辑。

**Non-Goals:**
- 自建日志检索平台或长期日志存储（使用 Workers Logs 与 Sentry 的保留期）。
- Newsletter 的编辑器与群发排期：首版只做订阅管理，群发通过 Resend 后台完成。
- 公开 API 的完整 OpenAI 兼容（只做 Chat Completions 子集，不做 embeddings、assistants 等）。

## Decisions

1. **产品分析（Q3）**：默认不接入；提供可选的 PostHog 接入点（`features.analytics: 'posthog' | false`），开启时才加载脚本并只在用户同意后启用。Umami 等可按同一接入点扩展。理由：默认零 Cookie 的 Web Analytics 足以满足基本流量统计，避免模板默认引入需要同意弹窗的追踪。
2. **请求 ID 贯穿**：入口生成 UUIDv7 请求 ID，写入日志上下文、Sentry 标签，并作为队列消息与 Workflow 参数的一部分传递。
3. **脱敏**：统一的日志与 Sentry `beforeSend` 过滤器，按字段名（`authorization`、`cookie`、`password`、`token`、`secret`、`parts`、`messages` 等）移除。
4. **内部通知**：`EVENTS_QUEUE` 消费者把指定事件格式化后发到 Telegram Bot API 或 Discord Webhook（`setting` 表配置渠道），失败由队列重试，最终失败只记日志。
5. **公开 API**：Better Auth `apiKey` 插件，Key 的 metadata 记录 workspaceId；`/api/v1` 中间件把 Key 解析为与站内相同的 `{ workspace, member }` 上下文（member 取创建者），然后调用与站内同一个对话 / 任务服务函数。流式响应转换为 OpenAI SSE 格式。
6. **Newsletter 存储**：新增 `newsletter_subscriber`（email、status、confirm_token、confirmed_at、unsubscribed_at）；确认与退订链接使用签名令牌；可选同步到 Resend Audiences。
7. **创建脚本**：Node 脚本（`scripts/create-project`），交互式输入后复制工作树（排除 `.git`、`openspec/changes/`、`node_modules`，以及根目录与各子目录的 `.env.local`、`.env.worktree`、`.dev.vars` 真值文件），替换占位符，生成配置、根目录 `.env.example` 与 app 认证用 `.dev.vars.example`；配置模板只含键名、占位符或非敏感默认值，不从本地真值文件生成。最后运行 typecheck 与单元测试自检。

## Risks / Trade-offs

- [OpenAI 兼容格式的细节差异导致第三方 SDK 解析失败] → 用 OpenAI 官方 Node 与 Python SDK 各写一个集成测试。
- [Sentry SDK 增加 Worker 包体积] → 只在服务端使用 `@sentry/cloudflare`，前端按需懒加载。

## Migration Plan

新增 `newsletter_subscriber` 表；其余为新路由与配置，无数据迁移。

## Open Questions

（无）
