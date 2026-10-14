# Tasks

## 1. 数据模型

- [x] 1.1 新增 `ai_task`（定价快照、`provider_request_key`、`callback_payload`、`workflow_instance_id`、`deadline_at`，索引 `(ws, id desc)`、`(status, updated_at)`）与 `file`（`status`、`public_token` 唯一）表，验证迁移成功

## 2. 文件存储

- [x] 2.1 在 `packages/storage` 实现 R2 预签名上传 / 下载（`aws4fetch`，限定 `FILES` 桶），验证单元测试检查签名包含 `Content-Type` 且有效期符合设计
- [x] 2.2 实现上传三步：声明（类型白名单、单文件上限、配额检查、插入 pending 记录）→ 直传 → 确认（`R2.head()` 校验真实大小与类型，不符则删除），验证测试：实际大小超过声明时确认失败且对象被删除
- [x] 2.3 实现文件访问（成员校验后 302 到短期下载地址）、公开分享链接的生成与撤销、存储配额计算，验证非成员访问返回 404、撤销后分享链接立即 404
- [x] 2.4 实现清理 Cron：超过 1 小时的 pending 记录与对象、软删空间保留期后的文件，验证到期记录与对象被删除

## 3. 媒体服务商

- [x] 3.1 在 `packages/ai/media` 定义 `MediaProvider` 接口（含 `idempotentSubmit` 能力标记）与 `MediaResult` 类型，验证类型测试通过
- [x] 3.2 实现 fal.ai Provider（提交带 webhook、查询状态、解析回调与验签、取消），核实其是否支持幂等提交并设置能力标记，验证用录制的响应与回调夹具的单元测试通过

- [x] 3.3 实现媒体服务商注册表（决策 10）：运行时、提交校验、回调入口与转存白名单按 `ai_model.provider` 查表，`template.config.ts` 增加 `ai.mediaProviders`，后台模型表单与项目生成器按启用列表工作，验证测试：未启用或未配置服务商的模型提交被拒且不预扣，fal.ai 现有测试不改语义通过
- [x] 3.4 实现 Workers AI 图片 Provider 与 Workflow 同步产出路径（决策 11、12），验证测试用假 `AI` 绑定覆盖成功入库与结算、推理失败全额退回、重放提交 step 不产生重复文件

## 4. 任务提交与 Workflow

- [x] 4.1 实现 `POST /api/ai/tasks`：参数按 schema 校验 → 权益与配额检查 → 单事务（空间锁、并发计数、创建任务、预扣）→ 以任务 ID 启动 Workflow，启动失败则标记失败并释放，验证并发提交超过上限时只有允许数量被接受
- [x] 4.2 实现 `AiMediaWorkflow` 的提交步骤（读库复用 jobId、带幂等键提交、拿到 jobId 立即落库、不确定错误不重试），验证测试：模拟提交响应丢失时服务商只收到一次提交（或任务失败退款）
- [x] 4.3 实现回调入口（任务 HMAC + 服务商签名校验、结果先写 `callback_payload` 再 `sendEvent`），以及 Workflow 的等待前检查、等待、超时后再检查与轮询，验证测试覆盖「回调丢失」与「回调早到」两种情况都能完成
- [x] 4.4 实现转存步骤（域名白名单、大小与类型限制、有长度时流式写入、无长度时分片上传、确定性 key）并写 `file` 记录，验证测试：非白名单地址导致任务失败退款、重放转存步骤不产生重复文件
- [x] 4.5 实现结算与通知步骤（按定价快照，按用量不超过参数上限，失败 / 取消全额释放，站内通知），验证测试覆盖成功、失败、用量超出参数上限三种结算
- [x] 4.6 实现取消接口（释放预扣、服务商支持时取消作业、终止 Workflow），验证取消排队中任务后积分全额退回
- [x] 4.7 注册 `ai_task` 的 DB-only 超时兜底处理器（按任务终态补结算，超过 deadline 则失败并释放；Workflow 自检终态停止），验证测试：超过 2 小时的任务被终止并退款，Workflow 晚到时不重复结算

## 5. 界面

- [x] 5.1 任务提交页：按 `params_schema` 渲染参数表单、预计消耗、引用已确认的上传文件，验证组件测试覆盖 schema 中的枚举、数字范围与文件字段
- [x] 5.2 任务列表与详情页（轮询指数退避、终态停止轮询、结果预览与下载、取消、分享），验证 e2e 覆盖提交、等待完成与查看结果
- [x] 5.3 后台模型编辑支持 params_schema（媒体参数 schema 与文本 x-text 配置），保存前用与提交页 / 服务端相同的解析器校验，提供各已注册媒体服务商的参考模板，验证测试：非法 schema 被拒、保存后提交页按新 schema 渲染与校验、改动写入审计

## 6. 文档

- [x] 6.1 更新 `docs/06-ai.md`（服务商注册表与新增服务商步骤、fal.ai 是否支持幂等提交、事件早到实测结论、轮询参数），验证文档与实现一致

## 7. 阶段验收

- [x] 7.1 在 staging 用 Workers AI 跑通一个图片模型，并模拟推理失败与超过硬超时，验证任务终态正确、积分只扣一次或全额退回、对账不变式成立
- [x] 7.2 在 staging 用一个异步服务商（默认 fal.ai）各跑通一个图片与一个视频模型；分别模拟回调丢失、回调早到、提交响应丢失、服务商失败、超过硬超时，验证每种情况任务终态正确、积分只扣一次或全额退回、对账不变式成立

2026-10-13 验收记录：13j 的 Workers/fal 图片成功、按次消费各一次及 fal 视频取消全退已有[真实证据](../../../docs/runbooks/evidence/staging-acceptance/README.md)。7.1 的受控推理失败与硬超时、7.2 的视频成功产出及各类故障注入尚未完成，因此两项保留未勾选；历史意外失败与取消不能代替完整验收。

2026-10-14 验收记录：受控故障套件 [fault-2026-10-14a](../../../docs/runbooks/evidence/staging-acceptance/2026-10-14/fault-2026-10-14a-execution-status.json) / [14b](../../../docs/runbooks/evidence/staging-acceptance/2026-10-14/fault-2026-10-14b-execution-status.json) 完成 Workers 合成推理失败与 60 秒固定 deadline 硬超时（均 failed、预扣全退、0 消费、对账零差额），连同 13j 的真实成功产出，7.1 勾选；合成错误不调用 AI 绑定、超时以持久 sleep 模拟未完成推理，证据边界见 add-staging-fault-injection design。fal 五类故障已在同一套件通过。

2026-10-15 验收记录：[media-video-2026-10-15a](../../../docs/runbooks/evidence/staging-acceptance/2026-10-15/media-video-2026-10-15a-execution-status.json)（SHA 7e7c99c）以 `fal-ai/wan/v2.2-a14b/text-to-video/turbo` 480p 真实生成 5 秒视频成功：真实回调、R2 文件与安全下载、单次 consume 3 积分、单次通知、终态后 67 秒复核稳定、同快照对账零差额。连同 13j 的 fal 图片成功与 fault-2026-10-14a 五类故障，7.2 勾选。
