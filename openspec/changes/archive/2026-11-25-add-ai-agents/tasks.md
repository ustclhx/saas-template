## 1. 技术验证（依赖 add-plugin-system 第 3 组合并后进行）

- [x] 1.1 spike：在 `plugins/agents` 中用精确锁定的 `agents` / `@cloudflare/ai-chat` 实现一个最小 chat agent，经 `plugins.worker.gen.ts` 导出、fetch 前置处理接管 `/agents/*`；确认 TanStack Start Worker 入口、Cloudflare Vite 插件 dev 与 `pnpm build` 均可用，不引入 `agents/vite`、不用装饰器、tsconfig 不开 `experimentalDecorators`；jobs 经 `script_name` 绑定能 RPC 调用 web 中的实例（已验证后放弃该路径，见 design 决策 12）。把结论写进 design.md「验证结果」
- [x] 1.2 spike：在 `onChatMessage` 内自调 `streamText`（tools + `stopWhen` + `onStepFinish` / `onFinish`）能拿到逐步与总用量；用 `wrangler dev` 下强制重启实例，记录恢复时的 `requestId` 与模型调用重放行为、`needsApproval` 暂停期间的状态。确认 `maxInterruptedAttempts` 与 `shouldKeepRecovering` 生效。若 chat agent 不满足，按 design 风险项切到 Agent 基类方案并在 PR 说明

## 2. 契约、数据与配置

- [x] 2.1 `packages/ai/src/agents/tool.ts`：`defineAgentTool`、工具上下文接口（含 `idempotencyKey`）、输入 schema 到 AI SDK tool 的转换；名称格式校验。单元测试
- [x] 2.2 迁移：`ai_conversation.kind` / `agent_id` 与检查约束、`ai_model.supports_tools`、`ai_agent_turn` 表与索引；`credit_hold.ref_type` 加 `agent_turn`；现有对话列表查询加 `kind = 'chat'`。迁移在本地 PG 应用，现有对话集成测试通过；`docs/03-data-model.md` 更新
- [x] 2.3 `plugins/agents` 清单：targets `['cloudflare']`、requires billing+credits、bindings（web Durable Object + SQLite 类；jobs 不绑定，见 design 决策 12）；配置段 `maxSteps`（默认 8）、`maxTurnCredits`、`maxPersistedMessages`（默认 200）、`retentionDays`（默认不设置即关闭）、`defaultAgent`。模板 `template.config.ts` 启用并补齐 web wrangler 各环境绑定，`pnpm check` 通过
- [x] 2.4 后台模型编辑器增加「支持工具调用」开关，`requireAvailableModel` 增加按能力过滤；种子数据为已知支持工具的模型打标。单元测试与后台页组件测试

## 3. 身份与路由

- [x] 3.1 fetch 前置处理：剥离 `x-saas-*`、会话校验（401）、对话归属与成员资格查询（404）、写入身份头转发；单元测试覆盖未登录、他人对话、已退出空间、伪造头
- [x] 3.2 实例侧：首次记住归属，之后逐请求比对（403 + 安全日志）；PG 对话不存在时拒绝并自清理。单元测试

## 4. 执行与计费

- [x] 4.1 与 SDK 无关的轮次服务：调用前检查（成员资格、模型权益与工具能力、限流、欠费、余额）、建 turn 行与预扣（单步预算 × maxSteps，按 `maxTurnCredits` 封顶）、按 `(conversation_id, request_id)` 复用。集成测试覆盖各拒绝分支与重复请求不重复预扣
- [x] 4.2 结算：完成按 `totalUsage` 与定价快照 capture；停止 / 中断按检查点，被驱逐调用的用量按检查点加已输出字符保守估算；无可见输出失败按 `failedReplyRefund`；超额容忍与欠费复用 credits。集成测试逐分支核对账本金额
- [x] 4.3 实例适配层：`onChatMessage` 组装 agent 定义、工具集、`streamText`（abortSignal 透传、`onStepFinish` 写检查点）；`chatRecovery` 类字段（`maxInterruptedAttempts` 2，`shouldKeepRecovering` 按预扣封顶停止恢复）；每轮更新 `ai_conversation.updated_at`；租户状态不放模块级变量。用测试替身模型跑多步工具与恢复场景的集成测试
- [x] 4.4 `agentTurnHoldSweeper` 经插件 jobs 入口注册到现有清理 Cron，只操作 PG：过期 running 轮次按检查点结算并标记 `expired`；实例下次唤醒时清除已终态的开放轮次，并把等待确认中的调用标记过期。集成测试
- [x] 4.5 日志与 Sentry：每轮结构化日志（turnId、步数、工具名、耗时、积分，不记内容），Durable Object 中的错误上报 Sentry；单元测试确认日志不含消息与工具参数

## 5. 工具与 agent 定义

- [x] 5.1 工具注册汇总：内置示例、`tools.project.ts`、其他插件 `agentTools`；重名在生成时失败。agent 只能调用其定义列出的工具；有副作用的工具按 `idempotencyKey` 去重，集成测试模拟恢复后只产生一次副作用
- [x] 5.2 示例工具 `current_time`、`list_workspace_files`（`scoped` 查询，只返回名称、类型、大小）与示例 agent `assistant`（`agents.project.ts`）；把 `agents.project.ts`、`tools.project.ts` 登记为 template-sync 项目自有文件。跨空间隔离的集成测试
- [x] 5.3 人工确认：`needsApproval` 映射、拒绝结果回给模型、确认超时处理。集成测试覆盖批准、拒绝、超时

## 6. 界面（新页面，先设计确认）

- [x] 6.1 经 `ui-design` 产出 agent 列表页与对话页设计稿（含工具调用状态、确认卡片、错误与空状态、移动端），取得使用者确认并登记原型索引
- [x] 6.2 实现 `app/$slug/agents/index.tsx` 与 `$conversationId.tsx`：新建（选 agent 与模型）、列表、删除、`useAgentChat` 对话、停止、续流；工具与确认卡片注册到消息部件渲染器；导航入口经插件扩展点；文案进插件 `messages/`。组件测试与 `pnpm check`（含 UI 规范检查）通过
- [x] 6.3 e2e（本地，测试替身模型）：创建对话 → 多步工具 → 确认卡片批准与拒绝 → 停止 → 刷新续流 → 余额不足提示；他人访问 404。证据写入 `EVIDENCE_DIR`

## 7. 删除与清理

- [x] 7.1 用户删除对话：按现有对话删除语义处理 PG 行，并调用实例清理；集成测试确认之后连接返回 404
- [x] 7.2 删号 / 删空间清理接入：删号由 web 经 `packages/auth` 的 `deletionSteps` 注册清理 step，删 turn 与对话行后逐个调用实例 `deleteAll()`；删团队空间按保留期保留，期满由 jobs 过期空间清理先删 turn 再删对话、实例由 alarm 清理；幂等、失败可重试。实例 alarm 自清理兜底：空闲时按「最近活动 + min(retentionDays, 30) 天」设置 alarm，到期查 PG，对话不存在则 `deleteAll()`，否则顺延。集成测试覆盖部分失败重试与 alarm 自清理
- [x] 7.3 保留期清理：由实例 alarm 执行（不需要 jobs 清理器、不新增 Cron）；未设置 `retentionDays` 时 alarm 只检查对话是否存在；开启后对话超出保留期且无 running 轮次时按 7.1 流程删 PG 行并 `deleteAll()`，否则顺延 alarm。集成测试覆盖关闭、超期、跳过执行中三种情况

## 8. 异步工具结果（依赖 media 插件）

- [x] 8.1 `generate_image` / `generate_video` 工具由 media 插件的 `agentTools` 提供（agents 未启用时不导出），提交任务后返回含 `taskId` 的 pending 结果（媒体任务不记录 agent 信息，结果由实例拉取，见 8.2）
- [x] 8.2 实例拉取任务状态：记录待完成 `taskId`，用实例 alarm 退避轮询 PG 中 `ai_task`（5 秒起、上限 60 秒、任务超时后停止），客户端连接或新一轮开始时立即检查；终态时用 `saveMessages` 写入结果部件，默认不自动续轮。媒体 Workflow 不需要知道 agent。集成测试确认无新增模型费用

## 9. 文档与验收

- [x] 9.1 文档：`docs/06-ai.md` 新增 agent 章节（架构与部署形态、每轮流程、计费、工具编写规范与空间隔离 / 幂等 / 不用模块级状态要求、确认、删除与保留期、消息不在 PG 备份范围内、SDK 升级流程）；`docs/plugins.md` 登记 agents；`security-scan` 技能检查清单加入 agent 工具、身份头与模块级租户状态；`add-ai-model` 技能说明工具调用标记；`docs/08-roadmap.md` 更新
- [x] 9.2 生成器验证：`--plugins agents` 的 CF 副本通过 check、typecheck、test、build；`--target selfhost --plugins agents` 被拒绝；selfhost 构建产物不含 agents 代码
- [x] 9.3 staging 验收（需真实 LLM 凭据）：真实模型多步工具、确认、停止、续流、余额不足、账本核对、删除对话后实例数据清除；证据写入私有证据库。未执行时在 PR 中标为未完成验收
