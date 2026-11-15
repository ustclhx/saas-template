# Proposal

## Why

衍生项目需要「报告内追问」和「从结果页带上下文进入聊天」：对话要能挂在一个业务对象上，由服务端按对象组装 system 上下文；回复后给出可点的推荐问题，并收集用户对回复的评价用于迭代提示词。模板的 `ai_conversation` 没有对象字段，衍生项目（xuanxue）只能自建 `chat-context*`（KV + 签名令牌 + 建对话时写 system 消息），无法复用到其他领域。需求来源：xuanxue 基础需求 R1、R2（`~/.claude/codex-specs/saas-template/2026-11-10-foundation-from-xuanxue.md`）。

## What Changes

- `ai_conversation` 新增可空 `subject_type`、`subject_id` 与索引 `(workspace_id, subject_type, subject_id)`；同一用户、同一对象可有多个对话，默认打开最近一个。
- 新增对话对象注册表 `registerConversationSubject(type, provider)`：provider 负责鉴权（不属于当前空间与用户时统一 404）、构建带版本号的 system 上下文，并可选提供开场推荐问题、对话标题、默认计费模型和列表来源标签。
- 新增临时上下文：服务端把上下文存进 KV（随机键、有效期），签发绑定用户、带过期时间与 returnTo 的签名令牌，令牌不携带正文；过期返回原页引导，篡改或他人令牌被拒绝。KV 经 `@saas/platform` 的中立 `KeyValueStore` 访问。
- 上下文只在建对话时写入一次，成为首条 system 消息，且每轮都排在提示词最前（固定前缀，便于 prompt caching，按模型输入上限截断时保留）；客户端只能传对象引用或令牌，不能传上下文正文。
- 推荐追问：provider 的开场问题按语言给出；每轮回复后可选生成 2–3 个后续问题（`template.config.ts` 的 `ai.text.followUps`，默认关闭，是否计费由配置决定）；推荐问题不写进历史。
- 消息评分：assistant 消息支持点赞/点踩与可选文字反馈，每用户每消息一条，可修改、可撤销；文字反馈入库前去除疑似密钥。
- 后台：反馈列表（DataTable，按评分、模型、对象类型、日期筛选）与按模型、对象类型的满意率统计；管理员可删除含敏感内容的反馈（adminAction，审计不含反馈正文）。
- 删号与删空间的 AI 内容清理覆盖评分记录与新字段；结构化日志与审计不记录上下文正文。
- 前端最小接线：嵌入式 `SubjectChat`、推荐按钮、评分按钮用现有 `@saas/ui` 组件实现可用版本；对话列表显示来源标签；临时上下文入口页。最终视觉由 `add-ui-design-system` 8.6 替换，本变更在 design.md 列出数据与回调接口。
- 升级说明草稿（衍生项目从自建 chat-context 迁移）放在本 change 目录，版本号由协调者发版时确定。
- 不在本变更：R2.3 长对话摘要（P2）；余额不足的统一错误码与弹窗（由 `add-billing-coexistence` 定义，本变更沿用现有 `INSUFFICIENT_CREDITS`）；最终视觉组件。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ai-chat`：新增对话绑定对象、对象上下文提供者、临时上下文令牌、上下文只写一次、推荐追问与消息评分。
- `admin-console`：新增 AI 回复反馈列表、满意率统计与反馈删除。
- `account-deletion`：删号与删空间的清理覆盖消息评分与对话对象字段。

## Impact

- 数据库：`ai_conversation` 加两列与一个索引；新表 `ai_message_feedback`。按并行计划用 `drizzle-kit push` 同步 worktree 库，迁移由协调者在 main 生成。
- 配置：`packages/config` 的 `TextConfig` 新增 `followUps`（默认关闭），衍生项目无需改动。
- 代码：`apps/web/src/features/ai`（新文件为主，`chat.ts` 只改历史读取与 system 前缀）、`apps/web/src/routes`（临时上下文页、后台反馈页）、`packages/auth/src/ai-content-cleanup.ts`、文案新增 `ai-subject-chat.json`。
- 衍生项目：可删除自建 `chat-context*`，改为注册 provider 或调用临时上下文 API；已有 system 消息形态兼容（见升级说明草稿）。
