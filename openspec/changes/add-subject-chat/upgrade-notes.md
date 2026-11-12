---
version: <由协调者发版时确定>
previous: <上一模板版本>
date: YYYY-MM-DD
breaking: false
---

<!-- add-subject-chat 升级说明草稿：发版时由协调者移到 docs/upgrades/<version>.md，补齐版本号、日期与迁移 tag。 -->

## 概要

对话可以绑定业务对象（报告、任务等），由项目注册的 provider 鉴权并构建上下文，上下文在建对话时写成首条 system 消息并作为每轮的固定前缀；没有持久对象时可用临时上下文令牌（KV + 签名令牌）。新增开场与回复后的推荐追问（后续问题默认关闭）、助手回复的点赞/点踩与文字反馈，以及后台反馈列表与满意率统计。

## 必须执行的动作

无（新能力默认不启用；未注册任何对象类型时行为与此前一致）。

## 配置变更

- `template.config.ts` 可选新增 `ai.text.followUps: { enabled, charge, count, modelKey }`，默认 `{ enabled: false, charge: false, count: 3, modelKey: null }`，不写即为默认值。
- 新增项目自有文件 `apps/web/src/features/ai/subject-providers.ts`（模板只放注释示例，此后模板不再修改它）。
- 新增文案文件 `apps/web/messages/<locale>/ai-subject-chat.json`；项目新增语言时补齐翻译。

## 数据库变更

### <迁移 tag，由协调者生成>

- 类别：扩展
- 兼容上一版本代码：是
- 锁表与耗时：`ai_conversation` 新增两个可空列（无默认值，元数据变更）、一个 check 约束与一个索引（`create index` 期间短暂阻塞写入，表大时按需改为 `concurrently` 手工执行）；新建空表 `ai_message_feedback`。
- 回滚：回退代码即可；新增列与表对旧代码无影响。

### 0023_feedback_reason

- 类别：扩展
- 兼容上一版本代码：是
- 锁表与耗时：`ai_message_feedback` 新增可空列 `reason`（无默认值，元数据变更）与 check 约束 `ai_message_feedback_reason_valid`（未带 NOT VALID，持 ACCESS EXCLUSIVE 扫描一次全表；新列全为 NULL、表通常很小，校验瞬时完成）。迁移设置 `lock_timeout=5s`、`statement_timeout=30s`，拿不到锁时失败，可重试
- 数据迁移：无，已有评分的原因为空
- 回滚：只回退代码，保留新列与约束；旧代码不读写 `reason`，新代码写入的原因保留
- apps/web 的 `MessageFeedbackValue` 新增必填字段 `reason`（`FeedbackReason | null`），自行构造该值的项目补 `reason: null`；增删点踩原因取值需同时修改 db 包（模板为 `@saas/db`）的 `AI_FEEDBACK_REASONS` 与 `apps/web/src/features/ai/feedback.ts` 的 `FEEDBACK_REASONS`，并新增迁移修改 check 约束 `ai_message_feedback_reason_valid`

### 0024_feedback_share

- 类别：扩展
- 兼容上一版本代码：是
- 锁表与耗时：`ai_message_feedback` 新增 `share_conversation boolean not null default false`（常量默认值，元数据变更）、可空列 `shared_at timestamptz` 与 check 约束 `ai_message_feedback_shared_at_consistent`（未带 NOT VALID，扫描一次全表；已有行恒为 false 与 NULL、表通常很小，校验瞬时完成）。迁移设置 `lock_timeout=5s`、`statement_timeout=30s`，拿不到锁时失败，可重试
- 数据迁移：无，已有反馈一律视为未同意
- 回滚：只回退代码，保留新列与约束；旧代码不读写这两列，插入时取默认值仍满足约束；回退期间旧 upsert 不会清除已有的 `share_conversation`
- apps/web 的 `MessageFeedbackValue` 新增可选字段 `shareConversation`（缺省视为 false）；`@saas/ui` 的 `MessageFeedback` 新增可选 `shareLabels`，不传时不显示勾选项
- 隐私说明：项目上线前应在隐私政策中说明这项共享（被评回复与之前最多 3 条消息、不含对象上下文、仅平台管理员可见且每次查看有审计、逐条同意可撤回、随对话删除）

## 部署顺序

先执行迁移，再部署 web 与 jobs（jobs 的 AI 内容清理会删除 `ai_message_feedback`，需与新表同时上线；旧 jobs 在新表有数据前不受影响）。

## 验证

1. 在 `subject-providers.ts` 注册一个测试类型，在 App 页面嵌入 `<SubjectChat slug subjectType subjectId />`，提问后确认回答引用了对象上下文；用另一个账号打开同一对象返回不可用（404）。
2. 对话列表中该对话显示来源标签；对回复点赞、改为点踩并填写反馈、撤销，后台 `/admin/feedback` 中统计随之变化。
3. 临时上下文：服务端签发令牌后打开 `/app/<slug>/chat/context?token=…` 可开始对话；修改令牌任意字符显示无效；超过 30 分钟显示返回原页。

## 回滚

回退代码；保留新增列与表即可，不需要回退数据库结构。

## 已知问题

- 长对话摘要（R2.3）尚未实现，历史超过输入上限时仍按原规则截断（上下文前缀保留）。
- 余额不足沿用现有 `INSUFFICIENT_CREDITS` 错误码与提示；统一弹窗由 add-billing-coexistence 提供后自动适用于嵌入式对话。

---

## 衍生项目：从自建 chat-context 迁移（例如 xuanxue）

自建实现（`apps/web/src/features/ai/chat-context*.ts`：结果页复算 → KV → 签名令牌 `{id, uid, kind, returnTo, exp}` → `createConversation` 写 system 消息 → `chat.ts` 读 system 行）与模板机制一一对应：

| 自建 | 模板 |
|---|---|
| `issueChatContext(deps, { userId, context, returnTo })` | `issueSubjectContext({ secret, cache }, { userId, workspaceId, subjectType: kind, context: { version, data: result }, returnTo, suggestions?, title? })` |
| `openChatContext` | `openSubjectContext`（同样返回 ok / expired(returnTo) / invalid） |
| `/app/<slug>/chat?context=<token>` | `/app/<slug>/chat/context?token=<token>` |
| `contextSystemText(context)` 的提示文本 | provider 的 `context().text`（模板会在前面加固定头 `[context type=… version=…]`） |
| `data-chat-context` 数据片段 | `data-subject-context`（只存类型与版本，不重复正文） |
| `createConversation({ context })` | `startTemporarySubjectConversation({ slug, token })` 或 `startSubjectConversation({ slug, subject })` |
| `chat.ts` 读 system 行 | 模板 `chat.ts` 已内置（首条 system 消息作为固定前缀） |

迁移步骤：

1. template-sync 采纳本版本后，三方合并 `chat.ts`：保留模板的「首条 system 消息作为前缀」实现，删除自建的 system 行读取改动（两者对已有数据等价：已有对话的 system 消息仍按首条 system 读取，无需数据迁移）。
2. 在 `subject-providers.ts` 注册结果类型（每个 kind 一个，或一个类型 + `data.kind`），只需 `label`：`registerConversationSubject('reading', { label: (l) => … })`。报告类持久对象另外实现 `resolve`（校验 `workspaceId` 与 `userId`），在报告页嵌入 `<SubjectChat subjectType="reading" subjectId={report.id} />`，按语言返回开场推荐问题。
3. 把 `createChatContextLink` 中的 `issueChatContext` 换成 `issueSubjectContext`，返回地址改为 `/app/<slug>/chat/context?token=…`；保留复算与 `safeReturnPath` 校验（模板也会拒绝站外地址）。
4. 删除 `chat-context.ts`、`chat-context.functions.ts`、`chat-context-start.tsx` 与 `createConversation` 的 `context` 参数；旧链接（`?context=`）在 30 分钟后自然失效，如需平滑过渡，可在对话列表页把 `?context=` 重定向到新路由（旧令牌签名用途不同，新路由会判为无效，提示用户回原页重开）。
5. 已有对话不需要改动：它们没有 `subject_type`，列表不显示来源标签；需要时可按 system 消息中的 `data-chat-context` 片段回填 `subject_type`（可选，脚本自行编写）。
