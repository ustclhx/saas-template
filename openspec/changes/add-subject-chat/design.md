# Design

## Context

- 现状：`ai_conversation` 只有空间、用户、标题、模型；`POST /api/ai/chat`（`apps/web/src/features/ai/chat.ts`）每轮只读 user/assistant 历史，请求体是 `strictObject`，客户端只提交本轮用户消息。
- xuanxue 的 `chat-context*.ts`：结果页提交输入 → 服务端复算 → KV（30 分钟）→ 地址只放签名令牌 `{id, uid, kind, returnTo, exp}` → `createConversation` 验签后写一条 system 消息（parts 含文本与 `data-chat-context` 数据片段），`chat.ts` 读历史时带上 system 行。本设计把它抽象为「持久对象 provider + 临时上下文令牌」两条入口，共用同一写入路径。
- 约束：衍生项目通过 template-sync 三方合并采纳，优先新文件与注册表；Neon 成本基线（无定时任务、无轮询）；积分写入只经 `@saas/credits`；后台写入走 adminAction；日志经 `@saas/shared/log` 且不得含对话正文。

## Goals / Non-Goals

**Goals**：对象对话（鉴权、上下文只写一次、固定前缀）、临时上下文令牌、开场推荐与可选后续问题、消息评分与后台统计、删除覆盖、最小可用 UI 与稳定的展示组件接口。

**Non-Goals**：长对话摘要（R2.3，P2）；余额不足统一错误码与弹窗（`add-billing-coexistence`）；最终视觉（`add-ui-design-system` 8.6）；把对话请求体改成接受对象引用（见决策 3）。

## Decisions

### 1. 数据模型

- `ai_conversation` 增加 `subject_type text null`、`subject_id text null`，索引 `ai_conversation_workspace_subject_idx (workspace_id, subject_type, subject_id)`；check 约束两者同时为空或同时非空。`subject_id` 必须是不透明 ID（不得放邮箱、姓名等个人信息），删除随对话一起删除。
- 新表 `ai_message_feedback`：`id`、`workspace_id`、`message_id → ai_message`、`user_id → user`、`rating ('up'|'down')`、`comment text null`、`model_key text null`、`subject_type text null`、时间戳；唯一索引 `(message_id, user_id)` 保证每用户每消息一条；索引 `(workspace_id, id desc)` 与 `(created_at)`（后台按日期统计）。`model_key` 与 `subject_type` 是写入时的快照，统计不必联表，也不依赖消息仍存在。
- 选择新表而不是在 `ai_message` 上加列：评分是用户对消息的独立事实，修改/撤销不触碰带计费快照的消息行，后台统计也只扫小表。

### 2. 对象 provider 注册表

`apps/web/src/features/ai/subjects.ts`（纯模块，无服务端依赖）：

```ts
interface SubjectRequestContext { db: Database; workspaceId: string; userId: string; locale: string }
interface SubjectSystemContext { version: string; text?: string; data?: JsonValue } // 至少其一
interface ResolvedSubject {
  title?: string                 // 新对话默认标题
  defaultModelKey?: string       // 计费模型默认值（不可用时回落到第一个可用模型）
  suggestions?: readonly string[]// 已按 ctx.locale 给出的开场问题
  context(): Promise<SubjectSystemContext> // 只在新建对话时调用
}
interface ConversationSubjectProvider {
  label(locale: string): string  // 对话列表来源标签，不查库
  resolve?(ctx: SubjectRequestContext, subjectId: string): Promise<ResolvedSubject | null>
}
registerConversationSubject(type, provider) // type: /^[a-z][a-z0-9_-]{0,47}$/，重复注册抛错
```

- `resolve` 返回 null 即 404；未注册类型、无 `resolve` 的类型（只能经临时令牌使用）同样 404，三者响应一致。
- 衍生项目在 `apps/web/src/features/ai/subject-providers.ts` 注册（模板只放注释示例，创建后模板不再修改该文件，避免同步冲突），由 subject 相关 server function 模块导入。

### 3. 上下文只写一次，客户端只传引用

- 新建对象对话走独立 server function `startSubjectConversation`（输入 `strictObject`：`{ slug, subject: { type, id } }` 或 `{ slug, token }`），在同一事务内插入对话（带 subject 字段、标题、`modelKey` 默认值）与首条 system 消息。之后发送消息仍用现有 `POST /api/ai/chat`（带 `conversationId`），其请求体保持 `strictObject`、`message.role` 固定为 `user`，任何附加字段返回 400。
- 不把对象引用加进 `/api/ai/chat` 请求体：对话已经承载对象，聊天热路径只需改历史读取，衍生项目合并冲突最小。
- system 消息 parts：`[{ type: 'text', text }, { type: 'data-subject-context', data: { subjectType, version } }]`。text 以固定头 `[context type=<type> version=<version>]` 开头，随后是 provider 文本、结构化数据以 ```json 代码块附后。数据片段只存元数据，不重复正文。
- `chat.ts` 读历史时取第一条 system 行作为前缀，按 `maxInputTokens` 截断时只截 user/assistant 部分（预算扣除前缀）；前缀作为 `messages[0]`，带 `providerOptions.anthropic.cacheControl = ephemeral`，其他服务商忽略该选项、按前缀自动缓存。
- 兼容 xuanxue：既有 system 消息（`data-chat-context`）按同一规则读为前缀，无需数据迁移。

### 4. 临时上下文令牌

`apps/web/src/features/ai/subject-context.ts`：

- `issueSubjectContext({ cache, secret, now? }, { userId, workspaceId, subjectType, context, title?, suggestions?, returnTo })`：类型必须已注册（本模块副作用导入 `subject-providers.ts`，冷启动只调用签发入口也能就绪）；上下文 system 文本总长度 ≤ 20 万字符；`returnTo` 必须是站内路径（以单个 `/` 开头、无 `\\`、无协议、≤ 512）；生成随机 `id`，KV 键 `subject-context:<id>` 存 `{ subjectType, context, title, suggestions }`，TTL 30 分钟；令牌 `base64url(payload).base64url(HMAC-SHA256)`，payload `{ v: 1, id, uid, ws, type, returnTo, exp }`，密钥由 `BETTER_AUTH_SECRET` 加用途前缀派生，不含正文。
- `openSubjectContext` 返回 `ok | expired(returnTo) | invalid`：签名或格式错、`uid` 或 `ws` 不符、returnTo 复验不通过一律 invalid（不回显 returnTo）；过期或 KV 已失效为 expired。
- 临时对话的 `subject_type` 为签发类型、`subject_id` 为随机 `id`；令牌有效期内再次打开同一令牌进入已有对话，过期后已有对话仍可在对话列表中继续（上下文已写入）。
- KV 经 `WebRuntime.cache`（`@saas/platform` 的 `KeyValueStore`），不直接使用 Cloudflare 绑定。

### 5. 推荐追问

- 开场问题：`ResolvedSubject.suggestions` 或临时上下文中保存的 `suggestions`；只在对话无消息时显示。
- 后续问题：`templateConfig.ai.text.followUps = { enabled: false, charge: false, count: 3, modelKey: null }`。server function `getFollowUps({ slug, messageId })`：校验消息归属与已完成状态 → 读 KV 缓存 `chat-follow-ups:<messageId>`（1 天）→ 限流 `ai` → 用回复所用模型（或 `modelKey` 指定的可用模型）以 `generateText` 生成 JSON 数组，`maxOutputTokens` 256，输入为 system 前缀 + 最近一轮问答（截断）。
- `charge: true` 时只对按 token 计价的模型生成（按次计价直接跳过）；先检查同一回复是否已有在途预扣（有则不生成），再 `hold`（`refType: 'ai_message'`、`refId` 为被追问的助手消息 ID、2 分钟过期），生成后 `capture` 实际用量，生成失败 `release`；KV 写入在结算之后、失败只记日志。进程中断时 `chatHoldSweeper` 找不到以该预扣为 `hold_id` 的消息，走释放分支，不会多扣；删号清理会等在途预扣结算后再删该消息。`charge: false` 时由平台承担，不写积分。
- 推荐问题从不写入 `ai_message`；点击后作为普通用户消息经 `/api/ai/chat` 发送。

### 6. 消息评分

- `setMessageFeedback({ slug, messageId, rating: 'up' | 'down' | null, comment? })`：消息必须是自己对话中的 assistant 消息且不在 streaming；`null` 删除记录（撤销）；否则 `insert ... on conflict (message_id, user_id) do update`。评论 ≤ 1000 字，入库前 `scrubSecrets` 替换 `sk-…`、`Bearer …`、`AKIA…`、JWT、≥ 32 位的十六进制/base64 串为 `[REDACTED]`。
- 只读团队空间（`WORKSPACE_READ_ONLY`）同其他写操作一样拒绝。
- `getConversation` 与对象对话数据一并返回 `feedback: Record<messageId, { rating, comment, reason }>`。
- 点踩原因（2026-11-11 使用者决定保存，评审清单 #81）：
  - 取值集合固定为 `inaccurate`、`incomplete`、`no_source`、`too_long`，对应已确认画板 `Chat.dc.html` 的「不准确 / 不完整 / 没引用原文 / 太长」；单选、可不选。值用 snake_case，与库中其他枚举文本一致；`/dev/ui` 的示例值不受影响。
  - 存储：`ai_message_feedback.reason text null`（迁移 0023），不另建表——每条评分至多一个原因，后台按原因筛选只扫本表。
  - 校验分两层：数据库 check 约束 `ai_message_feedback_reason_valid`（`reason is null or (rating = 'down' and reason in (…))`）保证取值合法且点赞时为空；server function 的 zod 只接受约定取值，`saveMessageFeedback` 对点赞或撤销时携带原因返回 `AppError('INVALID_REQUEST', 400)`，不静默丢弃。每次保存都整体写入 `reason`，因此改为点赞或点踩时不选原因都会清空旧值；撤销删除整条记录。
  - 取值在 `@saas/db` 的 `AI_FEEDBACK_REASONS` 与浏览器可用的 `features/ai/feedback.ts` 的 `FEEDBACK_REASONS` 各有一份（前者用于约束与后台筛选，后者避免浏览器包引入 db），单元测试比对两者；增删取值需要新迁移修改约束。
  - 对话页经 `chat-extras.tsx` 向 `MessageFeedback` 传入 `reasons`（文案在 `ai-subject-chat.json`），后台列表显示原因列并以 DataTable 的 select 筛选 `reason`（非法值按未筛选处理）。

### 7. 后台

- `/admin/feedback`：DataTable 列表（筛选 `rating`、`reason`、`model`、`subjectType`、`from`、`to`，每页 50），列：时间、空间、模型、对象类型、评分、点踩原因、反馈文字、消息 ID；不显示对话正文（需使用者审阅：是否展示被评回复的正文）。
- 统计：同一日期范围内按 `model_key`、`coalesce(subject_type, '')` 分组的 up/down 数与满意率，默认最近 30 天。
- 删除：`adminAction('ai.feedback.delete')`，审计 `targetType: 'ai_message_feedback'`、`meta: { modelKey, subjectType, rating }`，不含反馈文字。
- 导航放在 AI 分组，随 `billing.enabled` 显示（与模型管理一致）。

### 8. 删除与日志

- `purgeAiBatch`：先选出本批要删的消息 ID，再删这些消息的评分，最后删消息；对话删除条件不变。删号/删空间入口不变。
- 结构化日志事件 `ai.subject_conversation.created { subjectType, version, temporary }`、`ai.subject_context.issued { subjectType }`；不记录 text/data/returnTo 之外的正文。本变更不新增 audit_log 写入（后台删除除外）。

### 9. 前端最小接线与展示组件接口

最小版本放在 `apps/web/src/features/ai/subject-chat.tsx`，复用 `ChatPage`（新增可选属性：`variant`、`openingSuggestions`、`defaultModelKey`、`initialFeedback`、`autoSend`）。`add-ui-design-system` 8.6 的展示组件按以下接口替换实现，数据获取与回调不变：

```ts
// 推荐追问按钮组
interface SuggestionChipsProps {
  suggestions: readonly string[]          // 已本地化
  disabled?: boolean                      // 生成中、只读空间
  onSelect(text: string): void            // 立即作为用户消息发送
  label?: string                          // 无障碍分组名
}

// 消息评分与反馈
type FeedbackRating = 'up' | 'down'
type FeedbackReason = 'inaccurate' | 'incomplete' | 'no_source' | 'too_long'
interface MessageFeedbackValue { rating: FeedbackRating; comment: string | null; reason: FeedbackReason | null } // reason 只在点踩时有值
interface MessageFeedbackProps {
  messageId: string
  value: MessageFeedbackValue | null      // null = 未评分
  disabled?: boolean
  onChange(next: MessageFeedbackValue | null): Promise<void> // null = 撤销；失败时 reject，组件回滚
}

// 嵌入式对象对话
interface SubjectChatProps {
  slug: string
  subjectType: string
  subjectId: string
  className?: string
}
// 外壳内部的视图数据（getSubjectChat / getTemporarySubjectChat 的返回）
interface SubjectChatData {
  subject: { type: string; label: string; title: string | null; suggestions: readonly string[]; defaultModelKey: string | null }
  conversation: { id: string; title: string } | null
  conversations: readonly { id: string; title: string; updatedAt: Date }[]
  messages: readonly StoredMessage[]
  feedback: Readonly<Record<string, MessageFeedbackValue>>
  readOnly: boolean
}
```

## Risks / Trade-offs

- [provider 实现错误导致越权] → 注册表只接受 `resolve` 返回值，未返回对象即 404；文档与示例强调必须同时校验 `workspaceId` 与 `userId`；集成测试覆盖他人对象。
- [临时上下文 KV 最终一致] → 刚写入就读取可能短暂缺失，按 expired 处理并提示返回原页；30 分钟有效期内重试即可。
- [后续问题增加成本] → 默认关闭；开启后每条回复最多调用一次（KV 缓存）且受 `ai` 限流；计费开关独立。
- [system 前缀让每轮输入变长] → 上下文由 provider 控制长度；截断时保留前缀，输入仍超限则返回现有 `INPUT_TOO_LONG`。

## Migration Plan

- 协调者在 main 上 `drizzle-kit generate` 生成迁移（两列 + 索引 + check、新表）。纯新增，旧代码可在新 schema 上运行，回滚只需回退代码。
- 点踩原因：迁移 0023 为 `ai_message_feedback` 加可空列 `reason` 与 check 约束，不改数据；旧代码不读写该列，回滚只需回退代码。
- 衍生项目迁移路径见本目录 `upgrade-notes.md`。

## Open Questions

- 后台反馈是否展示被评回复的正文（隐私 vs 提示词迭代效率），当前不展示。
- 后续问题计费时是否在 UI 上展示预计消耗，当前不展示（默认关闭）。
