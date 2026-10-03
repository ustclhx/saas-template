# Design

## Context

详细设计见 `docs/06-ai.md` §1–3、§7 与 `docs/05-billing.md`「预扣-结算」「超额容忍」「超时回收」；动机见 proposal.md。依赖 `add-billing-and-credits` 的 `packages/credits`（含 `registerHoldSweeper`）与 `packages/entitlements`。Phase 0 已实测 `waitUntil(consumeStream())` 在客户端断开后的行为，本 change 按实测结论实现。

## Goals / Non-Goals

**Goals:**
- 建立 `packages/ai` 的模型注册表与计费方式实现，供媒体 change 直接复用。
- 让文本对话的结算在完成、停止、断开、出错、进程中断五种情况下都有确定结果。

**Non-Goals:**
- 工具调用、RAG、长会话摘要（设计中为扩展点，首版只给一个示例工具）。
- 公开 API（`/api/v1/chat/completions`），在 `add-observability-and-optional-features`。
- 完整的模型管理后台（批量操作、统计图表），在 `add-admin-console`；本 change 只做可用的最小编辑页。

## Decisions

1. **计费方式实现**：`Pricing` 为判别联合（`per_call` / `token` / `per_unit`），`estimateCredits(pricing, input)` 与 `actualCredits(pricing, usage)` 是纯函数，放在 `packages/ai/pricing`，单元测试全覆盖；`packages/credits` 不感知计费方式。
2. **定价快照**：发起时把 `pricing` 拷贝进 `ai_message.pricing`，结算只读快照。KV 缓存的模型列表只用于展示与选择。
3. **输入 token 估算**：首版用「字符数 × 保守系数」（按模型配置，默认偏高），服务商提供计数接口的模型可选调用；估算误差通过 `credit_hold.overage_*` 监控，用来校准系数。备选「每次调用计数接口」更准但增加一次往返和费用。
4. **最低费用（Q7）**：按 token 计费结算丢失时，按估算输入 token 计费，且不低于模型的 `minCharge`；`minCharge` 默认 1 积分。
5. **超额额度（Q10）**：沿用 `billing.overage` 默认值（单次 20% / 50 积分、空间每日 200 积分），本 change 上线后观察两周 `overage_absorbed` 再调整。
6. **流式与结算解耦**：`streamText` 返回后立即 `ctx.waitUntil(result.consumeStream())`，`onFinish` 中结算并更新消息状态；前端停止按钮调用 `POST /api/ai/chat/:messageId/stop`，服务端通过 `AbortController` 中止并按已产生用量结算。
7. **超时兜底处理器**：向 `registerHoldSweeper('ai_message', handler)` 注册：读取消息的定价快照，按 token → 最低费用；按次 → 消息有输出则全额、否则释放；并把消息标记为 `failed`。
8. **AI Gateway**：AI SDK provider 的 baseURL 指向 Gateway 的各家兼容端点；Gateway 开启鉴权时带 `AI_GATEWAY_TOKEN`。
9. **对话隐私**：对话只对创建者可见，`ai_conversation` 查询在 `scoped(ws)` 之上再加 `user_id` 过滤。

## Risks / Trade-offs

- [`waitUntil` 有时间上限，超长输出可能来不及结算] → 由超时兜底处理器按最低费用结算；在 `docs/06-ai.md` 中注明这一取舍。
- [输入估算系数偏低导致平台持续承担超额] → 每日按模型统计 `overage_absorbed`，超过阈值告警。
- [AI Gateway 与服务商的 token 统计口径不一致] → 结算以 AI SDK 返回的 usage 为准；阶段验收时对比两边统计，差异超过 1% 时调查。

## Migration Plan

新增表，无既有数据。上线前通过后台录入至少一个按 token 与一个按次计费的文本模型。

## Open Questions

（无）
