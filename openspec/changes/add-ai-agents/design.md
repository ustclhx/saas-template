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
- 依赖 `add-plugin-system` 提供的扩展点：Worker 导出、fetch 前置处理、jobs 积分预扣清理器（只操作 PG）、消息部件渲染器、仅 Cloudflare 目标。

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
  → 实例存储记录「当前开放轮次」{ turnId, rootRequestId, holdId, userMessageId }
  → streamText({ tools, stopWhen: stepCountIs(maxSteps), abortSignal, onStepEnd, onEnd })
      onStepEnd：累计用量写入 turn.usage_checkpoint
      onEnd：最后一步停在等待确认 → 不结算（决策 5）；
             否则按定价快照计算实际积分 → capture → turn.status=completed → 清除开放轮次
  → 停止或中断：按最后检查点结算（与文本 settleInterrupted 同规则）
  → 出错且没有可见输出：按现有 failedReplyRefund 规则 release
```

- 预扣额 = 单步预算 × `maxSteps`，并以 `plugins.agents.maxTurnCredits` 封顶；单步预算沿用 `planTextBudget`。
- 单次运行内同样按预扣封顶：`streamText` 的 `stopWhen` 除步数上限外，还在「已用量 + 下一步保守估算（上一步输入加输出与工具结果增长、输出按单步上限）」超过预扣额时停止，不再开始下一步；续轮开始时的封顶检查保留。
- 一轮的实际消耗超过预扣时，走现有超额容忍与欠费规则。
- 定价快照写在 turn 行上，结算只读这份快照，规则同文本对话。

取得用量的方式：在 `onChatMessage` 内自己调用 `streamText`，用 AI SDK 的 `onStepEnd` / `onEnd`（ai 7 中 `onStepFinish` / `onFinish` 的新名称）拿 `usage` 与 `totalUsage`，不依赖 SDK 的回调。第 1 组已验证这条路径与恢复时的重放行为（见「验证结果」）。

计费只信自己的账本：被驱逐的那次模型调用拿不到用量，按最后检查点加已输出字符做保守估算，规则与现有文本对话的中断结算一致。

**恢复去重（按 1.2 验证结果修订）：** SDK 的续轮（确认后、恢复后）都使用服务端新生成的 `requestId`，`retry` 类恢复的 `continuation` 还是 false，所以不能用 `requestId` 识别同一轮。
- 按实例存储中的「当前开放轮次」匹配 turn 行：`onChatMessage` 开始时如果存在开放轮次，且没有新的用户消息（最后一条用户消息的 id 等于开放轮次的 `userMessageId`），就复用该 turn 行与预扣，不新建预扣；有新的用户消息时才建新的一轮。
- `ai_agent_turn` 对 `(conversation_id, request_id)` 唯一，`request_id` 取首轮的客户端 id（等于恢复钩子中的 `recoveryRootRequestId`），作为重复建行的最后防线。
- 已终态的轮次不再结算；结算后清除开放轮次。
- **每次续跑开始时检查预扣封顶**：复用开放轮次的续轮在调用模型前比较已记录消耗（检查点加被驱逐调用的估算）与预扣封顶，超过即按检查点结算、清除开放轮次并不再调用模型。
- `chatRecovery` 写成类字段，`maxInterruptedAttempts` 设为 2；`shouldKeepRecovering` 按 `recoveryRootRequestId` 做同样的封顶判断，只作补充（它从第 2 次恢复才调用，见「验证结果」）；`onExhausted` 按检查点结算。

**兜底：** jobs 注册 `agentTurnHoldSweeper`（插件 jobs 入口导出），对预扣过期但仍为 running 的轮次按检查点结算，规则与 `chatHoldSweeper` 一致。它复用现有清理 Cron，不新增定时任务，**只操作 PG**，不访问实例（jobs 不持有 Durable Object 绑定，见决策 12）。实例下次被唤醒时发现开放轮次在 PG 中已是终态，直接清除开放轮次。

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

- SDK 行为（1.2 验证）：模型请求确认后本次流即结束，`onEnd` 触发，消息以 `approval-requested` 持久化；没有进行中的 fiber，不消耗恢复预算，实例可休眠。
- **等待确认期间不结算**：`onEnd` 时最后一步停在等待确认，turn 保持 running，预扣不动，开放轮次保留。
- 用户批准或拒绝后，SDK 以新的 `requestId` 发起续轮；续轮按决策 3 复用开放轮次与预扣，并先做封顶检查。批准时执行工具；拒绝时工具不执行，拒绝结果（`output-denied`）交给模型，同一轮继续，在续轮的 `onEnd` 结算。
- 预扣会到期：到期前没有确认的，由 `agentTurnHoldSweeper` 在 PG 中按检查点结算并标记过期；实例下次唤醒时清除开放轮次，并把该工具调用标记为过期。

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

所有实例操作都在 web 内发生（jobs 不持有 Durable Object 绑定，见决策 12）。清理与枚举以 PG 对话表为唯一依据。

- **用户删除对话：** web 先按现有对话删除语义处理 PG 行（软删沿用现有字段语义；若现有删除是硬删则同样硬删），再经 web 的 Durable Object 绑定调用实例清理方法（`deleteAll()` 清空实例存储）。实例调用失败不回滚 PG，由下面的 alarm 自清理兜底。
- **删号、删空间：** 删号沿用 `packages/auth` 的 `deletionSteps`：web 注册一个清理 agent 实例的 step，按 PG 对话表逐个调用实例 `deleteAll()`，再删 PG 的 turn 与对话行；幂等，可重试，单个实例失败不阻塞其余数据的清理。删空间同样在 web 执行；若空间数据由其他流程（例如 jobs 的保留期清理）直接删除 PG 行，实例由 alarm 自清理。
- **alarm 自清理（兜底）：** 每个实例在空闲时（一轮结束且没有开放轮次）用 SDK 的 `schedule` 设置一次 alarm，下次检查时间 = 最近活动 + min(`retentionDays`, 30) 天（未设置保留期时为 30 天）。到期时查 PG：
  - 对话不存在 → `deleteAll()` 自清理；
  - 对话存在且已超出保留期（`retentionDays` 已设置、`updated_at` 早于期限、没有 running 轮次）→ 按用户删除对话的流程删 PG 行并 `deleteAll()`；
  - 否则顺延 alarm。
  删除失败因此总有自愈路径，且只有存在过的实例才会被唤醒，没有全表扫描。1.2 补充验证确认 alarm 在 `wrangler dev` 下可触发，且进程重启后无请求也会触发。
- **保留上限：** `maxPersistedMessages` 取 `plugins.agents.maxPersistedMessages`（默认 200）。
- **保留期（使用者决定，2026-11-24）：** 配置项 `plugins.agents.retentionDays`，默认不设置（关闭）。开启后由上面的实例 alarm 执行，不需要 jobs 清理器，也不新增 Cron；未开启时 alarm 只检查对话是否存在。每个实例最多每 30 天查一次 PG，空闲实例不产生持续的数据库访问，符合 Neon 成本基线。

### 8. 异步工具结果

长任务工具（媒体）返回 `{ taskId, status: 'pending' }`。结果由**实例拉取**，jobs 的媒体 Workflow 不需要知道 agent：

- 实例在存储中记录待完成的 `taskId`（含提交时间）。
- 存在待完成任务时，用 SDK 的 `schedule`（实例 alarm）退避轮询 PG 中 `ai_task` 的状态：5 秒起、逐次加倍、上限 60 秒；超过任务超时时间后停止轮询，并写入超时结果。
- 客户端连接或新一轮开始时也立即检查一次。
- 任务到终态（成功或失败）时，实例用 `saveMessages` 写入结果部件，并移除该 `taskId`；没有待完成任务时不再设置轮询 alarm（只保留决策 7 的空闲 alarm）。

是否让模型在结果写回后自动继续一轮，由工具声明，默认不继续，避免无人值守的消耗。本组依赖 `media` 插件，`media` 未启用时不注册相关工具。

### 9. 前端

- 路由：`app/$slug/agents/index.tsx`（列表与新建，选择 agent 与模型）、`app/$slug/agents/$conversationId.tsx`（对话）。
- 对话页用 `@cloudflare/ai-chat/react` 的 `useAgentChat`，消息部件复用现有渲染与工具渲染注册；工具调用展示状态（运行中、完成、失败、等待确认），确认卡片提供批准与拒绝。
- 设计稿已确认（2026-11-24）：见 `docs/design-system/prototypes/README.md` 的「Agent 列表与新建」「Agent 对话页」两行，副本在 `docs/design-system/prototypes/agents/`。
- 错误码（余额不足、欠费、模型不可用、限流）复用现有对话的提示与充值入口。

### 10. SDK 隔离与版本

- `agents`、`@cloudflare/ai-chat` 精确锁定版本。
- SDK 类与钩子只出现在 `plugins/agents/src/worker/`，计费、权限与工具执行写成与 SDK 无关的函数并单测；升级 SDK 时只改 worker 目录的适配层。
- 不使用 `@callable` 等装饰器，因此不需要 `agents/vite` 插件（也避开它在 pnpm 下的已知问题），tsconfig 不开启 `experimentalDecorators`。实例清理方法由 web 经 Durable Object RPC 调用；异步任务结果由实例自己拉取（决策 8）。
- 升级 SDK 时阅读 CHANGELOG，并回归「流式进行中部署」；SDK 的存储迁移不可回滚，升级按单向操作规划。
- 不使用 SDK 的 workflows 表；SDK 的 `schedule` 只用于实例自身的 alarm（决策 7 的自清理与保留期、决策 8 的任务轮询）；长任务继续走 jobs 中的 Workflow。

### 11. 多租户与存储规范

- 租户相关状态只放实例字段或实例存储，不放模块级变量：同类实例可能共用 isolate，模块级变量跨租户可见。
- 实例名只用 PG 中的对话 UUIDv7；所有访问经决策 2 的前置处理，实例再比对归属。
- 清理与枚举以 PG 对话表为唯一依据（Cloudflare 只能按 id 列出实例）。实例删除用 `deleteAll()`。
- 不设置司法辖区与位置提示；需要数据驻留的衍生项目另起 change。
- 以上写入 `docs/06-ai.md` 的工具编写规范，并加入 `security-scan` 检查清单。

### 12. 部署形态：Durable Object 放在 web Worker

使用者决定（2026-11-24）：Durable Object 类由 web Worker 导出（经 `plugins.worker.gen.ts`），不单独建 agents Worker，也不跨项目共用。

- 前置处理、会话、数据库、限流等绑定直接复用 web 的。
- **jobs 不持有 Durable Object 绑定**（协调者决定，2026-11-24）：web 已经按 `script_name` 绑定 jobs 的 Workflow（jobs 必须先部署）；若 jobs 再按 `script_name` 绑定 web 的类，两个 Worker 互相依赖，新生成项目的首次部署在任何顺序下都可能失败。所以所有实例操作只在 web 内发生：删除清理由 web 调用（决策 7），异步结果由实例拉取（决策 8），保留期与兜底清理由实例 alarm 执行。jobs 只处理 PG（`agentTurnHoldSweeper`）。
- 每次 web 部署时，活跃实例最多继续运行旧代码 300 秒；已休眠的 WebSocket 跨部署保留，进行中的流由 SDK 恢复（计费按决策 3 处理）。
- 实例数据跟随定义它的 Worker，上线后再改放法无法迁移旧对话。若以后改为独立 Worker，需另起 change 并接受旧对话不迁移或自写迁移。

## 验证结果（1.1 / 1.2，2026-11-24）

结论：`AIChatAgent` 满足需要，**不切换**到「Agent 基类 + 自写 `streamText`」方案。最小实现留在 `plugins/agents/src/worker/`（`agent.ts`、脚本化测试模型 `spike-model.ts`），作为 4.3 的雏形；身份、计费与 agent 定义用 `TODO(3.x/4.x)` 标出边界。在 3.1 完成前，前置处理只在 `SENTRY_ENVIRONMENT=development`（本地）放行 `/agents/*`，staging / production 一律 404。

验证用脚本化模型（固定用量：每次调用输入 100 token，工具步输出 10、文本步输出 20 个块），不调用真实 LLM。驱逐用开发专用端点调用 `ctx.abort()` 模拟，另做一次「流式进行中结束 `wrangler dev` 进程再用同一 `--persist-to` 重启」。

### 1.1 入口、路由、构建与 RPC

- **Worker 导出**：`plugins.worker.gen.ts` 对 worker 入口 `export *`，`AgentConversation` 出现在 `dist/server/index.js`；构建后的 `dist/server/wrangler.json` 带 Durable Object 绑定与 `agents-v1` 迁移。没有用装饰器、`agents/vite`，tsconfig 没开 `experimentalDecorators`。
- **前置处理**：只匹配 `/agents/`，调用 `routeAgentRequest`。URL 为 `/agents/agent-conversation/<conversationId>`（绑定 `AGENT_CONVERSATION` 转成 kebab-case）。
  - `routeAgentRequest` 会把 env 中**所有** Durable Object 绑定按 kebab-case 名暴露出来，所以只传入 `{ AGENT_CONVERSATION }`。以后 web 增加其他 Durable Object 时，它们也不会被路由到。
  - SDK 自带 HTTP 端点 `…/<id>/get-messages`，会返回全部消息。3.1 的身份校验必须同时覆盖 `onBeforeConnect`（WebSocket）与 `onBeforeRequest`（HTTP）；3.2 的实例侧比对也要同时覆盖两条路径。
- **WebSocket 101 透传**：日志记一行 `http.request status=101`。外层包装原样返回 101，客户端收到 `cf_agent_identity` 与后续帧。
  - 核心改动：`apps/web/src/server.ts` 遇到 WebSocket 升级请求时不再先查 `ASSETS`。原因是本地 dev 中 `ASSETS` 是 Vite 的 Node 服务，升级请求会让 miniflare 的 loopback 断言失败，整个 dev 进程退出。
- **dev 与构建**：
  - `vite dev`（Cloudflare Vite 插件）下，HTTP 与 WebSocket 对话、工具步、续流都正常。
  - `pnpm --filter @saas/web build`（含预渲染）通过。
  - `wrangler dev -c apps/web/dist/server/wrangler.json` 运行构建产物时行为相同。
  - 注意：本 worktree 的 dev 服务器运行时，预渲染会因为 inspector 端口被占用而报 `Failed to fetch /: Internal Server Error`。这是本地端口冲突，与插件无关。
- **jobs 经 `script_name` RPC（已放弃该路径）**：验证时 jobs 可以用 `env.AGENT_CONVERSATION.getByName(id).method()` 调用 web 中的实例（同一 workerd 中，`wrangler dev -c apps/jobs/wrangler.jsonc -c apps/web/dist/server/wrangler.json`）；分进程经 dev registry 时 Agent 抛出「could not determine its Durable Object name」，因为跨进程代理没有带上 `ctx.id.name`。
  - 但 web 已经按 `script_name` 绑定 jobs 的 Workflow，jobs 再绑定 web 的类会让两个 Worker 互相依赖，新项目首次部署在任何顺序下都可能失败（现有部署流程先部署 jobs，此时 web 中还没有该类）。协调者决定 jobs 不持有该绑定，所有实例操作只在 web 内发生（决策 7、8、12）。清单与 wrangler 只在 web 声明绑定。
- **实例 alarm（补充验证）**：用 SDK 的 `this.schedule(秒数, 'method', payload)` 安排回调。在 `wrangler dev`（构建产物，`--persist-to`）中：
  - 5 秒的 alarm 约 4.7 秒后触发；
  - 安排 20 秒的 alarm 后立即结束并重启进程，重启后没有任何请求，alarm 仍在约 22.7 秒时触发。
  决策 7 的自清理、保留期与决策 8 的任务轮询按此实现。注意 `Agent` 自己占用 `alarm()`（调度与 fiber 恢复），不要覆盖它，统一用 `schedule`。
- **selfhost**：web Node 构建与 jobs `build:node` 打印「插件 agents 仅支持 Cloudflare，selfhost（Node）构建已排除」。
  - `check-artifacts.mjs --absent AgentConversation cf_agent_use_chat_request plugins/agents spike-scripted --only web-node,jobs-node` 全部 0 处。
  - Cloudflare jobs 产物与 web 客户端产物中也没有 agents 代码。
- **依赖**：`agents` 0.34.0 经 `mimetext` 带入 `core-js-pure`（postinstall 只打印赞助信息），已在 `allowBuilds` 中设为 false。

### 1.2 用量、requestId、重放与确认

- **用量**：`onChatMessage` 内自调 `streamText`（tools + `stopWhen: stepCountIs(maxSteps)`）可以拿到用量。
  - ai 7 中 `onStepFinish` / `onFinish` 已标为弃用，改用同义的 `onStepEnd` / `onEnd`。
  - `onStepEnd` 给出逐步用量（工具步 100/10、文本步 100/20），`onEnd` 的 `totalUsage` 为合计（200/30）。
  - 4.3 按此实现。注意 `@saas/shared/log` 会把名为 `messages` 的字段脱敏，日志字段改用 `messageCount`。
- **requestId**：只有用户发起的首轮使用客户端在 `cf_agent_use_chat_request` 中给出的 id。确认后的续轮与恢复都使用服务端新生成的 id，详情如下：

| 情形 | `requestId` | `continuation` |
|---|---|---|
| 用户消息 | 客户端 id | false |
| 批准 / 拒绝后的续轮 | 新 id | true |
| 恢复（已有部分输出，`continue`） | 新 id | true |
| 恢复（尚无可持久化输出，`retry`） | 新 id | **false** |

只有 `chatRecovery` 钩子（`shouldKeepRecovering` / `onExhausted`）中的 `recoveryRootRequestId` 等于首轮的客户端 id。
- **重放**：
  - 驱逐时已输出的部分会保留在 assistant 消息中，恢复后模型被**重新调用**，并接着写入同一条消息。被中断的那次调用拿不到 `onStepEnd`，用量丢失。这与决策 3「按检查点加已输出字符保守估算」的假设一致。
  - 恢复由实例的 alarm 触发，不需要客户端在线：`wrangler dev` 中约 30 秒后自动执行，进程重启后也会执行。有新请求唤醒实例时会立即执行。
- **`needsApproval` 暂停**：
  - 模型调用需确认的工具后，本次流随即结束：发出 `tool-approval-request`，`onEnd` 触发（只含第 1 步用量）。消息以 `approval-requested` 状态持久化。
  - 此时没有进行中的 fiber，不消耗恢复预算，实例可以休眠。
  - 批准后工具执行，模型在新的续轮中继续。拒绝时工具不执行，消息部件为 `output-denied`，模型照样继续回复。
- **`maxInterruptedAttempts: 2` 生效**：首轮与第 1 次恢复都被驱逐后，`onExhausted` 以 `reason = interrupted_attempts_exceeded`、`attempt = 2` 触发。模型共调用 2 次，之后不再恢复。
- **`shouldKeepRecovering` 生效**：它**不在**第 1 次恢复时调用，只从第 2 次恢复尝试起调用。
  - 因此在 `maxInterruptedAttempts: 2` 且每次都被驱逐时，次数上限会先封住本轮，钩子没有机会被调用。
  - 临时改为 5 并让钩子返回 false 后，第 2 次尝试时 `reason = recovery_aborted`，没有再调用模型。

**对第 3–5 组的影响（协调者已采纳，2026-11-24，已写入决策 3、5）：**

1. **恢复去重不能只靠 `(conversation_id, request_id)`**：续轮与恢复的 `requestId` 都会变，`retry` 恢复的 `continuation` 甚至为 false。
   - 建议：建 turn 行时把 `{ turnId, rootRequestId, holdId }` 记入实例存储，作为「未结算轮次」。
   - 之后的 `onChatMessage` 如果没有新的用户消息（最后一条用户消息的 id 与该轮相同），就复用这一轮与它的预扣；结算后清除记录。
   - `(conversation_id, request_id)` 唯一约束保留，用首轮的客户端 id（即 `recoveryRootRequestId`）。
2. **等待确认时不结算**：`onEnd` 时如果最后一步停在 `approval-requested`，turn 保持 running（或新增等待确认状态），预扣不动。批准或拒绝后的续轮复用同一轮，在续轮的 `onEnd` 结算。确认超时仍由 4.4 的清理器处理。
3. **封顶检查放在续轮开始时**：`shouldKeepRecovering` 在首次恢复与「每次都被驱逐」时不会调用。所以每个续轮在调用模型前都要比较已记录消耗与预扣封顶，超过即按检查点结算并不再调用模型。`shouldKeepRecovering` 只作为补充。

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
- 启用时，在 web wrangler 各环境加入 Durable Object 绑定，并在顶层加入 SQLite 类迁移（各环境继承）；jobs 不需要改动。`check-plugins` 会给出缺失项。
- 回滚：停用插件并删除绑定。Durable Object 类删除需要 wrangler 的删除迁移，会清空所有实例数据，所以文档写明这个后果，并要求先确认。

## Open Questions

- 用户删除对话的现有语义是归档还是硬删：实施时以现有对话行为为准，并在 PR 中说明。这不改变本设计的对外行为。
