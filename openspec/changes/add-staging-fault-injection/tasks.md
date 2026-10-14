# Tasks

阶段一只交付本目录的提案并停下等待协调者评审；以下均为提案合并并通知后才执行的任务，不在提案阶段勾选。实施范围依 design；需新增 schema/迁移、依赖或超出已评审的共享文件边界时先询问协调者。

## 1. 故障元数据与运行环境闸门

- [x] 1.1 在 packages/ai 增加 x-acceptance-fault 严格枚举解析，扩展媒体 schema 顶层允许项，验证 key/provider/kind/modelId 配对且不泄露到业务 params；扩展现有 params/models 单测覆盖合法模式、非法组合、前缀缺元数据及请求伪造，`pnpm --filter @saas/ai test` 通过。
- [x] 1.2 在 packages/config 实现显式 staging/开关校验并接入 web/jobs CF 与 Node env 装配和绑定类型；测试 production 配置专用开关（含 disabled）、未知环境 enabled、非法值均拒绝，缺失/disabled 保持正常模型行为；`pnpm --filter @saas/config test` 与相关 apps env 测试通过，错误仅含变量名。
- [x] 1.3 仅在 apps/web/wrangler.jsonc 与 apps/jobs/wrangler.jsonc 的 staging vars 添加 enabled，更新 docs/06-ai.md 的配置说明；检查 diff 确认顶层/production vars 与 secrets 未变、关闭闸门和在途任务处理说明一致，`pnpm check` 通过。

## 2. 模型访问与后台配置边界

- [x] 2.1 在 packages/ai 模型列表/直接读库调用增加缺省拒绝的故障访问上下文，在 web 模型选择器、媒体表单、文本/媒体提交与 API key 路径接入 fresh 未模拟的平台管理员校验；扩展现有模型/API测试覆盖普通用户、空间 owner/admin、管理员 API key、缓存命中与停用，断言不可见/不可选且无任务、消息、hold 和 Provider 调用；相关 ai/web 测试通过。
- [x] 2.2 后台 save/copy/enable 接入同一故障配置与环境校验，disabled gate 仍允许停用遗留模型，沿用 adminAction、schema 哈希审计与缓存失效；扩展既有 admin-models 测试验证非法配置无写入、合法配置审计/失效与复制限制，更新 docs/06-ai.md 元数据示例及权限说明，相关测试通过。

## 3. 媒体故障包装与持久生命周期

- [x] 3.1 在媒体提交事务/输入解析保存不可变 acceptanceFault 快照与固定策略，增加独立 acceptanceFaultProof 子树的局部原子更新；测试模型修改/停用后原任务语义不变、非法快照拒绝、配置关闭不执行 Provider 并全退、deadline 与 hold 缓冲一致、证明更新不改变 params，相关 ai/web 媒体测试通过。
- [x] 3.2 实现 Workers 不可重试错误包装及 runner 的 60 秒持久 stalled 分支；扩展现有 media-workflow 测试断言两场景不调用 AI、不转存文件、实际跨 deadline 才超时、failed/hold released/0消费/对账，正常同步图片回归通过；更新 docs/06-ai.md 关于合成错误/超时证据边界。
- [x] 3.3 实现 fal 回调丢失与早到包装/持久屏障，初始 wait 5 秒仅用于专用模式，正常等待不变；测试调用原 Provider 一次、丢失回调经轮询成功、真实格式签名回调先落库后正常检查、屏障未满足不能算成功，以及 R2/file/consume/通知仅一份；扩展现有 jobs/web 媒体测试并通过。
- [x] 3.4 实现 fal 响应丢失、确定失败与 queued 超时，真实 submit ID 只写证明字段，保留 submissionAttempted/非幂等不重提，针对原 ID 尽力取消并记录安全结果（取消受理、原 Provider 查询已终态或仍未确认）；测试每场景一次 submit、failed全退、证据ID结算后保留、真实成功回调不能抢先、跨 deadline、迟到/重放不重复产出或结算，相关 jobs/ai/web 测试通过。
- [x] 3.5 更新 docs/06-ai.md/runbooks/staging-acceptance.md 的媒体故障表，写明固定时间策略、早到屏障、取消并非停止计费、原错误码与 CF step 序列化边界；核对文档与上述实现并复核现有 CF adapter 测试，`pnpm --filter @saas/jobs test` 通过。

## 4. 文本流错误包装与原有结算

- [x] 4.1 实现 doStream 流前错误（不调用上游）与真实流中转发到 200 估算输出 token 后 controller.error，仅故障调用 maxRetries=0，正确取消上游且不标记用户 stop；仅扩展 packages/db/src/schema/ai.ts 的 AiUsageCheckpoint 可选证明类型，冻结 mode 并持久记录实际 injected/phase/上游调用，检查点局部合并保留证明；扩展现有文本/ai-chat 共用 suite 验证 token/per_call 四组合、failed/部分输出/检查点、精确费用/hold封顶/无欠费/对账和重复结算，CF 与 Node 共用测试通过。
- [x] 4.2 更新本地文本夹具/别名，确保本地 fake 上游也实际经过新包装器，未知模型仍不回退真实 Provider；测试未到阈值即结束、上游自然报错或证明写入失败均不伪称注入成功、故障流异常不被 onEnd 记 completed，正常流回归通过；同步 docs/06-ai.md 的故障计费矩阵及真实调用边界。

## 5. 独立故障验收套件

- [x] 5.1 新增独立故障 config/spec 与平台管理员专用 readiness，不加入普通 acceptance.spec、默认 e2e 或 smoke；复用后台 UI 创建/完整核对/启用专用模型，整个准备和执行包在 try/finally，逐项停用并查审计；本地 Playwright 验证部分准备失败、场景失败与一项 cleanup 失败后仍尝试其他停用、同名冲突不覆盖、重复 run 不重发。
- [x] 5.2 实现七个媒体场景和四个文本场景的只读断言：task/message/hold/ledger、差异化收费、一次提交/产出/通知/结算、deadline或回调/轮询场景证明、终态后60秒复核与同快照对账；缺失证明、重复资源或不确定外部取消明确停止；本地全套故障夹具与强制迟到/重放用例通过，不访问真实 Provider。
- [x] 5.3 证据增加版本、mode、injected、realProviderCalled、最小 request ID/时间顺序与清理状态，复用敏感字段过滤；本地核验纯ID/布尔用量证据可写、凭据/内容/签名URL被拒，证据只在已忽略 test-results，不出现在 runbook 真实证据目录。
- [x] 5.4 更新 runbook 独立故障执行命令（headed、单worker、零重试）、同 run 恢复、准备条件、模型停用恢复、固定时间预算及仅协调者发布后运行；用 `playwright test --list` 核验专用配置只收集故障场景，默认/常规配置不收集它，并确认没有支付/邮件或真实视频调用。

## 6. 集成检查与交付

- [x] 6.1 在本 worktree 运行最终本地集成检查：`pnpm check`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm dedupe --check` 与 `openspec validate add-staging-fault-injection --strict` 全部通过；diff 只含授权范围，无迁移种子、secrets 或真实staging证据，原 media 7.1/7.2、chat 5.1 未勾选。
- [x] 6.2 fetch/rebase origin/main，推送实施 PR，描述本地证据与尚未运行的 staging 验收，卡片更新 in-review 并通知协调者；验证 PR diff 与最新 main 一致且无手动部署，等待协调者合并后发布运行，不自行合并/归档。

## 7. 合并发布后的协调者验收（实施 worker 不执行、不勾选）

- [x] 7.1 协调者确认 main 自动发布及 health SHA，人工值守运行独立故障套件；验证十一场景无 skip、全部场景证明/只读对账/终态后观察与 finally 停用通过，审阅并保存脱敏真实证据，失败或外部取消未确认保持未完成。
2026-10-14 验收记录：[fault-2026-10-14a](../../../docs/runbooks/evidence/staging-acceptance/2026-10-14/fault-2026-10-14a-execution-status.json)（SHA d6a9a3f）十一场景中十项通过；chat-mid-stream-per_call 因 deepseek-flash 默认思考耗尽输出上限、未触发注入而失败（#165 修复，计费口径见 #166），finally 一项停用失败已人工经后台停用并核对审计。[fault-2026-10-14b](../../../docs/runbooks/evidence/staging-acceptance/2026-10-14/fault-2026-10-14b-execution-status.json)（SHA 6b02f18，经协调者批准的新 run ID）定向重跑 chat-mid-stream-per_call 与 workers-error 均通过，清理 attempts=1。十一场景合计全部有完整证明与零差额对账。

- [ ] 7.2 协调者合并故障证据并与常规 Gateway token 比对、fal 视频成功产出及原其余要求合并核验；只有全部原验收要求满足才勾选对应 media/chat 编号，按并行计划处理后续 specs 同步/归档；验证原验收记录准确区分合成注入、真实调用和仍未完成项。
