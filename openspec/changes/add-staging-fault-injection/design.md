# Design

## Context

动机与范围见 proposal；行为契约见两个 delta specs。现有事实与切入点：

- `packages/ai/src/models.ts` 的 `ai:models` KV 保存完整启用注册表，调用前 `requireAvailableModel` 直接读库；当前没有管理员/故障过滤。
- `apps/web/src/features/ai/chat.ts` 在建模后才创建消息和 hold，随后 `streamText`。`packages/ai/src/text/settle.ts` 已实现错误结算、估算封顶和预扣幂等；无输出 token 仍按输入估算与 minCharge 收费，per_call 默认 any_output 无输出全退。
- `apps/jobs/src/workflows/media-runner.ts` 的 `submitMediaOnce` 在外部 submit 前保存 `output.submissionAttempted`，fal `idempotentSubmit=false`，不确定受理后终止且退款。已有 jobId 时重放会复用，因此响应丢失不能提前填业务 `providerJobId`。
- 真实回调入口先校验任务 HMAC 和 fal 签名，落 `callback_payload` 再唤醒；runner 在 wait 前后查库。默认 wait 15 分钟，deadline 2 小时，hold deadline 后 10 分钟到期；直接把所有 deadline 缩短会令回调丢失场景来不及轮询。
- Workers 是同步字节路径；目前 `run` 返回后先 persist，外围再检查 deadline。故障超时不能用迟交图片的方法，否则会先产生临时文件。
- `ai_task.input` 是现有 JSONB 参数/服务商快照，`output` 会被提交、转存与结算覆盖。staging 工具已有管理员内存会话、后台模型编辑、只读同快照对账与脱敏 evidence；普通媒体/聊天 helper 明确拒绝管理员，不能直接复用其身份准备。

## Goals / Non-Goals

**Goals:** 保留真实业务提交、预扣、验签、轮询、R2、结算链路；在明确任务边界内制造一种故障；证据证明触发了预期分支，而不仅是终态相同。提供可在本地夹具验证、合并后由协调者在 staging 运行的独立套件。

**Non-Goals:** 不改变正常失败计费或服务商幂等能力，不设计通用混沌平台，不添加远程故障控制接口、DB 表/列或依赖，不向普通用户提供测试模式。原阶段验收的常规缺口见 proposal。

## Decisions

### 1. 故障配置是模型元数据，执行策略固定

在现有 `params_schema` 顶层新增保留扩展 `x-acceptance-fault: { mode: <枚举> }`。专用 key 必须以 `acceptance-fault-` 开头，且前缀与合法元数据同时成立；前缀存在但元数据缺失/非法时也不可作为普通模型运行。mode 限于 workers-error、workers-timeout、fal-callback-lost、fal-callback-early、fal-submit-response-lost、fal-provider-error、fal-timeout、chat-before-stream、chat-mid-stream。

媒体 schema 解析器显式接受该顶层扩展，但不把它纳入表单字段或传给 Provider；后台 save、copy、enable 均用同一校验器检查 key、provider、kind、providerModelId。fal 故障只允许现有 `fal-ai/flux/schnell` 图片模型，固定 square、一张；Workers 只允许现有图片 Provider，文本使用现有 deepseek 模型及现有低额度定价。请求无法携带 mode、延迟或 deadline；非法模式不降级成真实调用。

采用现有 JSON 编辑框与共享解析器；独立数据库列、另造 fault Provider ID 或迁移 seed 都增加无必要配置/迁移成本。是否创建专用模型由脚本控制，普通模型不会因 key 猜测、请求参数或全局开关自动出错。

### 2. 三重闸门，采用平台管理员范围

运行开关只有缺失/disabled 与 enabled 两种语义，非法值拒绝；enabled 只允许 `SENTRY_ENVIRONMENT=staging`，production 即使显式 disabled 配置该专用开关也拒绝，未知环境开启同样拒绝。共享 config 的纯校验函数在 CF web/jobs 和 Node env 装配处执行，避免异步任务或另一运行目标绕开。生产/顶层 Wrangler 不添加该变量；仅 web/jobs staging 段添加 enabled。

故障列表需要可信平台管理员身份，调用需要 fresh、未被模拟的管理员 session；空间 owner/admin 不算平台管理员。API key 入口统一拒绝故障模型，包括管理员创建的 key，不另建授权机制。缺省调用上下文无授权即隐藏/拒绝，所有返回完整 schema 的列表同样保护；缓存继续保存完整注册表，在每次读取后按环境和身份过滤，提交直接读库再次核验。原有套餐权益、余额、并发和限流仍执行。

采用平台管理员而不增加验收空间白名单，减少角色和配置边界。后台保存/复制/启用故障模型也受环境闸门约束；关闭开关时仍允许管理员停用遗留模型。

### 3. 快照与最小执行证明复用 JSONB

媒体提交事务在 `input.acceptanceFault` 保存服务端校验后的 mode 与固定策略版本、管理员授权结果；deadline 在创建任务时确定，hold 仍为 deadline + 原 10 分钟缓冲。后台之后改配置/停用不影响已接受任务。jobs 按快照重建正常 Provider 再包装，并重新核验环境闸门；开关关闭时故障任务以正常失败结算链路释放，不切换成正常调用或让 hold 遗留。

最小媒体证明置于 `input.acceptanceFaultProof`，与不可变配置快照分离：提交尝试计数、真实 request ID、真实回调落库时间、正常回调检查时间、轮询次数和注入时间。仅服务端在空间→任务锁下更新这个独立 JSON 子树，保留原 input 其他字段；不依赖会被覆盖的 output、不放入 params、不保存回调原文或图片地址。真实 submit 前原子记录一次尝试，保留原 submissionAttempted 保护；崩溃后未获得 ID 时证据不完整，不允许再提交来补证据。

文本调用在 fresh gate 后固定模式，在现有 `ai_message.usage_checkpoint.acceptanceFaultProof` 可选子树保存 mode、策略版本、phase、injected、realProviderCalled 和注入位置。初始 injected=false，检查点的 inputTokens 与发起时估算相同、outputTokens=0，不提前写输出 parts；只有包装器实际进入指定注入分支且证明写入成功，才记 injected=true 并抛错。上游自然报错、未达到阈值或证明写入失败均不能认证注入成功。正常 token 检查点与证明写入用局部 JSON 合并互相保留，结算不删除证明；套件只读核验。仅扩展 `packages/db/src/schema/ai.ts` 中 AiUsageCheckpoint 的可选 TS JSON 类型，不改列/表或新增迁移。套件保存 ID、hasOutput 和最小证明，不保存内容；本地强制重入验证结算唯一性。

### 4. 媒体场景包装与 runner 持久步骤

使用实际 fal Provider 的 submit/getStatus/cancel/parseWebhook；不改签名实现、不造假的 fal callback。包装器允许 jobs 的任务级依赖写最小证明；任务级策略及持久等待由 runner 执行，不把数据库或 Workflow API 塞进通用 Provider 契约。

| 模式 | 注入方式 | 时间策略与结果 |
|---|---|---|
| workers-error | 包装同步 run，直接合成安全、不可重试错误；不调用 AI 绑定 | 原失败结算，failed/全退 |
| workers-timeout | runner 将专用任务置 running，使用持久 sleep 模拟 run 一直未完成，不调用 AI 绑定、不造字节 | deadline 固定 60 秒，到时由原 active 检查决定超时；无 persist，failed/全退 |
| fal-callback-lost | 真实 submit 移除 webhookUrl；保留真实原 job 查询 | 初始原生 wait 固定 5 秒，deadline 固定 20 分钟；原轮询/转存成功，消费一次 |
| fal-callback-early | 真实 submit、真实 webhook；jobId 正常持久化后，正常 check-callback 前增加有界持久屏障，检查真实 callback 已落库 | deadline 20 分钟，屏障最多 10 分钟，2 秒持久睡眠；实际观察到后才进入正常 check。记录 callback 落库早于正常检查；未观察到则场景失败，不以普通轮询成功替代 |
| fal-submit-response-lost | 真实 submit 返回 ID 后，将 ID 写入证明字段，再抛 ambiguous 网络类错误；不给回调地址，避免恢复成早到回调场景 | 不填业务 providerJobId；原 UNCERTAIN 失败全退且不重提。失败后按证明中的原 ID 尽力取消 |
| fal-provider-error | 真实 submit 无回调；包装原 job 的查询结果为固定安全 failed | wait 5 秒、deadline 20 分钟；确保真实成功回调不能抢先，原失败全退并尽力取消 |
| fal-timeout | 真实 submit 无回调，原 job 真实查询后包装 queued，不能产生结果 | wait 5 秒、deadline 60 秒，沿原轮询/剩余时间截短 sleep/active 进入失败全退，再尽力取消 |

固定策略只在合法故障快照上使用，正常等待、轮询、deadline、step retry 均不变。Workers stalled 分支使用原 deadline 检查，不能直接调用 settle(...failed) 或伪造时钟来“证明超时”；本地可用虚拟时钟驱动同一持久步骤。这个场景证明同步任务截止时间和退款，不声称真实 AI 服务挂起。

早到采用“提交返回后、正常读取前”的真实落库屏障，避免占用 2 分钟 submit step；不试图证明更严格的“jobId 落库前回调到达”，现有本地测试继续验证该更早竞态。真实签名/HMAC回调仍原样处理，保存事务时间证明。响应丢失保存 ID 不改变恢复语义，取消只尽力且不视为推理停止或免付外部费用；失败/超时之外不扩大普通取消行为。

故障取消的证明区分 cancellation-requested、already-terminal 与 unconfirmed。202 只记录取消受理；取消失败或返回已完成时，可调用未包装的原 Provider 只读 getStatus 核验外部作业确实已终态，并记录安全状态，不把它写成应用成功。仍 queued/running 或查询失败则 unconfirmed，套件停止并交人工核验；已经真实完成可作为无外部在途作业的证明，但不能声称取消成功或免付费。

回调终态处理和晚到 Workflow 继续以现有 settleMediaTask 幂等为准。本地夹具强制真实格式的重复回调与迟到结果；staging 对原 task 做固定 60 秒终态后观察，不制造或重放失效签名。未能观察真实晚到时证据标明仅观察，不伪称注入了晚到回调。

### 5. 文本包装在 doStream 与实际流边界

不在模型构造阶段 throw，否则没有 hold 可验证。流前在包装后的 doStream 抛安全异常，不调用真实模型；仅故障模型显式 `maxRetries=0`。流中调用原 Provider 的 doStream，转发真实 text-delta 后中断读取并以流异常终止；不只 enqueue error chunk 后 close：当前 AI SDK 仍可能触发 onEnd，被现 handler 当成 completed。

流中注入在累计真实文本足以触发已有 token 检查点后执行（固定 200 个估算输出 token），并限制现有 maxOutputTokens 为 1024；真实流未达到阈值即结束则场景未触发，不认证成功。阈值只计正文 text-delta（与检查点、部分输出和 per_call 有输出判定同口径）；`deepseek-flash` 默认思考可能只产生 reasoning 并用尽上限，故障调用经包装器固定关闭思考，不把 reasoning 计入阈值。停止上游 reader，但不触发业务“用户停止” AbortController，确保状态是 failed。保留现有 onChunk、checkpoint、done、settleInterruptedChatMessage 路径，不修改收费公式。四个模型模式×定价组合分别核验：per_call 无输出 0、有输出固定费用；token 按输入/已输出估算与 minCharge、封顶 hold，无额外欠费。

全假 staging 文本流无法证明真实流经过错误分支，故只在本地用已安装 SDK/夹具复现。Gateway 日志比对依然独立，direct/gateway 出口保持现有配置。

### 6. 独立管理员故障套件与 finally 清理

新增显式故障验收入口与 config，仅收集故障 spec；不加入现有 acceptance.spec、默认 e2e 或 smoke。复用 support 管理员新鲜内存会话、query/evidence/reconcile 与后台 UI selector；单 worker、retries=0、headed/人工值守、禁 trace/screenshot/video。在管理员自己的专用验收空间运行，先只读检查现有模型权限、积分、存储；不足给安全准备指引，不自动修改套餐或绕过权益。最多 5 次低成本 fal 图片提交、Workers 0 次实际调用、文本流中 2 次实际调用；失败即停止新提交，不自动更换 run ID。

所有创建/启用均在 try 范围内，在任何创建/启用写操作之前将稳定 key 加入 cleanup 清单，获得 ID 后补齐；响应不明确时也按该 key 只读定位并停用，不能遗失刚创建的模型。既有同 key 只允许完整配置匹配；匹配且 disabled 可经后台 UI 启用，不修改 schema/定价；所有本轮准备的模型最终统一停用（不是恢复 enabled），并查只读 enabled 状态及审计，普通列表不可见。循环逐项停用，单项失败不跳过剩余资源；清理错误保留原场景失败与资源 ID。进程被杀无法保证 finally，下次运行先识别同 run 的业务资源、遗留专用模型；证据不完整先停用并要求核验，不盲目恢复收费步骤。

稳定 run ID+mode+pricing 标识查询原 task/conversation/message；相同已完成场景只验证原记录及证明，最多一个业务资源；无终态/无 request ID/提交不明确时停止。模型配置恢复无法从现 schema 哈希审计重建，因此不编辑他人或不匹配模型。

### 7. 证据与验收边界

每场景保存版本 SHA、ID、模式、经持久证明核验的 injected=true、realProviderCalled、真实 request ID（fal）、hold 原额/状态/已消费/释放、ledger IDs、pricing、最小 usage、文件/通知数量、场景时间顺序与只读对账。失败释放无需额外 refund 分录；activeRemaining 不排除已过期待 Cron 批次，hold 不从 remaining 再扣一次。终态后再次核验同一资源无新增消费、输出或通知。

复用既有安全字段校验，不保存邮箱、提示词、partial text、payload、Cookie、连接串或签名 URL。真实 staging 证据沿现 runbook 路径，本地证据留在 test-results 的忽略目录；明确 injected 与真实调用分开，不能把 target=staging-real 等同真实 Provider 自然报错。套件可只读核验 wrapper 的一次提交证据与真实 ID；Provider 内部是否另建作业不由应用计数证明，保留这项证据边界。

## Risks / Trade-offs

- [真实回调/推理慢，屏障或 deadline 不够] → 有界失败并保留证据，不增加 retry 或无依据认证；调整固定策略须单独评审，禁止请求自定义时间。
- [部分 Node/CF 装配未传闸门，API key 或缓存绕过] → config 纯函数和所有列表/调用入口默认拒绝，单测覆盖目标、身份和 cache hit；CF composition 的 shared 文件修改以本设计审阅结果为实施边界。
- [输出 JSON 清空丢 request ID] → 证明独立存 input 子树，局部原子更新；测试失败结算后仍可读 ID，且不进入真实 params。
- [开关关闭时在途故障仍执行] → jobs 与文本包装检查环境闸门，停止故障调用并走原失败结算；模型停用只拦新请求，不影响已冻结任务。
- [真实取消已完成/仍运行] → 记录安全取消状态；退款与服务商收费分开，未确认取消报告人工核验，不再次提交。
- [Cloudflare step 的错误码在序列化后丢失] → 断言 failed/退款与场景证明为主，同时记录实际安全错误码；在现真实 CF adapter 测试核验，不以本地中立异常码假定部署结果。
- [异步 runner 里增设故障步骤影响普通任务] → 只在合法故障快照分支执行，原步骤名称、等待/轮询常量和幂等保护保持；扩展现有正常回归用例。

## Migration Plan

阶段一仅此目录的提案 PR，strict validate 及根检查通过后交协调者，等待合并通知。阶段二按 tasks 实施并在本地验证；不产生迁移、不改 secrets、不手动部署、不运行 staging。代码经 PR 合入 main，按现流水线 jobs→web 自动发布；协调者确认 health SHA 后执行显式故障套件并审阅证据。

回滚：先由脚本/管理员停用故障模型；必要时经 main 回滚 staging vars 与实现，不手动部署。遗留专用模型即使未停用也被关闭闸门阻止调用；在途 hold 由既有失败结算和回收器处理。原 media/chat 验收编号只由协调者在常规缺口全部补齐后勾选。

## Open Questions

无影响实现边界的未决方案。真实 staging 时间预算是否足够由协调者执行后核验；若失败需评审固定策略后重跑，不在现场临时放宽断言或伪造证据。
