# Tasks

## 1. 数据与配置

- [ ] 1.1 `packages/db/src/schema/ai.ts`：`ai_conversation` 增加 `subject_type`、`subject_id`、索引与成对 check；新增 `ai_message_feedback`（唯一 `(message_id, user_id)`）；`drizzle-kit push` 同步 worktree 库（不提交迁移）
- [ ] 1.2 `packages/config` 的 `TextConfig` 新增 `followUps`（`enabled` 默认 false、`charge` 默认 false、`count` 2–3、`modelKey` 默认 null）；配置单元测试覆盖默认值与越界

## 2. 对象对话后端

- [ ] 2.1 `subjects.ts` 注册表（类型校验、重复注册报错、`label` 回落）与 `subject-providers.ts` 项目注册入口；单元测试
- [ ] 2.2 `subject-context.ts`：system 消息 parts 构建（固定头 + 版本 + 文本/JSON）、临时上下文签发与打开（KV 随机键、HMAC 令牌、用户绑定、过期、站内 returnTo）；单元测试覆盖篡改、他人、过期、KV 缺失、站外 returnTo
- [ ] 2.3 `subject-chat.server.ts` 与 `subject-chat.functions.ts`：`getSubjectChat`、`startSubjectConversation`、`getTemporarySubjectChat`；越权/未注册/无 resolve 一律 404，事务内写对话与首条 system 消息，日志只含类型与版本
- [ ] 2.4 `chat.ts`：历史读取带首条 system 前缀、截断时保留、前缀带缓存提示；集成测试验证模型收到的首条消息是上下文、注入字段被 400 拒绝
- [ ] 2.5 对话列表与对话页返回来源标签与评分

## 3. 推荐追问与评分

- [ ] 3.1 `follow-ups.ts`：配置关闭返回空、KV 缓存复用、限流、可选计费（hold/capture/release）；集成测试覆盖关闭、缓存与计费
- [ ] 3.2 `feedback.ts`：设置/修改/撤销评分、他人消息 404、streaming 消息拒绝、`scrubSecrets`；集成测试与单元测试

## 4. 后台

- [ ] 4.1 `/admin/feedback`：DataTable 列表与筛选、按模型与对象类型的满意率统计、adminAction 删除（审计不含反馈文字）、导航项；集成测试覆盖列表、统计与删除审计

## 5. 删除覆盖

- [ ] 5.1 `purgeAiBatch` 先删评分再删消息；`packages/auth` 集成测试覆盖带评分的对象对话被删空间与删号清理

## 6. 前端最小接线

- [ ] 6.1 `ChatPage` 增加可选属性（变体、开场推荐、默认模型、初始评分、自动发送）；`subject-chat.tsx` 中 `SubjectChat`、`SuggestionChips`、`MessageFeedback` 最小实现；对话列表来源标签；临时上下文页 `/app/$slug/chat/context?token=`（过期引导与无效提示）；文案 `ai-subject-chat.json`（en/zh）；组件单元测试

## 7. 文档与升级说明

- [ ] 7.1 `docs/06-ai.md` 增加对象对话、临时上下文、推荐追问与评分小节；本 change 目录写 `upgrade-notes.md` 草稿（衍生项目自建 chat-context 迁移路径），版本号由协调者确定

## 8. 未做与外部验收

- [ ] 8.1 （P2，本次不做）长对话摘要 R2.3
- [ ] 8.2 staging 真实模型验收：嵌入式对话基于对象上下文回答、开启后续问题时的计费结算（需 staging AI 服务商凭据）
