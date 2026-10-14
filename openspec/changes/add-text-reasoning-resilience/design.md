# Design

## Context

见 proposal - Why。现状：`apps/web/src/features/ai/chat.ts` 单次 `streamText`，只依赖 AI SDK 默认 `maxRetries`（仅覆盖流开始前的请求错误）；onChunk、检查点、正文与 `hasOutput` 只看 `text-delta`；历史只取 completed/aborted；settle 在 `packages/ai/src/text/settle.ts`。`packages/ai/src/text/fault.ts`（#165）已演示统一 `reasoning: 'none'` 与 `providerOptions.deepseek.thinking` 可关闭 DeepSeek 思考。用户结算优先用服务商 usage，其 outputTokens 通常已含 reasoning。

## Goals / Non-Goals

**Goals:** 框架完整、口径正确、可扩展；DeepSeek 一个 Provider 跑通 thinking 映射、重试与续写。

**Non-Goals:** 其他 Provider 的 thinking/续写实现；thinking 单独定价或套餐门槛；指令式续写；Gateway 用量回查（chat 2.9）；reasoning 导出/检索。

## Decisions

### 1. 配置分层
- `template.config.ts`：`ai.text.thinking = { default: 'off' | 'on', userToggle: boolean }`、`ai.text.reasoning = { display: boolean }`、`ai.text.failedReplyRefund: 'no-visible-output' | 'all'`（默认前者）。模板默认：thinking off、userToggle false、display false。
- 模型 `params_schema['x-text']`：`thinking?: boolean`（支持与否，缺省 false）、`continuation?: 'native' | 'none'`（缺省 none）。后台保存沿用严格校验。
- 请求：`thinking?: boolean`，仅 `userToggle` 时接受，否则 400（与 strictObject 风格一致）。
- 备选：放 runtime settings —— 拒绝：这是产品形态决策，属模板层；运行时切换会使在途口径不一致。

### 2. Provider 能力接口
`packages/ai/src/text` 增加 `TextProviderCapabilities { applyThinking(params, on): params; continuation?: { buildPrefix(messages, partial): messages } }`，按 provider 注册；DeepSeek 实现 thinking 映射（统一 `reasoning` 参数 + `providerOptions.deepseek.thinking`）与前缀续写（DeepSeek “chat prefix completion”：末条 assistant 带 prefix 标记，需 beta 端点）。实施时先核实已安装 `@ai-sdk/deepseek` 是否支持 prefix；不支持时经自定义 fetch/body 转换实现；都不可行则 DeepSeek 也 `continuation: none` 并在 PR 中报告。其他 provider 返回默认（thinking 不变、无续写）。fault 包装的关闭思考改走同一接口。

### 3. 尝试编排（单回复多次上游调用）
```
attempt loop (same hold, same assistant message):
  phase A (no visible text yet): error | empty | reasoning-only | finish w/o text
       -> retry (max 2, backoff 1s/3s), emit data part {type:'retry', n}
  phase B (visible text emitted): stream error/abort-by-upstream
       -> continuation.native ? continue (max 2) with history + partial : fail
  user stop -> aborted (unchanged); platform timeout sweeper unchanged
```
- “可见正文”= 至少一个非空 `text-delta`。`finishReason=length` 有正文为 completed；仅 reasoning 进入 phase A 重试。
- 下发给客户端的是单一 UI 消息流：重试时下发 `data-retry` 让前端清空 reasoning 并显示“重试中”；续写的正文直接追加。
- 不对 `maxRetries` 叠加：每次 attempt `maxRetries: 0`，由编排统一计数，避免双重重试。
- 备选：用 AI SDK 中间件内部重试 —— 拒绝：需要跨 attempt 的 UI 信号与用量累计，编排层更清晰。

### 4. 用量与检查点
- usage 累计所有 attempt：`inputTokens`、`outputTokens`、`reasoningTokens`（新增，可选）。用户结算口径：
  - completed：用最终成功 attempt 的输入 + 全部可见正文所在 attempt 的输出（含其 reasoning）；被丢弃的 phase A attempt 成本由 SaaS 承担，记录在 usage 的 `absorbed` 统计（仅日志/JSON，不入账）。
  - failed 无正文：release 全额。failed 有正文：沿用现有错误结算（token 按已产生用量封顶 hold；per_call 收固定积分）；`failedReplyRefund='all'` 时 release。
- 检查点计入 reasoning delta 的估算 token（单独字段 `reasoningTokens`），并在 phase A 重试时重置该 attempt 的检查点贡献；回收器结算规则同上：检查点无正文 → release。
- 仅扩展 `AiUsageCheckpoint` 与 usage JSON 的 TS 类型，不改列。

### 5. reasoning 持久化与历史
- `display=true`：reasoning 存为 `{type:'reasoning', text}` part，仅最终 attempt 的 reasoning；前端折叠展示。`display=false`：不保存、不下发（流转换中过滤 reasoning 部件）。
- 历史构建：取 completed/aborted/failed，`messageText` 只拼接 text part，因此 reasoning 永不进入上下文。
- API key completions：过滤 reasoning，不返回 `reasoning_content`。

## Risks / Trade-offs

- [DeepSeek 前缀续写为 beta/需特殊端点] → 能力探测失败即降级 `none`，不影响主流程。
- [重试拉长首字延迟] → 次数与退避固定且小；超出 hold 截止时间不再重试。
- [SaaS 承担丢弃 attempt 成本] → 日志记录 absorbed 用量，便于运营监控；次数上限控制最坏成本 3x。
- [failed 正文进入历史可能带不完整句子] → 可接受；用户可见内容与模型上下文一致更重要。
- [前端在 reasoning 隐藏时仍可能收到 reasoning] → 服务端过滤，测试覆盖。

## Migration Plan

无迁移。默认 thinking off 会改变现有 deepseek 模型的默认行为（当前为 Provider 默认开启）——这是有意的；项目可改模板默认值。回滚：还原配置或代码，经 main 自动发布。
