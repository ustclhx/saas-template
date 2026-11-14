# Proposal

## Why

对话界面目前是手写的：对话页 `apps/web/src/features/ai/chat-page.tsx` 的消息气泡用 `<li>`、原生 `<details>` 显示推理、`whitespace-pre-wrap` 显示纯文本（没有 Markdown），输入区是原生 `<textarea>`，状态文字（"Stopped"、"Incomplete"、"Retrying…" 等）写死英文；嵌入式 `SubjectChat` 另搭一套布局，`@saas/ui` 的 `EmbeddedChat` 只在 `/dev/ui` 中使用。衍生项目的回复里大量是带列表、表格与代码的 Markdown，现状既不可读，也与视觉规范不一致。需求来源：xuanxue 基础需求 R5.5（聊天组件：R2 的推荐按钮和评分组件、R1 的嵌入式聊天，与视觉规范一致，支持浅色和深色；验收为 `/dev/ui` 中逐个组件预览、390px 无横向滚动、浅色与深色正确）。

## What Changes

使用者已于 2026-11-14 决定以下三点（确认 `docs/design-system.md` §6「AI 聊天组件（tasks 9.1 选型结论，待使用者确认）」）：

1. 「移植 Fluid 的 AI 组件（chat-message、thinking-steps / thinking-indicator、input-message 等，Radix 版，MIT）到 `packages/ui`，遵循 `packages/ui/UPSTREAM.md`；另写一层薄适配，把 AI SDK `UIMessage` 的 parts（正文、推理、工具调用、出错 / 重试状态）映射到这些组件。Vercel AI Elements 只作参考。」
2. 「回复中的 Markdown 复用长文阅读器现有的 Markdown 管线；不做语法高亮；代码块等宽字体加复制按钮。必须安全（不注入原始 HTML），并能容忍流式中途的不完整 Markdown。」
3. 「范围：`@saas/ui` 新增组件，同时把真实对话页和嵌入式 SubjectChat 都切换过去，只留一个嵌入式外壳。」

具体变化：

- **`@saas/ui` 新增对话组件**（经新子路径 `@saas/ui/chat` 导出，不进主入口）：
  - `ChatMessage`：用户 / 助手两种角色，状态标记（生成中、已停止、未完成、失败、重试中），操作区插槽；
  - `ThinkingIndicator`（等待首个输出时）与 `ThinkingSteps`（可折叠的推理过程）；
  - `ToolCall`：工具调用的名称与状态卡片（准备中、执行中、完成、出错），默认不展示原始参数与结果；
  - `InputMessage`：自适应高度的输入框，发送 / 停止按钮互换，左侧工具插槽（模型选择、Thinking 开关），右侧信息插槽（预计消耗）；不移植上游的附件能力；
  - `ChatMarkdown`：复用阅读器的元素白名单与链接协议白名单，丢弃原始 HTML，默认不显示图片；代码块等宽、块内横向滚动、显示语言名、带复制按钮；表格块内横向滚动；流式中途按块增量渲染。
  - 全部为纯展示组件：文案由应用传入，不依赖 `ai` 包。
- **适配层**（`apps/web/src/features/ai/`）：把 `UIMessage` 的 text、reasoning、`tool-*` / `dynamic-tool`、未知 part 分发给上述组件。reasoning 仍受 `templateConfig.ai.text.reasoning.display` 控制；工具卡片的显示名与详情渲染由项目自有文件按工具名注册。
- **对话页切换**：`/app/$slug/chat/$conversationId` 改用新组件，状态文字与按钮文字全部进 `messages/{en,zh}`；增加「复制回复」操作；流式状态经 `aria-live` 播报状态变化而不是逐字播报。
- **只留一个嵌入式外壳**：`SubjectChat` 改为渲染在 `EmbeddedChat` 中（标签作为徽标、新对话与历史作为头部操作、输入框作为 footer），不再自建布局；对话状态提到外壳之外，面板关闭再打开不丢消息与草稿。
- **预览与检查**：`/dev/ui` 新增「对话组件」一节，逐个组件展示全部状态；`EmbeddedChat` 预览改用真实消息组件与输入框；首页包检查覆盖对话 Markdown。
- **设计关卡**：对话页（桌面 / 移动 × 浅色 / 深色）、嵌入式 SubjectChat 与各消息状态先在 Design 画布出稿，经使用者确认后再实现页面切换。
- **不在本变更**：
  - 语法高亮、数学公式、Mermaid 图；
  - 附件上传与 `ask-user-questions` 交互；
  - 手动「重新生成」与编辑已发送消息（需要服务端语义）；
  - 服务端流式协议、积分与结算逻辑；
  - 对话列表页 `/app/$slug/chat` 的改版。

## Capabilities

### New Capabilities
- `chat-ui`：对话界面的消息展示、推理与工具调用展示、回复 Markdown 的安全渲染与流式容错、输入与停止、状态播报、多语言文案、嵌入式外壳，以及浅色 / 深色与 390px 布局。

### Modified Capabilities
（无。`ai-chat` 的流式与停止、`ai-text-reasoning` 的「折叠显示」与「关闭时不下发」保持不变，本变更只改界面实现；对象对话、推荐问题与评分的需求仍由未归档的 `add-subject-chat` 负责。）

## Impact

- **代码**：
  - `packages/ui/src/components/` 新增 `chat-message.tsx`、`thinking-indicator.tsx`、`thinking-steps.tsx`、`tool-call.tsx`、`input-message.tsx`、`chat-markdown.tsx`（及代码块），新增 `src/chat.ts` 子路径入口；`lib/markdown.ts` 抽出阅读器与对话共用的部分；`UPSTREAM.md`、`components.lock.json` 更新；图标槽位按上游名补充。
  - `apps/web/src/features/ai/`：新增 `message-parts.tsx` 适配层与项目自有的 `message-parts.project.tsx`；改写 `chat-page.tsx`、`subject-chat.tsx`。
  - `apps/web/src/features/ui-preview/`：新增对话组件一节，改写 `EmbeddedChat` 预览。
  - `apps/web/scripts/check-home-bundle.mjs`：增加对话组件的标记。
- **依赖**：不新增依赖。复用 `packages/ui` 已有的 `react-markdown`、`remark-gfm`、`radix-ui`、`motion`、`lucide-react`。
- **数据库 / 接口**：无迁移，无接口变化。
- **文案**：`apps/web/messages/{en,zh}/ai-chat-ui.json` 增加对话页文案，`ui-preview-chat.json` 为预览文案。
- **衍生项目**：同步后对话页与 SubjectChat 外观改变；项目可在 `message-parts.project.tsx` 注册工具卡片，外观定制按 `docs/design-system.md` §9.2 的顺序。
- **文档**：`docs/design-system.md` §6（选型结论改为已确认）与 §6.1（新组件表）、`packages/ui/UPSTREAM.md`、升级说明。
