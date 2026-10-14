# Tasks

## 1. 配置与能力接口

- [x] 1.1 在 `template.config.ts` / packages/config 增加 `ai.text.thinking`、`ai.text.reasoning`、`ai.text.failedReplyRefund` 及默认值；`x-text` 增加 `thinking`、`continuation` 严格校验（后台保存同校验）；单测覆盖默认、非法值与后台拒绝，`pnpm --filter @saas/config test` 与 `@saas/ai` 测试通过，更新 docs/06-ai.md 配置表。
- [x] 1.2 在 packages/ai/src/text 增加 Provider 能力接口与注册，DeepSeek 实现 thinking 映射；fault 包装改用该接口；核实 `@ai-sdk/deepseek` 前缀续写可行性并实现或降级为 none（PR 说明结论）；单测用 fake fetch 断言请求体中 thinking 开/关与续写前缀结构，其他 provider 默认不变。

## 2. 请求、重试与续写编排

- [x] 2.1 chat 请求接受 `thinking`（仅 userToggle 时，否则 400），按配置/模型能力决定是否开启；测试覆盖不暴露时忽略请求、暴露时生效、不支持 thinking 的模型忽略。
- [x] 2.2 实现单回复多 attempt 编排：可见正文前对瞬时错误/空回复/仅 reasoning 最多重试 2 次并下发 `data-retry`；可见正文后对 `continuation: native` 续写最多 2 次、正文连续追加；每 attempt `maxRetries: 0`；扩展 ai-chat 共用 suite（CF 与 Node）覆盖首次仅 reasoning 后成功、重试耗尽、续写成功、续写失败、用户停止不受影响。

## 3. 结算、用量与历史

- [x] 3.1 结算按 spec：无可见正文 failed 全额释放（token 与 per_call），有正文 failed 沿用现规则，`failedReplyRefund='all'` 全释放；usage/检查点记录 `reasoningTokens` 与 absorbed 统计；回收器同口径；扩展 settle 与 ai-chat 测试覆盖 per_call/token × 完成/有正文失败/仅 reasoning 失败 × 两种开关，及对账不变式。
- [x] 3.2 历史包含 failed 消息的正文、不含 reasoning；测试覆盖。更新 docs/06-ai.md 计费矩阵与 reasoning 口径。

## 4. 展示与接口

- [x] 4.1 `display=true` 时保存最终 attempt 的 reasoning part 并在聊天页折叠显示，重试时清空并显示“重试中”；`display=false` 时服务端不下发不保存；userToggle 时聊天页显示 thinking 开关；组件/路由测试覆盖。
- [x] 4.2 API key completions 不返回 reasoning；public-api 测试覆盖。

## 5. 集成检查

- [ ] 5.1 `pnpm check`、`pnpm check:deps`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`openspec validate add-text-reasoning-resilience --strict` 全部通过；diff 无迁移或 secrets；PR 写明 staging 验收步骤（协调者执行：开启 thinking 的 DeepSeek 正常回复、仅 reasoning 重试、展示开关）。
