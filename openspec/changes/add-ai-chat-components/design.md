# Design

## Context

- **对话页**：`apps/web/src/features/ai/chat-page.tsx` 用 `@ai-sdk/react` v4 的 `useChat` 与 `ai` v7 的 `DefaultChatTransport`（`/api/ai/chat`）。消息气泡是页内 `ChatMessage`（约 L345–390）：`<li>`、原生 `<details>` 显示推理、`whitespace-pre-wrap` 纯文本；输入区（约 L273–340）是原生 `<textarea>` + `Button`，Enter 发送已处理输入法组字。"Stopped"、"This reply failed…"、"Incomplete"、"Retrying…"、"Reasoning"、"Messages"、"Send a message"、"Thinking"、"Stop"、"Send"、"All chats" 等写死英文。没有工具调用的展示。
- **消息工具函数**：`features/ai/conversation.ts` 的 `messageText`、`messageReasoning`、`messageRetrying`；推理展示受 `templateConfig.ai.text.reasoning.display` 控制。
- **嵌入式对话**：`features/ai/subject-chat.tsx` 自建 `<section>` / 头部 / `<details>` 历史，内部复用 `ChatPage variant="embedded"`；`@saas/ui` 的 `EmbeddedChat`（`inline` / `panel`，< md 为底部抽屉，**关闭时卸载 children**）只在 `/dev/ui` 使用。
- **R2 组件**：`SuggestionChips`、`MessageFeedback` 已在 `packages/ui`，经 `features/ai/chat-extras.tsx` 接线，本变更不改它们的接口。
- **Markdown**：阅读器 `packages/ui/src/components/reader-markdown.tsx` 用 react-markdown + remark-gfm（micromark / mdast），`skipHtml`、元素白名单 `MARKDOWN_ALLOWED_ELEMENTS`、协议白名单 `safeMarkdownUrl`、图片策略都在 `src/lib/markdown.ts`，文件注释写明「聊天消息以后复用」；只经 `@saas/ui/reader` 子路径导出。
- **包体积**：`apps/web/scripts/check-home-bundle.mjs` 以 `user-content-`、`data-footnotes` 等标记拦截 Markdown 代码进入首页闭包。
- **依赖边界**：`scripts/check-deps.mjs` 只允许 `packages/ui` 使用 React；`packages/ui` 保持无业务（不认识 AI SDK、积分、空间）。
- **选型**：`openspec/changes/add-ui-design-system/ai-components.md`（tasks 9.1）对比了 Fluid AI 组件与 Vercel AI Elements；使用者 2026-11-14 确认采用 Fluid，见 proposal。

## Goals / Non-Goals

**Goals:**
- 对话页与嵌入式对话用同一套 `@saas/ui` 组件，外观随主题预设与品牌层生效。
- `packages/ui` 的对话组件不依赖 `ai` 包，换 SDK 版本只改适配层。
- 对话 Markdown 不进首页包，不新增依赖。

**Non-Goals:**
- 不改流式协议、消息存储格式、积分与结算。
- 不做语法高亮、数学公式、Mermaid、附件与 `ask-user-questions`。
- 不改对话列表页 `/app/$slug/chat` 与 `SuggestionChips`、`MessageFeedback` 的接口。

## Decisions

### D1. 移植 Fluid 的四个组件，按 UPSTREAM 规则改造

从 `https://www.fluidfunctionalism.com/r/<name>.json`（Radix 版）取 `chat-message`、`thinking-indicator`、`thinking-steps`、`input-message`，按 `packages/ui/UPSTREAM.md` 的统一适配规则 1–10 移植到 `packages/ui/src/components/`，文件清单逐行登记上游月份与改动。本模板的改动：

- **文案**：上游英文默认文案（"Thinking…"、"Send"、"Stop" 等）全部改为必填 `labels`（规则 10）。
- **InputMessage**：不移植附件、拖放与 `file-thumbnail`（对话没有上传能力，以后要加时再按上游合并）；保留自适应高度（`field-sizing` 优先，回退为脚本计算，上限约 8 行后框内滚动）；新增 `leading`（模型选择、Thinking 开关）与 `trailing`（预计消耗）插槽；`busy` 时发送按钮换成停止按钮，换位时若焦点在按钮上，焦点移到输入框（停止按钮卸载会让焦点落到 body）。Enter 发送、Shift+Enter 换行、`isComposing` 不发送沿用现有实现。
- **ChatMessage**：`from: 'user' | 'assistant'`（沿用上游名；`role` 与 HTML role 属性同名，Biome `a11y/useValidAriaRole` 会把每个调用处判为无效 ARIA role）、`leading?`（头像旁的内容，如推理按钮）、`status?`（`streaming` / `aborted` / `failed` / `incomplete` / `retrying`）、`statusLabel?`、`actions?`（放 MessageFeedback 与复制回复）、`children`（内容由调用方按 part 组合）。气泡与对齐以设计稿为准；助手消息按自身宽度切换版式（容器查询，阈值 `--container-chat-message`）：窄时头像与 `leading` 同一行、正文与操作区通栏在下（Mobile / EmbeddedMobile 画板），宽时为头像列 + 内容列。流式光标约定（与 D4 的 ChatMarkdown 共用）：`status="streaming"` 时内容区带 `data-chat-streaming`，光标只画在其中的 `[data-chat-tail]` 之后（`globals.css`），与 DOM 层级无关；ChatMessage 自己包段落的纯文本子节点由它标在最后一段上，其他自定义内容由调用方自行标注。
- **ThinkingSteps**：上游的步骤列表用于推理文本时只有一步，接口保留 `steps`，适配层传单步；折叠用 radix-ui `Collapsible`，触发按钮带 `aria-expanded`。
- **ThinkingIndicator**：等待首个可见输出时显示；闪烁动效在减少动态效果时改为静止（CSS `motion-reduce:` + MotionConfig）。
- 动效按规则 8 用 `m as motion` + `MotionFeatures`。上游用到的图标（复制、停止、发送等）直接从 lucide 导入，不补进 `icon-context` 与 `UiRoot` 默认图标表：对话组件只在对话路由加载，补进默认表会让图标进入首屏包（同 `message-feedback.tsx` 的做法）。
- 备选：Vercel AI Elements 整体引入——shadcn 风格需逐个改样式、`Response` 拉入 `streamdown` / `shiki` / `katex` 等重依赖，上游声明 `ai` ^6，不采用（见 ai-components.md）。

### D2. 新增 ToolCall 组件（模板新增，参考 AI Elements 的 Tool）

Fluid 没有工具调用组件，参考 AI Elements `Tool` 的状态划分新写 `tool-call.tsx`：`name`（显示名）、`state: 'pending' | 'running' | 'done' | 'error'`、`labels`、可选 `children`（详情，可折叠）。AI SDK 的 `input-streaming` → pending、`input-available` → running、`output-available` → done、`output-error` / `output-denied` → error。默认不渲染参数与结果：工具参数常含内部 ID 与提示词片段，错误信息可能含上游细节。

### D3. 对话 Markdown：抽出共用层，新写 ChatMarkdown

- `lib/markdown.ts` 保持为唯一的白名单与协议来源；阅读器与对话共用 react-markdown + remark-gfm + `skipHtml` + `allowedElements` + `urlTransform`（`safeMarkdownUrl`）。共用的渲染选项抽成 `lib/markdown-options.ts`（或同文件导出），阅读器行为不变（以阅读器现有测试为准）。
- `chat-markdown.tsx` 的差异：
  - **排版**：紧凑的对话档（标题降级为 `text-subtitle` 粗体，不生成标题 id、不进目录、不可聚焦）；
  - **图片**：策略固定为 `none`，`img` 渲染为替代文字（有安全链接时为链接）。理由：模型输出的图片地址可以把对话内容编码进查询串，自动加载即外泄（提示注入）；
  - **链接**：外链 `target="_blank" rel="noopener noreferrer nofollow ugc"`；
  - **脚注**：同一页有多条回复，`remarkRehypeOptions.clobberPrefix` 按消息 id 区分，避免 id 冲突；脚注文案经 labels 传入；
  - **代码块**：`CodeBlock` 组件——等宽、不高亮、`overflow-x-auto` 且 `tabIndex={0}` 带可读名称（axe `scrollable-region-focusable`），头部显示 fence 语言名（纯文本）与复制按钮；
  - **表格**：外包 `overflow-x-auto` 容器，同样可聚焦；
  - **长词与长链接**：正文 `break-words`（`overflow-wrap:anywhere`），代码块与表格除外。
- 组件经新子路径 `@saas/ui/chat` 导出（与 `@saas/ui/reader` 同理），主入口不导出，首页包不受影响。
- 备选：`streamdown`——自带不完整 Markdown 修补与高亮，但引入 shiki 等依赖、重复一套白名单，不采用。

### D4. 流式容错：按块增量渲染

- CommonMark 本身对未闭合结构是容错的（未闭合的代码块延续到文末、只有表头的表格作为段落），不做文本修补，保证完成后的结果与整段渲染一致。
- 性能：`ChatMarkdown` 接收 `streaming` 标记；流式时用 mdast 的顶层块位置（`remark-parse` 已是依赖）把文本切成「已完成的块」与「最后一块」，已完成的块各自 `memo` 渲染，只有最后一块随输出更新；切分只在代码块外的块边界发生。生成结束后整段渲染一次。流式时 `ChatMarkdown` 在最后一个承载文字的块元素（段落、列表项、标题、引用中的最后一段等）上加 `data-chat-tail`，ChatMessage 的流式光标接在它之后（约定见 D1）；结束后不再输出该属性。
- `useChat` 设 `experimental_throttle`（约 50ms）降低重渲染频率。
- 备选：每个 token 整段重新解析——回复较长时主线程占用明显，作为退路（块切分出错时回退整段渲染，单测覆盖二者一致）。

### D5. 适配层在 apps/web，项目工具渲染器在项目自有文件

- `apps/web/src/features/ai/message-parts.tsx`：输入 `ChatUIMessage`、状态与 labels，输出组件树；
  - `text` → `ChatMarkdown`（多段 text 依序渲染）；
  - `reasoning` → `ThinkingSteps`（`templateConfig.ai.text.reasoning.display` 关闭时跳过）；
  - `tool-<name>` / `dynamic-tool` → `ToolCall`，显示名与详情查注册表；未注册的工具只显示通用文案「工具」与状态，不显示原名（原名可能是内部标识）；
  - `step-start`、`source-*`、`file`、`data-*` 等其他 part → 忽略。
  - 等待首个可见输出（流式中且没有 text）→ `ThinkingIndicator`；`messageRetrying` → `retrying` 状态。
- `conversation.ts` 现有的 `messageText` / `messageReasoning` / `messageRetrying` 保留供其他地方使用，适配层复用它们的判断。
- 工具注册：`apps/web/src/features/ai/message-parts.project.tsx`（项目自有，模板只初始化空注册，生成器与 template-sync 登记为项目拥有，同 `nav.project.ts`），`registerToolRenderer(name, { label, render? })`。
- 备选：组件直接接收 `UIMessage`——`packages/ui` 要依赖 `ai` 的类型，换 SDK 主版本时 ui 组件指纹全部变动，衍生项目同步成本高，不采用。

### D6. 对话页切换

- `ChatPage` 拆成 `ChatThread`（消息列表、推荐问题、错误与余额不足引导）与 `ChatComposer`（`InputMessage` + ModelPicker + Thinking `Switch` + CreditEstimate），二者都接收同一个 `useChat` 返回值；`ChatPage` 组合它们并保留现有 props，`SubjectChat` 用它们填入外壳。
- 页面布局（消息列宽、输入区是否吸底、标题是否进 `AppShellBar`）以设计稿为准。
- 所有页面文字进 `messages/{en,zh}/ai-chat-ui.json`（键前缀 `chat_ui_`），包括 "Thinking"（改为 `Switch` 的 label）、"Message" 可读名称、"All chats" 与 "This workspace is read-only."。
- 「复制回复」放进 `MessageFeedback` 的 `actions` 插槽，复制 `messageText` 的原文。
- 状态播报：消息列表 `<ol>` 不设 `aria-live`（`role="log"` 会逐段朗读），另设一个视觉隐藏的 `role="status"` 区域，只在状态变化时写入「正在生成 / 已完成 / 已停止 / 失败 / 重试中」。
- 新消息到达时：用户位于底部附近才自动滚动；用户上翻阅读时不抢滚动位置（显示「回到最新」按钮与否以设计稿为准）。

### D7. 只留一个嵌入式外壳：SubjectChat 进 EmbeddedChat

- `SubjectChat` 渲染 `EmbeddedChat`：`badge` = 对象标签，标题 = 对象标题，`headerAction` = 「新对话」与历史（历史由 `<details>` 改为 `Dropdown` 菜单），`children` = `ChatThread`，`footer` = `ChatComposer`。`variant` 由调用方传入，默认 `inline`（与现有在正文流中的形态一致）。
- **状态上提**：`EmbeddedChat` 关闭时卸载 children（≥ md 的 panel 与 < md 的抽屉）。对话状态改用 `@ai-sdk/react` 的 `Chat` 实例：`SubjectChat` 在外壳之外按会话 id 创建并持有 `Chat`，`useChat({ chat })` 在 children 内使用，关闭再打开不丢消息与正在进行的流；草稿也由 `SubjectChat` 持有。卸载期间流继续由 `Chat` 实例消费，不调用 stop。
- 还没有会话时的「开场推荐问题 + 输入框」也放进同一外壳，不再是单独布局。
- `ChatPage variant="embedded"` 删除，嵌入场景只有 SubjectChat 一条路径。
- 备选：保留 SubjectChat 自建布局，只换消息组件——仍是两套外壳，违背使用者决定 3。

### D8. 预览页与首页包检查

- `/dev/ui` 新增「对话组件」一节（`#chat`）：ChatMessage 各状态、ThinkingIndicator、ThinkingSteps 折叠 / 展开、ToolCall 四态、InputMessage（空、有内容、忙碌、禁用）、ChatMarkdown 示例（标题、列表、表格、长代码行、危险链接与图片示例）、流式模拟（定时追加文本，可暂停）。示例文案在 `messages/<locale>/ui-preview-chat.json`。
- 原「SuggestionChips · MessageFeedback · EmbeddedChat」一节的 `chatBody` 改用真实 `ChatMessage` 与 `InputMessage`。
- `check-home-bundle.mjs`：对话组件的标记（如代码块的 `data-chat-code`）加入 `FORBIDDEN_MARKERS`；首页闭包现已拦截 `user-content-` 与 `data-footnotes`，对话 Markdown 同样适用。
- 对话路由按 TanStack Start 路由分包懒加载，`@saas/ui/chat` 只被对话路由与 SubjectChat 所在页面引用。

### D9. 设计稿（协调者负责，tasks 2.1）

设计稿已于 2026-11-14 经使用者确认，见 `docs/design-system/prototypes/README.md` 的「对话页」「嵌入式 SubjectChat」两行（副本 `chat-components/`）。画布上的七条版式取舍一并确认：消息列 720px 居中、输入区固定底部；标题留在对话区头部（含「全部对话」返回）；生成中上滑时出现「回到最新」；失败只显示原因不提供重试；回复图片只显示替代文字；未注册工具只显示「工具」；SubjectChat 默认 inline、手机为底部抽屉。原定画板：

1. 对话页 `/app/$slug/chat/$conversationId`：桌面 × 浅色 / 深色、390px × 浅色 / 深色（正常态：多轮对话，含推荐追问与评分）；
2. 空对话（开场推荐问题 / 无推荐时的提示）；加载态；错误态（余额不足引导）；
3. 嵌入式 SubjectChat：`inline`（桌面）、`panel`（桌面右侧面板）、390px 底部抽屉，各含未开始（推荐问题 + 输入框）与进行中两态，头部的新对话与历史菜单；
4. 消息状态：等待首个输出（思考中）、流式生成中、推理折叠 / 展开、工具调用四态、已停止、失败、未完成、重试中；
5. Markdown 样例：标题、列表、引用、表格（含窄屏横向滚动）、行内代码、带语言名与复制按钮的代码块（含超长行）、外链；
6. 输入区：空、有多行内容、生成中（停止按钮）、禁用（只读空间），含模型选择、Thinking 开关与预计消耗。

## Risks / Trade-offs

- [上游 `input-message` 体量大（约 57KB 源码），裁掉附件后与上游差异大] → UPSTREAM.md 逐项登记删减；季度合并时只对照保留部分。
- [按块切分与整段渲染结果不一致] → 单测对一组夹具（含代码块、表格、列表嵌套、脚注）逐字符流式喂入，断言每一步不报错且最终 HTML 与整段渲染相同；出错时回退整段渲染。
- [`Chat` 实例上提后，切换会话时旧实例仍在消费流] → 按会话 id 缓存实例，切换不停止旧流（与关闭外壳一致），组件卸载（离开页面）时才 `stop`；单测覆盖。
- [组件指纹变化导致衍生项目 `check:ui` 失败] → 新文件不影响已有指纹；改动 `reader-markdown.tsx` 与 `embedded-chat.tsx` 时在升级说明列出。
- [对话页外观大改，衍生项目已有截图验收失效] → 升级说明写明，并给出 `/dev/ui#chat` 作为对照。
- [图片不显示可能影响确实需要图片的项目] → 记为已知限制；以后按需在 `ChatMarkdown` 增加同源图片策略的显式开关，默认仍为 `none`。

## Migration Plan

- 无数据迁移。消息仍以现有 `UIMessage` parts 存储，历史消息直接以新组件渲染（包括以前以纯文本显示的 Markdown）。
- 回滚：回退本变更的提交即可，服务端与数据不受影响。
- 衍生项目：同步后检查对话页、嵌入了 SubjectChat 的页面与 `/dev/ui#chat`；用过 `ChatPage variant="embedded"` 的项目改为 `SubjectChat` 或 `ChatThread` + `ChatComposer`（升级说明给出替换写法）。

## Open Questions

- 「回到最新」按钮与消息列宽等布局细节由设计稿确定，不影响任务拆分。
