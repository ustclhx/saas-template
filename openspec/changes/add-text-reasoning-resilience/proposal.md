# Proposal

## Why

staging 故障套件（fault-2026-10-14a）发现 deepseek-flash 默认开启思考，可能把输出上限全部用于 reasoning、没有可见文本，却按 completed 收取按次费用；reasoning 不计入检查点与中断结算，失败一次即返回用户，失败的部分回复也不进入后续上下文（#166）。模板需要为任意外部模型提供可配置的 thinking/reasoning 口径与基本容错，本 change 先以 DeepSeek 落地并留扩展接口。

## What Changes

- 模板配置项：thinking 默认开关、是否向用户暴露 thinking 开关、是否展示 reasoning 过程；失败全退模板开关（默认关闭）。模型在 `params_schema['x-text']` 声明是否支持 thinking 与续写能力。
- 请求可携带单条 thinking 开关，仅在模板允许暴露时接受；否则由配置决定。
- **BREAKING（未归档 ai-chat 语义）**：没有可见文本的回复（仅 reasoning、reasoning 阶段中断、输出前报错）最终失败时视为 failed 且不向用户收费，成本由 SaaS 承担；有可见文本后失败仍按已产生部分计费（失败全退开关开启时全部 failed 不收费）。
- 可见文本出现前的瞬时错误、空回复与仅 reasoning 回复，在同一预扣下透明重试；可见文本后中断，用原上下文加已生成部分续写，作为同一条回复保存与结算。
- 用量统计、检查点与对账记录 reasoning token。
- 展示 reasoning 时单独保存并折叠显示，不进入后续历史、不经 API key 返回。
- failed 消息的已生成可见文本进入后续对话上下文。
- 只实现 DeepSeek 的 thinking 映射与原生前缀续写；其他 Provider 通过统一能力接口默认“不支持”，未来按需扩展。

## Capabilities

### New Capabilities

- `ai-text-reasoning`: 文本模型 thinking/reasoning 的配置与展示、可见输出判定、重试与续写、reasoning 用量统计以及无可见输出失败的计费口径。

### Modified Capabilities

无已归档主 spec 变更。未归档 `add-ai-text-chat` 的 ai-chat 中“出错与结算丢失”“按次计费有输出即收费”的口径由本 capability 细化：可见输出才算输出；该 change 归档同步时以本 change 为准。

## Impact

- `packages/config` / `template.config.ts`：新增 `ai.text.thinking`、`ai.text.reasoning`、失败全退开关及默认值。
- `packages/ai/src/text/**`：Provider 能力接口、DeepSeek thinking 映射与前缀续写、重试/续写编排、reasoning 用量。
- `apps/web/src/features/ai/chat.ts`、settle、检查点、历史构建、chat 页面（重试提示、reasoning 折叠、thinking 开关）、API key completions（不返回 reasoning）。
- `packages/db/src/schema/ai.ts`：仅扩展 parts / usage JSON 的 TS 类型（reasoning part、reasoningTokens），不改列或迁移。
- `docs/06-ai.md` 计费与配置说明。
