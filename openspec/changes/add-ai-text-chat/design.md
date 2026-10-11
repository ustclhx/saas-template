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
7. **超时兜底处理器**：向 `registerHoldSweeper('ai_message', handler)` 注册：读取消息的定价快照，按 token → 有用量检查点时按检查点用量结算，没有才收最低费用；按次 → 消息有输出（或有检查点）则全额、否则释放；并把消息标记为 `failed`（有部分内容时标记为未完成）。
8. **AI Gateway**：AI SDK provider 的 baseURL 指向 Gateway 的各家兼容端点；Gateway 开启鉴权时带 `AI_GATEWAY_TOKEN`。
9. **对话隐私**：对话只对创建者可见，`ai_conversation` 查询在 `scoped(ws)` 之上再加 `user_id` 过滤。
10. **用量检查点**（Phase 0 实测 7.3 后采纳）：平台在客户端断开后只允许 `waitUntil` 再运行 30 秒，超时静默取消，`onFinish` 不会执行。因此在 `waitUntil` 中读模型流的同一个读取器里，每 5 秒或每 200 个输出 token（先到者）执行一次 `UPDATE ai_message SET usage_checkpoint = {inputTokens, outputTokens, at}, parts = <已生成内容>`。服务商通常只在流结束时返回 usage，所以检查点中的输出 token 按已生成文本估算（与输入估算用同一个估算器）；检查点只是估算，字符估算可能高于服务商实际分词数（英文约 4 倍），按检查点结算可能多收，由决策 11、12 约束。备选「断开约 25 秒后主动中止生成、在时限内按已产生用量结算」被否决：它会截断用户的回复，且中止后服务商不一定返回 usage。
11. **估算结算不超过预扣**：停止、出错与超时兜底在拿不到服务商用量、改按估算结算时，金额 MUST 不超过该次预扣额（`min(估算金额, hold.amount)`），因此不触发超额容忍、不补扣余额、不产生欠费。预扣额已包含 `maxOutputTokens` 对应的输出费用，而服务商实际输出不会超过该上限，封顶不会让平台收得少于实际消耗。超额容忍只用于服务商报告的真实用量超出预扣（正常完成路径）。
12. **实际用量优先，估算只作兜底**：生产环境的结算顺序为：服务商在流中返回的最终 usage → 中断时从 AI Gateway 取回的该请求实际用量 → 按决策 11 封顶的估算。每次经 AI Gateway 的调用带上可回查的请求标识（如 `cf-aig-metadata` 中的消息 ID），中断后按标识查询日志中的 token 数。AI Gateway 是否记录被中断流的用量、日志可查询的延迟，以及「中断时立即查询」还是「先按估算结算、再由 Cron 对账补差」，需在有真实凭据后验证再定（见 Open Questions、tasks 2.9）。

## Risks / Trade-offs

- [`waitUntil` 有时间上限，超长输出可能来不及结算] → 用量检查点（决策 10）让兜底按已记录的用量结算，而不是最低费用。
- [断开超过 30 秒后服务商仍在继续生成] → 这部分输出服务商照常计费、平台无法向用户收取；属已接受的取舍（不截断回复）。通过监控「被取消的回复」数量与检查点之后的估算损失评估影响，必要时再引入主动中止或 Durable Object 承载生成。
- [检查点写库增加数据库负载] → 每条回复每 5 秒最多一次 UPDATE，按主键更新，开销可忽略；写入失败只记录日志，不影响生成。
- [输入估算系数偏低导致平台持续承担超额] → 每日按模型统计 `overage_absorbed`，超过阈值告警。
- [AI Gateway 与服务商的 token 统计口径不一致] → 结算以 AI SDK 返回的 usage 为准；阶段验收时对比两边统计，差异超过 1% 时调查。

## Migration Plan

新增表，无既有数据。上线前通过后台录入至少一个按 token 与一个按次计费的文本模型。

## Open Questions

- AI Gateway 日志能否提供被中断流的实际 token 数、可查询延迟多大；据此决定决策 12 采用即时查询还是延后对账补差（补差需要积分账本的调整分录）。由 2.9 在 staging 验证后定。
  - 2026-10-12 本地探针：DeepSeek `deepseek-flash` 经 Gateway 托管密钥（BYOK，仅带 `cf-aig-authorization`，未传服务商 key）非流式调用成功，返回输入 7 / 输出 2 tokens。另一次流式请求带 `cf-aig-metadata`，读取 2 个文本块（2 个字符）后在约 1.8 秒 abort，响应 `cf-aig-log-id=01a12c2b-cf0e-74b0-ae84-7bd4b534532c`，中断前未收到最终 usage。
  - 阻塞：需要 AI Gateway 日志读取权限的 token。现有 Gateway token 与已刷新的 Wrangler OAuth 查询日志列表均返回 403（Cloudflare 错误码 10000）；OAuth 按上述 log ID 查询详情也返回 403。本机未发现具备此权限的 Cloudflare API token，未创建新 token。因此无法判断 `tokens_in` / `tokens_out` 是否存在，也无法测量日志出现延迟；不据此选择即时查询或延后对账，不实现结算改动，2.9 与 staging 验收保持未完成。后续持有日志读取权限后按同样标识重测，所需字段见 [日志详情 API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/)。
