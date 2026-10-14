# Proposal

## Why

文本对话是大多数 AI 应用的核心入口，也是第一个真正消耗积分的功能。它需要把模型注册表、三种计费方式、预扣—结算和流式响应串起来，并处理流式场景特有的中断、超额与结算丢失问题（`docs/06-ai.md` §2–3）。在计费账本就绪后先做文本，可以用最简单的同步链路验证整个「权益 → 预扣 → 调用 → 结算」流程，再进入更复杂的异步媒体任务（`docs/08-roadmap.md` Phase 3）。

## What Changes

- 模型注册表 `ai_model`：模型对哪些套餐可见、走哪个服务商、计费方式与价格、参数 schema；后台最小编辑页；KV 缓存。
- 三种计费方式：按次（对话轮次 / 生成次数，可按参数加权）、按 token、按用量单位（张数 / 秒数），按模型选择；新建模型默认值来自 `ai.defaultPricingMode`；发起时保存定价快照。
- 所有 LLM 调用经 Cloudflare AI Gateway，使用 Vercel AI SDK。
- `POST /api/ai/chat`：权益检查 → 限流 → 按计费方式计算预扣（按 token 时按余额压低最大输出）→ 流式输出 → 服务端读完模型流后结算；客户端断开不影响结算；显式停止接口。
- 注册对话类预扣的超时兜底处理器（按 token 收最低费用，按次按其规则）。2026-10-15 注：无可见正文时现为全额释放，见 ai-chat「出错与结算丢失」与主 spec ai-text-reasoning。
- 对话列表、对话页、模型选择器（显示预计消耗）。
- 决定待决事项 Q7（结算丢失时的最低计费）与 Q10（超额额度）的初始取值。

## Capabilities

### New Capabilities
- `ai-model-registry`: 模型的可见性、计费方式与价格、定价快照、预计消耗展示。
- `ai-chat`: 流式文本对话的行为，包括会话管理、计费结算、中断与停止。

### Modified Capabilities
（无。积分的预扣、结算、超额与欠费沿用 `add-billing-and-credits` 的 `credits` 能力，不改变其要求。）

## Impact

- 依赖 `add-billing-and-credits`（`packages/credits`、权益、超时回收框架）。
- 新增表：`ai_model`、`ai_conversation`、`ai_message`。
- 新增外部服务：Cloudflare AI Gateway，以及至少一家 LLM 服务商（OpenAI / Anthropic / Google 之一）的 API Key。
- `add-ai-media-generation` 复用本 change 的模型注册表与计费方式实现。
