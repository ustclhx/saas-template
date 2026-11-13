# Tasks

并行安排（各线一个 worktree，遵守 `docs/09-parallel-plan.md` §3）：

- 第 2 组（组件移植）与第 3 组（对话 Markdown）互不依赖，可同时开工；
- 第 6 组（预览页）在 2、3 合并后开工，可与第 4 组并行；
- 第 4 组（适配层与对话页）需要 2、3 合并且第 1 组设计稿已确认；第 5 组在 4 合并后开工（或与 4 同线顺序完成）；
- 共享文件：`packages/ui/components.lock.json` 冲突时 rebase 后 `pnpm ui:lock` 重新生成；`packages/ui/UPSTREAM.md` 冲突时保留两边新增的行；文案按文件分开——第 4、5 组只改 `ai-chat-ui.json`，第 6 组只改 `ui-preview-chat.json`。

## 1. 设计稿（协调者）

- [x] 1.1 用 `ui-design` 技能出 Design 画布，画板见 design D9：对话页桌面 / 390px × 浅色 / 深色、空 / 加载 / 错误态，嵌入式 SubjectChat 的 inline / panel / 底部抽屉（未开始与进行中），消息各状态（思考中、流式、推理折叠 / 展开、工具调用四态、已停止、失败、未完成、重试中），Markdown 样例（表格、长代码行、复制按钮），输入区四态。经使用者确认后保存副本并登记原型索引（原型索引行待使用者确认后登记）；确认结果与 design D6、D7 有出入时同步更新 design 与本 tasks。验证：`docs/design-system/prototypes/README.md` 有对应行，附使用者原话，副本文件存在。

## 2. 组件移植（`packages/ui`，线 A）

- [x] 2.1 移植 `thinking-indicator`、`thinking-steps`（design D1）：`labels` 必填，折叠用 radix-ui `Collapsible`，减少动态效果时指示静止。验证：组件单测覆盖折叠按钮的 `aria-expanded` 切换、`labels` 渲染；`test/motion-features.test.tsx` 增加两者并通过；`test/motion-imports.test.ts` 通过。
- [x] 2.2 移植 `chat-message`（design D1）：`from`（沿用上游名，`role` 会被 Biome a11y 规则判为无效 ARIA role）、`leading`、`status`、`statusLabel`、`actions`、`children`；长单词与长链接不撑出容器。验证：单测覆盖两种角色与五种状态的渲染、`actions` 插槽；390px 容器中长 URL 不产生横向溢出（happy-dom 断言 `overflow-wrap` 类名，截图留到 6.1）。
- [x] 2.3 移植 `input-message`（design D1）：去掉附件与 `file-thumbnail`，`leading` / `trailing` 插槽，`busy` 时发送换停止且焦点回到输入框，Enter / Shift+Enter / 输入法组字，空内容与 `disabled` 不发送，高度上限后框内滚动。验证：单测覆盖 Enter 发送、Shift+Enter 换行、`isComposing` 不发送、空内容不发送、busy 切换后 `document.activeElement` 为输入框、停止按钮键盘可触发。
- [x] 2.4 新增 `tool-call.tsx`（design D2）：四态、`labels`、可折叠详情，无详情时不渲染展开按钮。验证：单测覆盖四态文案与 `children` 缺省时没有展开按钮。
- [x] 2.5 新增子路径入口 `src/chat.ts` 与 `package.json` 的 `./chat` 导出（本组组件经它导出，不进主入口）；`UPSTREAM.md` 登记四个上游项（上游月份、删减附件等改动）与 ToolCall；`docs/design-system.md` §6.1 增加组件表行；`pnpm ui:lock`。验证：`pnpm --filter @saas/ui test`、`pnpm --filter @saas/ui typecheck`、`pnpm check:ui`、`pnpm check:deps` 通过；`index.ts` 中没有新组件的导出。

## 3. 对话 Markdown（`packages/ui`，线 B）

- [ ] 3.1 从 `reader-markdown.tsx` 抽出阅读器与对话共用的 react-markdown 选项（`skipHtml`、`allowedElements`、`urlTransform`）到 `lib/markdown.ts` 一侧（design D3），阅读器行为不变。验证：阅读器现有单测与 `/dev/ui/reader` 相关 e2e 通过，无快照变化。
- [ ] 3.2 新增 `chat-markdown.tsx` 与代码块组件（design D3）：对话排版档、图片策略固定 `none`（显示替代文字）、外链 `rel`、按消息 id 的 `clobberPrefix`、代码块等宽 + 语言名 + 复制按钮（`labels.copy` / `copied` / `copyFailed`，`role="status"` 播报）、代码块与表格可聚焦的横向滚动容器。验证：单测覆盖 `<script>` / `<img onerror>` / `<iframe>` 不产生元素、`javascript:` 与 `data:` 链接为纯文字、外部图片不产生 `<img>`、复制按钮写入剪贴板的文本不含语言名、剪贴板拒绝时显示失败文案且无未处理异常、两条消息各有脚注时 id 不冲突。
- [ ] 3.3 流式按块增量渲染（design D4）：`streaming` 时按顶层块切分，已完成的块 memo，结束后整段渲染；切分异常回退整段。验证：夹具（未闭合代码块、只有表头的表格、未闭合强调与链接、嵌套列表、脚注）逐字符流式渲染，每一步不抛错，最终输出与整段渲染的 HTML 相同；已完成块在后续输入时不重新渲染（渲染计数断言）。
- [ ] 3.4 `ChatMarkdown` 经 `@saas/ui/chat` 导出（与线 A 同一入口文件，冲突时合并导出行）；`check-home-bundle.mjs` 增加对话代码块标记；`UPSTREAM.md` 登记 `chat-markdown.tsx` 为模板新增；`pnpm ui:lock`。验证：`pnpm --filter @saas/web build` 通过；首页包检查单测中模拟首页静态导入 `@saas/ui/chat` 时检查失败。

## 4. 适配层与对话页（`apps/web`，线 C）

- [ ] 4.1 新增 `features/ai/message-parts.tsx` 与项目自有的 `message-parts.project.tsx`（design D5）：text / reasoning / tool / 未知 part 的分发、ThinkingIndicator 与 retrying 判定、`registerToolRenderer`；生成器与 template-sync 把 `message-parts.project.tsx` 登记为项目拥有。验证：单测覆盖 reasoning 展示开关两种取值、未注册工具只显示通用标签与状态且不含工具原名与参数、已注册工具显示名与详情、未知 part 被忽略、等待首个输出时显示 ThinkingIndicator；`pnpm test:create-project` 通过。
- [ ] 4.2 拆出 `ChatThread` 与 `ChatComposer`（design D6），`ChatPage` 组合二者并按 1.1 副本改布局；消息改用适配层；ModelPicker、Thinking `Switch`、CreditEstimate 放进 `InputMessage` 插槽；「复制回复」进 `MessageFeedback` 的 `actions`；自动滚动只在用户位于底部附近时发生；`useChat` 设 `experimental_throttle`。验证：`chat-page.test.tsx` 更新后通过，新增用例覆盖停止后显示已停止且保留正文、失败与未完成状态、复制回复写入原文、只读空间不能发送。
- [ ] 4.3 页面文字全部进 `messages/{en,zh}/ai-chat-ui.json`（状态、按钮、可读名称、空态、只读提示、"All chats"、复制反馈、工具四态与通用标签），`chat-page.tsx`、`message-parts.tsx` 中不再有英文字面量。验证：`pnpm typecheck` 生成文案通过；`rg` 检查上述文件无 "Stopped" / "Incomplete" / "Retrying" / "Reasoning" / "Send" 等字面量；切到中文后单测断言状态文字为中文。
- [ ] 4.4 状态播报（design D6）：视觉隐藏的 `role="status"` 区域只在状态变化时写入，消息列表不设 `aria-live`。验证：单测模拟 submitted → streaming（多次正文更新）→ ready，状态区只变化两次（正在生成、已完成）。
- [ ] 4.5 e2e：对话页发送消息（本地故障注入或测试模型），断言回复中的 Markdown 表格与代码块渲染、复制按钮可用、停止后显示已停止；390px 下 `document.documentElement.scrollWidth <= 390`；浅色与深色各截图与 1.1 副本对照。选择器与断言不依赖语言。验证：e2e 通过，截图与副本一致。

## 5. 单一嵌入式外壳（`apps/web`，线 C 或接续）

- [ ] 5.1 `SubjectChat` 改为渲染 `EmbeddedChat`（design D7）：徽标、标题、新对话与历史 `Dropdown`、`ChatThread` 为 children、`ChatComposer` 为 footer；未开始时的推荐问题与输入框也在外壳内；`variant` 由调用方传入，默认 `inline`；删除 `ChatPage variant="embedded"`。验证：`subject-chat` 相关单测更新后通过；`rg "variant=\"embedded\""` 在 `apps/web/src` 中无结果。
- [ ] 5.2 对话状态上提：`SubjectChat` 按会话 id 持有 `Chat` 实例与草稿，`useChat({ chat })`；外壳关闭不 stop，离开页面时 stop。验证：单测覆盖 panel 关闭再打开后消息与草稿仍在、关闭期间流继续并完成；e2e 在 390px 下打开抽屉发送、生成中关闭、再打开看到完成的回复。
- [ ] 5.3 SubjectChat 的新增文字进 `ai-chat-ui.json`（历史菜单、新对话等沿用 `ai-subject-chat.json` 已有键）；`docs/design-system.md` §6.1 的接线现状改为「SubjectChat 使用 EmbeddedChat」。验证：`pnpm typecheck` 通过；文档中不再写 `EmbeddedChat` 只在 `/dev/ui` 展示。

## 6. 预览页（`apps/web/src/features/ui-preview`，线 D）

- [ ] 6.1 `/dev/ui` 新增「对话组件」一节 `#chat`（design D8）：ChatMessage 全部状态、ThinkingIndicator、ThinkingSteps 折叠 / 展开、ToolCall 四态、InputMessage 四态、ChatMarkdown 样例（表格、长代码行、危险链接与图片）、可暂停的流式模拟；文案在 `messages/{en,zh}/ui-preview-chat.json`；原 EmbeddedChat 预览的消息体改用 `ChatMessage` 与 `InputMessage`。验证：`ui-preview.spec.ts` 增加 `#chat` 一节的断言并通过；390px 下 `scrollWidth <= 390`；浅色与深色截图与 1.1 副本对照。
- [ ] 6.2 Lighthouse / axe：`/dev/ui#chat` 无 `scrollable-region-focusable`、`color-contrast`、`aria-*` 类违规（浅色与深色各一次）。验证：e2e 中的 axe 检查通过，结果写入证据库。

## 7. 文档与升级说明

- [ ] 7.1 `docs/design-system.md` §6 的「AI 聊天组件（tasks 9.1 选型结论，待使用者确认）」改为已确认（2026-11-14，附三条决定的摘要与本 change 链接），删去「Markdown 与代码高亮另行选型」「另起 change」等过时说法；§6 页面模式表增加「对话」一行；§9 写明 `message-parts.project.tsx` 为项目拥有、对话外观按 §9.2 定制。验证：文档中不再出现「待使用者确认」字样指向本选型。
- [ ] 7.2 起草或追加下一版本的升级说明（`docs/upgrades/<下一版本>.md`）：对话页与 SubjectChat 外观变化、`ChatPage variant="embedded"` 删除及替换写法、新子路径 `@saas/ui/chat`、项目自有 `message-parts.project.tsx`、回复图片不再显示、`reader-markdown.tsx` 与 `embedded-chat.tsx` 指纹变化、首页包检查新标记。验证：`node scripts/template-release.mjs check` 通过。

## 8. 验收

- [ ] 8.1 `pnpm check`、`pnpm typecheck`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm check:ui`、`pnpm test`、`pnpm build` 全部通过，`pnpm test:create-project:verify` 通过。
- [ ] 8.2 staging 验收：
  - `/dev/ui#chat` 逐个组件与 1.1 副本一致，390px 无横向滚动，浅色与深色正确；
  - 对话页真实对话一次：Markdown（表格、代码块与复制）、推理折叠、停止、失败（故障注入）各一次；
  - 嵌入了 SubjectChat 的页面在桌面与 390px 下各完成一次对话，关闭再打开不丢消息；
  - 读屏（VoiceOver）抽查一次状态播报只在状态变化时发生；
  - 首页 Lighthouse 性能分不低于验收基线，首页包检查通过。

  证据写入私有证据库。
