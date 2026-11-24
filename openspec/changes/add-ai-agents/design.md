## Context

- 现有文本对话（`apps/web/src/features/ai/chat.ts`、`text-stream.ts`）：一次请求就是一次 `streamText`，不带 tools；调用前依次检查模型权益、限流、欠费、余额，在一个事务里建消息与预扣（`hold`，`refType: 'ai_message'`），结束后由 `packages/ai/src/text/settle.ts` 结算，中断则按用量检查点结算，jobs 的 `chatHoldSweeper` 兜底。
- 客户端已能渲染 `tool-<name>` / `dynamic-tool` 消息部件（`message-parts.tsx`、`tool-renderers.ts` 的 `registerToolRenderer`）。
- `ai_message.parts` 兼容 UIMessage，但只写入 reasoning 与 text 部件。
- `credit_hold.ref_type` 在迁移中是 text 列，TS 层枚举为 `ai_task | ai_message`。
- Cloudflare Agents SDK：`agents` 0.34.0、`@cloudflare/ai-chat` 0.12.3，peer 依赖 `ai` ^6 || ^7、`@ai-sdk/react` ^3 || ^4，与仓库版本兼容。成本、成熟度、多租户与部署形态的调研见同目录 `research.md`。
  - chat agent 的消息自动存在实例内 SQLite（单行上限 2 MB，接近时压缩大工具输出）。
  - 每一轮包在 fiber 中，实例被驱逐后可恢复并继续。
  - 支持 `needsApproval` 工具确认、断线续流、消息并发策略。
  - `routeAgentRequest` 提供 `onBeforeConnect` / `onBeforeRequest` 钩子，可拒绝或改写请求。
  - SDK 不回报 token 用量（`_onFinish` 为空操作）；恢复时会重新调用模型（`continueLastTurn`），被驱逐的那次调用用量丢失，工具可能执行两次。
  - `AIChatAgent` 继承 `Agent`，`Agent` 建在官方标为 Stable 的 Lifecycle 之上。
- 依赖 `add-plugin-system` 提供的扩展点：Worker 导出、fetch 前置处理、jobs 清理器、消息部件渲染器、仅 Cloudflare 目标。

## Goals / Non-Goals

**Goals:**

- 一个可复用的 agent 底座：工具注册、多步执行、人工确认、续流与恢复。
- 计费、权益、限流、欠费与租户隔离规则与现有文本对话一致，积分账本不出现未结算的预扣。
- 工具契约与业务无关，其他插件（生图站、视频站）与项目能贡献工具。
- 对 SDK 的依赖收敛在插件内部，SDK 升级只影响 `plugins/agents`。

**Non-Goals:**

- selfhost、MCP、定时 agent、多 agent 协作、公共 API。
- 管理员查看他人对话内容：与现有对话规则一致，内容只对创建者可见。

## Decisions

### 1. 一个对话对应一个 Durable Object 实例

- 实例名为 PG 中 `ai_conversation.id`（UUIDv7）。创建对话由 web 服务端函数完成，先写 PG 行（`kind = 'agent'`、`agent_id`、`workspace_id`、`user_id`、`model_key`），再返回 ID。
- 客户端连接 `/agents/<binding>/<conversationId>`。
- 实例首次处理请求时记住归属（workspaceId、userId），之后每个请求都比对。

不选「每个用户一个实例、实例内多对话」：chat agent 的消息列表按实例组织，一个实例一个对话最贴合 SDK，也便于按对话删除和隔离负载。

### 2. 身份校验在 Worker 前置处理中完成

插件 `worker` 入口注册 fetch 前置处理，只匹配 `/agents/` 前缀，调用 `routeAgentRequest`，在 `onBeforeConnect` 与 `onBeforeRequest` 中依次执行：

1. 删除请求中所有 `x-saas-*` 头，防止伪造。
2. 用 Better Auth 从 Cookie 读会话（会话有 KV 二级存储，不必每次查库）。没有会话返回 401。
3. 从路径取 conversationId，在 PG 中按 `scoped(db, workspaceId)` 与 `user_id` 查对话，同时确认成员资格仍有效。不存在或不属于当前用户返回 404，与现有对话「他人访问 404」一致。
4. 写入 `x-saas-user-id`、`x-saas-workspace-id`、`x-saas-conversation-id`，转发给实例。

实例只信任这些头，因为 Durable Object 只能经本 Worker 访问。实例再把头与已记住的归属比对，不一致返回 403 并记安全日志。

WebSocket 升级请求同源会带 Cookie，不需要额外 token。跨域访问不在本次范围。

### 3. 每轮执行流程（实例内 `onChatMessage`）

```
请求进入
  → 重新校验成员资格（每轮一次，查 PG）
  → requireAvailableModel（权益 + 模型 supports_tools）
  → 限流 rateLimiter.limit('ai')
  → 欠费与余额检查
  → 事务：插入 ai_agent_turn(status=running, request_id) + hold(refType='agent_turn')
  → streamText({ tools, stopWhen: stepCountIs(maxSteps), abortSignal, onStepFinish, onFinish })
      onStepFinish：累计用量写入 turn.usage_checkpoint
      onFinish：按定价快照计算实际积分 → capture → turn.status=completed
  → 停止或中断：按最后检查点结算（与文本 settleInterrupted 同规则）
  → 出错且没有可见输出：按现有 failedReplyRefund 规则 release
```

- 预扣额 = 单步预算 × `maxSteps`，并以 `plugins.agents.maxTurnCredits` 封顶；单步预算沿用 `planTextBudget`。
- 一轮的实际消耗超过预扣时，走现有超额容忍与欠费规则。
- 定价快照写在 turn 行上，结算只读这份快照，规则同文本对话。

取得用量的方式：在 `onChatMessage` 内自己调用 `streamText`，用 AI SDK 的 `onStepFinish` / `onFinish` 拿 `usage` 与 `totalUsage`，不依赖 SDK 的回调。第 1 组验证这条路径，以及 SDK 在恢复时重放模型调用的行为。

计费只信自己的账本：被驱逐的那次模型调用拿不到用量，按最后检查点加已输出字符做保守估算，规则与现有文本对话的中断结算一致。

**恢复去重：**
- `ai_agent_turn` 对 `(conversation_id, request_id)` 唯一。
- SDK 恢复或续跑同一轮时，复用已有的 turn 行与预扣，不新建预扣。
- 已终态的轮次不再结算。
- `chatRecovery` 写成类字段，`maxInterruptedAttempts` 设为 2。
- `shouldKeepRecovering` 按 `recoveryRootRequestId` 读取本轮已记录的消耗，超过预扣封顶就停止恢复并按检查点结算。

**兜底：** jobs 注册 `agentTurnHoldSweeper`（插件 jobs 入口导出），对预扣过期但仍为 running 的轮次按检查点结算，规则与 `chatHoldSweeper` 一致。它复用现有清理 Cron，不新增定时任务。

### 4. 工具契约与注册

`packages/ai/src/agents/tool.ts`（与业务无关，只依赖 zod 与 ai 类型）：

```ts
defineAgentTool({
  name: 'generate_image',            // snake_case，全局唯一
  description: '…',
  input: z.object({ … }),
  needsApproval?: boolean | ((input) => boolean),
  execute(input, ctx): Promise<Output>,
})
```

`ctx` 的类型在 `packages/ai` 中只声明为接口：`workspaceId`、`userId`、`conversationId`、`signal`、`log`，以及业务侧注入的 `db` 与 `services`（泛型）。具体实现由 agents 插件提供：

- `db` 为请求级客户端，工具内部必须用 `scoped(db, workspaceId)`；
- `services` 包含按需提供的能力，例如创建媒体任务。

**工具来源：**
- agents 插件内置示例：`current_time`；`list_workspace_files` 只读，按空间过滤，只返回文件名、类型与大小。
- 项目自有：`plugins/agents/src/tools.project.ts`。
- 其他插件：web 入口导出 `agentTools`，由 `plugins.gen.ts` 汇总。

工具名冲突时构建失败（生成时检查）。

**幂等：** 恢复可能让同一工具调用执行两次。`ctx` 提供 `idempotencyKey`（轮次 id + 工具调用 id）；有副作用的工具必须以它查重，已执行过就返回已有结果。媒体任务提交按此键去重。只读工具不受此限。

**Agent 定义：** 写在 `plugins/agents/src/agents.project.ts`（项目自有，template-sync 不覆盖）。

```ts
defineAgent({
  id, name, description,
  systemPrompt(ctx),
  defaultModel?,
  tools: ['current_time', …],
  maxSteps?,
})
```

模板提供示例 agent `assistant`。用户在界面上选择 agent，同一对话的 agent 固定。

### 5. 人工确认

工具 `needsApproval` 映射到 SDK 的工具确认。暂停期间：

- 预扣保持不变。等待确认的轮次不受恢复预算限制（SDK 行为）；但预扣会到期，到期前没有确认的，由清理器按检查点结算，并把该工具调用标记为过期。
- 用户批准后继续执行；拒绝时把拒绝结果交给模型，同一轮继续。

确认卡片由插件 web 入口注册到消息部件渲染器。

### 6. 数据模型

迁移（`packages/db`，共用迁移链）：

- `ai_conversation` 新增 `kind text not null default 'chat'`（`chat | agent`）、`agent_id text null`，加检查约束 `kind = 'agent'` ⇔ `agent_id is not null`。现有对话列表查询加 `kind = 'chat'` 条件，避免 agent 对话混入。
- `ai_model` 新增 `supports_tools boolean not null default false`，后台模型编辑器可切换。
- 新表 `ai_agent_turn`，记录每一轮的审计与结算信息，不存消息正文：
  - `id`、`workspace_id`、`user_id`、`conversation_id`、`request_id`
  - `model_key`、`pricing` 快照、`hold_id`
  - `status`（running / completed / stopped / failed / expired）
  - `usage_checkpoint`、`usage`、`credits_charged`、`steps`
  - `tool_calls`：只记工具名、状态与耗时，不记参数与输出
  - `error_code`、时间戳
  - 唯一约束 `(conversation_id, request_id)`，索引 `(workspace_id, user_id, id desc)`
- `credit_hold.ref_type` TS 枚举加 `agent_turn`（列本身是 text，不需要改列）。

消息正文只存在实例中：

- 好处：避免双写；续流与恢复全由 SDK 负责。
- 代价：后台无法用 SQL 查消息内容。这符合「内容只对创建者可见」，排查依靠 `ai_agent_turn` 与日志。
- 备份（使用者决定，2026-11-24）：首版不把消息镜像到 Postgres 或 R2。agent 对话内容不在数据库备份恢复范围内，单个实例只有 Cloudflare 提供的 30 天时间点恢复，没有批量导出。`docs/06-ai.md` 写明这一点；以后需要时另起 change 加每轮镜像。
- 每轮开始时更新 `ai_conversation.updated_at`，供列表排序与保留期判断。

### 7. 删除与清理

- **用户删除对话：** web 先在 PG 软删（`archived` 改为删除标记沿用现有字段语义；若现有删除是硬删则同样硬删），再通过 Durable Object 绑定调用实例的清理方法（`destroy`），清空实例存储。
- **删号、删空间：** 现有 AI 内容清理在 jobs 中执行。jobs 增加指向 web 类的 Durable Object 绑定（wrangler `script_name`），逐个调用实例清理，再删 PG 的 turn 与对话行；清理幂等，可重试。
- **保留上限：** `maxPersistedMessages` 取 `plugins.agents.maxPersistedMessages`（默认 200）。
- **保留期（使用者决定，2026-11-24）：** 配置项 `plugins.agents.retentionDays`，默认不设置（关闭）。开启后由插件 jobs 入口注册的清理器在现有清理 Cron 中执行：按 `updated_at` 找出超期且没有 running 轮次的 agent 对话，每次处理有上限的一批，按用户删除对话的同一流程清实例、删行。未开启时清理器直接返回，不查库，符合 Neon 成本基线。

### 8. 异步工具结果

长任务工具（媒体）返回 `{ taskId, status: 'pending' }`，并在任务 `input` 中记录 `agentConversationId`。媒体 Workflow 完成通知时，如果有这个字段，就通过 jobs 的 Durable Object 绑定调用实例方法 `onTaskDone(taskId, result)`，实例用 `saveMessages` 写入结果部件。

是否让模型在结果写回后自动继续一轮，由工具声明，默认不继续，避免无人值守的消耗。本组依赖 `media` 插件，`media` 未启用时不注册相关工具。

### 9. 前端

- 路由：`app/$slug/agents/index.tsx`（列表与新建，选择 agent 与模型）、`app/$slug/agents/$conversationId.tsx`（对话）。
- 对话页用 `@cloudflare/ai-chat/react` 的 `useAgentChat`，消息部件复用现有渲染与工具渲染注册；工具调用展示状态（运行中、完成、失败、等待确认），确认卡片提供批准与拒绝。
- 新页面先经 `ui-design` 产出设计稿，得到使用者确认后再实现。
- 错误码（余额不足、欠费、模型不可用、限流）复用现有对话的提示与充值入口。

### 10. SDK 隔离与版本

- `agents`、`@cloudflare/ai-chat` 精确锁定版本。
- SDK 类与钩子只出现在 `plugins/agents/src/worker/`，计费、权限与工具执行写成与 SDK 无关的函数并单测；升级 SDK 时只改 worker 目录的适配层。
- 不使用 `@callable` 等装饰器，因此不需要 `agents/vite` 插件（也避开它在 pnpm 下的已知问题），tsconfig 不开启 `experimentalDecorators`。实例方法（清理、`onTaskDone`）经 Durable Object RPC 调用。
- 升级 SDK 时阅读 CHANGELOG，并回归「流式进行中部署」；SDK 的存储迁移不可回滚，升级按单向操作规划。
- 不使用 SDK 的 workflows 表与调度；长任务继续走 jobs 中的 Workflow。

### 11. 多租户与存储规范

- 租户相关状态只放实例字段或实例存储，不放模块级变量：同类实例可能共用 isolate，模块级变量跨租户可见。
- 实例名只用 PG 中的对话 UUIDv7；所有访问经决策 2 的前置处理，实例再比对归属。
- 清理与枚举以 PG 对话表为唯一依据（Cloudflare 只能按 id 列出实例）。实例删除用 `deleteAll()`。
- 不设置司法辖区与位置提示；需要数据驻留的衍生项目另起 change。
- 以上写入 `docs/06-ai.md` 的工具编写规范，并加入 `security-scan` 检查清单。

### 12. 部署形态：Durable Object 放在 web Worker

使用者决定（2026-11-24）：Durable Object 类由 web Worker 导出（经 `plugins.worker.gen.ts`），不单独建 agents Worker，也不跨项目共用。

- 前置处理、会话、数据库、限流等绑定直接复用 web 的。
- jobs 通过带 `script_name` 的 Durable Object 绑定调用实例（删除清理、异步结果写回），与现有 web 调用 jobs Workflow 的方式对称。
- 每次 web 部署时，活跃实例最多继续运行旧代码 300 秒；已休眠的 WebSocket 跨部署保留，进行中的流由 SDK 恢复（计费按决策 3 处理）。
- 实例数据跟随定义它的 Worker，上线后再改放法无法迁移旧对话。若以后改为独立 Worker，需另起 change 并接受旧对话不迁移或自写迁移。

## Risks / Trade-offs

- [SDK 未到 1.0，近半年 minor 多带破坏性变更] → 锁版本、适配层隔离；第 1 组先用 spike 确认 chat agent 在 TanStack Start 的 Worker 入口中可用、用量可取、恢复行为可控。若 chat agent 不可用，退回「Agent 基类 + 自写 `streamText` + SDK 的 fiber 与续流」。长期备选为 `PiHarness`（pi-durable），切换触发条件见 `research.md` §6；工具契约与 SDK 无关，切换时保留。
- [恢复时重放模型调用导致重复计费] → turn 行唯一约束 + 复用预扣 + 按检查点封顶；集成测试模拟恢复。
- [Durable Object 与 Postgres 的一致性（PG 删了，实例还在）] → 删除先改 PG 再清实例，清理幂等可重试；实例在每轮开始时校验 PG 对话仍存在，不存在则拒绝并自清理。
- [恢复导致工具重复执行] → 决策 4 的幂等键；集成测试模拟恢复后同一工具调用只产生一次副作用。
- [消息不在 PG 备份内] → 决策 6 已接受，文档写明。
- [工具越权访问其他空间数据] → `ctx.db` 只提供 `scoped` 入口；示例工具与工具编写规范要求按空间过滤；`security-scan` 检查清单加入 agent 工具。
- [提示注入让模型调用敏感工具] → 有副作用的工具默认需要确认；工具只能调用 agent 定义里列出的那些。
- [本地开发与测试] → Cloudflare Vite 插件支持 Durable Object；模型使用现有测试替身 / 录制夹具，不在 CI 中真实调用。

## Migration Plan

- 新增迁移只加列和表，默认值保证现有数据不变。
- 未启用 `agents` 的项目会得到空表与默认列，没有行为变化。
- 启用时，在 web wrangler 各环境加入 Durable Object 绑定与 SQLite 类声明，在 jobs 各环境加入指向 web 类的绑定；`check-plugins` 会给出缺失项。
- 回滚：停用插件并删除绑定。Durable Object 类删除需要 wrangler 的删除迁移，会清空所有实例数据，所以文档写明这个后果，并要求先确认。

## Open Questions

- 用户删除对话的现有语义是归档还是硬删：实施时以现有对话行为为准，并在 PR 中说明。这不改变本设计的对外行为。
