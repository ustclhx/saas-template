## Why

模板已有流式文本对话与图片 / 视频任务，但模型只能「回答」，不能调用工具、分多步完成任务，也不能在执行敏感操作前请用户确认。后续的生图站、视频站以及衍生项目的业务助手（例如按用户资料查询、批量生成），都需要一个统一的 agent 底座：工具注册、多步执行、人工确认、可恢复的长会话，以及与现有积分、权益、租户隔离一致的计费与权限。

使用者已决定（2026-11-23）：agent 先只支持 Cloudflare，基于 Cloudflare Agents SDK（Durable Objects）实现，selfhost 暂不支持；以插件形式交付，项目按需启用。

使用者已决定（2026-11-24，依据 `research.md`）：首版用 `AIChatAgent`（循环来自现有 AI SDK），`PiHarness`（pi-durable）作为备选；消息暂不备份到 Postgres；对话保留期做成配置项、默认关闭；Durable Object 放在 web Worker，不单独建 Worker、不跨项目共用。

## What Changes

- 新增 `agents` 插件（依赖 `add-plugin-system`，仅 Cloudflare 目标，依赖 billing 与 credits）：
  - 每个 agent 对话对应一个 Durable Object 实例（基于 `@cloudflare/ai-chat` 的 chat agent），消息与流在实例内持久化，断线可续流，实例被驱逐后可恢复。
  - web Worker 在请求前置处理中接管 `/agents/*`：用站点会话验证身份、校验空间成员与对话归属，再转发给实例；实例名称由服务端确定，客户端无法指定他人实例。
- 工具契约：`packages/ai` 新增与业务无关的工具定义类型（名称、说明、输入 schema、是否需要确认、执行函数签名）；工具来自核心示例、项目自有文件和其他插件（例如未来生图站的「生成图片」工具），由插件注册表汇总。
- Agent 定义：项目在插件目录内的项目自有文件中声明 agent（系统提示词、默认模型、可用工具、最大步数），template-sync 不覆盖。模板提供一个示例 agent 和两个安全的示例工具。
- 计费：每一轮（用户一条消息触发的多步执行）开始前按步数上限预扣积分，结束、停止或失败时按实际用量结算，沿用现有超额容忍与欠费规则；每步结束写用量检查点，异常中断由 jobs 的清理器按检查点结算（只操作 Postgres）。工具自身产生的费用（如媒体任务）走各自的预扣，不重复计费。
- 权限：每轮开始前检查空间成员资格、模型权益与工具调用能力、限流、欠费与余额；模型注册表新增「支持工具调用」标记，只有标记的文本模型能用于 agent。
- 人工确认：工具可声明需要确认，执行前暂停等待用户批准或拒绝，拒绝结果回给模型。
- 数据：Postgres 保存对话列表（复用 `ai_conversation`，新增 `kind = 'agent'` 与 `agent_id`）与每一轮的审计与结算记录（新表 `ai_agent_turn`）；消息正文只存在 Durable Object 中，不在数据库备份范围内。删除对话、删号、删空间时同步清除实例数据；可选的保留期配置（默认关闭）开启后自动删除长期无活动的对话。
- 界面：应用区新增 agent 列表与对话页（新页面，先经 `ui-design` 取得设计确认），复用现有消息部件渲染与工具渲染注册，新增工具调用与确认卡片。
- 异步工具结果：长任务工具（例如媒体生成）返回任务 ID，对话实例按退避节奏读取任务状态，任务结束后把结果写回对话；媒体任务本身不需要知道 agent。

不在本次范围：selfhost / Node 目标、MCP 客户端与服务端、定时或无人值守的 agent、多 agent 协作、公共 API 调用 agent、后台查看他人对话内容、生图站与视频站产品层（后续 change 以工具形式接入）。

## Capabilities

### New Capabilities

- `ai-agents`: agent 对话的身份与归属校验、多步工具执行、人工确认、按轮预扣与结算、异常恢复、数据清理、可选保留期与界面。

### Modified Capabilities

- `ai-model-registry`: 文本模型新增「支持工具调用」标记，后台可编辑；agent 只能选用带标记的模型。
- `account-deletion`: 删号与删空间的 AI 内容清理覆盖 agent 对话实例数据与 agent 轮次记录。

## Impact

- 依赖：`add-plugin-system` 的插件机制（Worker 导出、fetch 前置处理、jobs 积分预扣清理器注册、消息部件渲染器扩展点、仅 Cloudflare 目标）。
- 新增 `plugins/agents`；新依赖 `agents`、`@cloudflare/ai-chat`（精确版本锁定，均未到 1.0）。兼容现有 `ai` 7 与 `@ai-sdk/react` 4。
- `packages/ai`：工具契约类型；`packages/db`：迁移（`ai_conversation.kind/agent_id`、`ai_model.supports_tools`、`ai_agent_turn`），`credit_hold.ref_type` 增加 `agent_turn`；`packages/credits`：无接口变化。
- wrangler：web 增加 Durable Object 绑定（各环境）与 SQLite 类迁移；jobs 不绑定该类（web 已绑定 jobs 的 Workflow，反向绑定会让两个 Worker 的首次部署互相依赖），所有实例操作在 web 内完成。
- 文档：`docs/06-ai.md` 新增 agent 章节、`docs/plugins.md` 登记插件、`docs/03-data-model.md` 新表、`docs/08-roadmap.md` 阶段条目。
- 成本：无用户时不产生定时任务或数据库轮询（Neon 成本基线）；Durable Object 按请求计费，空闲实例休眠。
