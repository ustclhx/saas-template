# AI 组件选型（任务 9.1）

`docs/design-system.md` 尚未创建，结论先写在本 change 目录；该文档建立后整节迁入。
调研日期 2026-11-11，只读取外部 registry 与仓库元数据，未安装任何依赖。

## 现状

- 聊天页 `apps/web/src/features/ai/chat-page.tsx` 用 `@ai-sdk/react` v4 的 `useChat` + `ai` v7
  的 `DefaultChatTransport`；消息为纯文本（`whitespace-pre-wrap`），推理用原生 `<details>`，
  无 Markdown、代码高亮与工具调用展示。
- 业务组件：SubjectChat、SuggestionChips、MessageFeedback、余额不足引导、ModelPicker 与积分预估。
- `packages/ui` 已移植 Fluid 基线（`springs`、`shape/size/surface/icon-context`、
  `type-scale`、`use-fluid-hover`、`use-touch-primary` 等），依赖 `radix-ui` 与 `motion`。

## 对比

| 维度 | Fluid AI 组件 | Vercel AI Elements |
|---|---|---|
| 数据模型 | 纯展示组件，不认识 `UIMessage`；需自写 parts → props 适配（text/reasoning/tool） | 按 AI SDK `UIMessage` parts 设计（Message、Reasoning、Tool、Sources 等），但上游依赖 `ai` ^6，需确认 v7 类型兼容 |
| 视觉一致性 | 与本仓库 Fluid 基线同源（spring、shape、size、type-scale），无需改样式 | shadcn 默认风格，需逐个改 token、圆角、动效才能贴合 Fluid |
| 依赖与体积 | 只需 `motion`、`lucide-react`、Radix Collapsible（均已有或很小）；`input-message` 约 57KB 源码、`ask-user-questions` 约 80KB 源码 | 组件按需拷贝，但 Response/代码块拉入 `streamdown`、`shiki`、`katex`、`mermaid` 等重依赖；需裁剪 |
| 可访问性 | 有 reduced-motion、触控区处理；需自行补 `aria-live` 流式播报 | Radix/shadcn 原语，基础可访问性较好；同样需补流式播报 |
| 许可证 | 未在 registry 中查到明确许可证声明，**需确认** | Apache-2.0（npm `ai-elements` 1.9.1） |
| 活跃度 | 单一作者 registry，节奏未知 | vercel/ai-elements 约 2.5k star，2026-10-14 仍有提交 |
| 移植成本 | 去 `"use client"`、`@/` 路径改为 `@saas/ui` 内部路径、`next/image` 注释无实际依赖；`ask-user-questions` 依赖 `@base-ui/react`，按设计不引入 Base UI，须改写为 Radix | 去 Next.js 假设较少；主要成本在主题改写和重依赖裁剪 |
| 衍生项目影响 | 落在 `packages/ui`，随主题预设/品牌层自动生效 | 引入第二套视觉语言，衍生项目品牌层覆盖面变大 |

## 推荐

采用 **Fluid AI 组件做视觉层 + 自写薄适配层对接 `UIMessage` parts**；Markdown 渲染单独选型
（优先轻量方案，如只引入 `streamdown` 核心而不带 mermaid/katex），可参考 AI Elements 的
parts 分发与 Tool 状态设计，但不整体引入。理由：视觉与现有基线同源、依赖最少、衍生项目继承
成本最低；AI Elements 的主要优势（parts 契合）可由一个约百行的适配层获得。

## 迁移步骤草案

1. 确认 Fluid 组件许可证；不明确则改为参考实现自写。
2. 移植 `thinking-indicator`、`chat-message`、`thinking-steps`、`input-message` 到 `packages/ui`
   （依赖 `file-thumbnail`、`badge`、`tooltip`、`tokens` 一并移植），去 `"use client"` 与 `@/` 路径。
3. `ask-user-questions` 用 Radix 改写，或延后到有追问交互需求时。
4. `apps/web/src/features/ai` 增加 `message-parts.tsx`：text → ChatMessage，reasoning →
   ThinkingSteps（受 `ai.text.reasoning.display` 控制），tool-* → 状态卡片，未知 part 忽略。
5. 替换 ChatPage/SubjectChat 的消息与输入区，保留 SuggestionChips、MessageFeedback、
   余额不足引导与 ModelPicker 的现有逻辑；补 `aria-live` 与现有测试。
6. 390px、明暗主题与 Lighthouse 可访问性验收。

## 风险

- 许可证未确认；`input-message`/`ask-user-questions` 体量大，移植与维护成本高。
- 上游 registry 更新无版本号，需记录移植基准日期以便后续对比。
- Markdown/代码高亮引入后影响 Worker 包体积，需在新 change 中给预算。

## 后续 change

`add-ai-chat-components`：范围为第 2–6 步（Fluid AI 组件移植、parts 适配层、Markdown 渲染选型、
聊天页与 SubjectChat 替换及验收）；不改服务端流式协议与积分逻辑。
