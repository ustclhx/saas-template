# Design

## Context

详细设计见 `docs/06-ai.md` §4–5（含 Workflow 示意代码）与 `docs/03-data-model.md` §5；动机见 proposal.md。Phase 0 已实测跨 Worker Workflow 绑定、`sendEvent` 以及事件早到时的行为，本 change 按实测结论决定是否保留 `check-callback` 步骤（设计默认保留）。

## Goals / Non-Goals

**Goals:**
- Workflow 的每个 step 都可安全重放：提交、转存、结算均幂等。
- 文件上传与 AI 产出共用同一套 `file` 记录、配额与访问控制。

**Non-Goals:**
- 第二个媒体服务商（Replicate、Workers AI 等）：接口预留，按需在后续 change 加。
- 实时推送（Durable Objects + WebSocket）：首版轮询。
- 内容审核：设计中为可选项，首版不做。

## Decisions

1. **任务创建事务**：`pg_advisory_xact_lock(ws)` → 积分锁 → 计数排队 / 运行中任务 → 插入 `ai_task`（定价快照、`provider_request_key = task.id`、`deadline_at`）→ `hold(tx, ...)`，提交后再 `AI_MEDIA_WORKFLOW.create({ id: task.id })`。提交、结算与 billing 回收器统一按空间 → 积分 → 任务加锁，避免反序死锁。用任务 ID 作为 Workflow 实例 ID，启动重复调用时天然去重；启动失败则标记失败并释放。
2. **提交幂等**：`submit` step 内先读库，已有 `provider_job_id` 直接返回；拿到 jobId 立即写库并置 running。服务商不支持幂等键（`capabilities.idempotentSubmit=false`）时，超时 / 连接中断 / 5xx 抛 `NonRetryableError`，任务失败退款。fal.ai 是否支持幂等提交在实现第一步核实，并写入 `MediaProvider` 实现的能力标记。
3. **回调先落库**：回调入口把结果写入 `ai_task.callback_payload`（仅为空时写），再 `sendEvent`；`sendEvent` 失败不影响 200。Workflow 在等待前后各读一次 `callback_payload`。
4. **轮询**：等待回调 15 分钟超时后进入轮询，每次轮询为一个 `step.do` + `step.sleep`，间隔从 30 秒指数增长到 5 分钟，超过 `deadline_at` 视为失败。
5. **转存 R2**：有 `Content-Length` 用 `FixedLengthStream` 流式写入；无长度用 R2 multipart（每片 ≥ 5 MB）；累计超过上限即中止。R2 key 前缀 `ws/{workspaceId}/`。转存 step 以「任务 ID + 输出序号」生成确定的 key，重放时覆盖同一对象而不是产生新文件。
6. **按用量结算的上限**：`actualCredits` 的输入为 `min(服务商回报用量, 请求参数决定的上限)`，超出时写结构化日志告警。
7. **超时兜底处理器**：媒体预扣的 `expires_at` 设为 `deadline_at + 10 分钟`，让现有回收器扫描。向 `registerHoldSweeper('ai_task', handler)` 注册只读写数据库的处理器：任务已是终态而 hold 仍 held → 用共用 `settleMediaTask` 按已存任务结果补结算；任务未终态且超过 `deadline_at` → 标记失败（`MEDIA_DEADLINE_EXCEEDED`）并全额释放。回收器为 DB-only 事务，保持 billing 的注册与扫描接口，不查询或 terminate Workflow，也不在事务中取消服务商作业。Workflow 每个 step 前读取任务，发现终态时尽力取消服务商作业并直接退出，自检即可停止后续业务步骤；晚到 Workflow 不再结算，`settleMediaTask` 对已结算终态幂等，不重复账本或通知。10 分钟缓冲只影响回收扫描时间，Workflow 自身仍按 2 小时截止时间停止。
8. **预签名**：用 `aws4fetch` 在 Worker 内对 R2 S3 端点签名，上传地址有效期 10 分钟并签入 `Content-Type`；下载地址有效期 5 分钟。确认接口用 `R2.head()` 获取真实大小与类型。
9. **前端轮询**：任务详情页 2 秒起、指数退避到 10 秒，任务进入终态后停止。

## Risks / Trade-offs

- [fal.ai 不支持幂等提交] → 按决策 2 宁可失败退款；在任务详情页对这类失败给出明确说明，减少用户困惑。
- [视频产出过大导致转存耗时长] → 转存 step 设置足够的超时与重试；单文件上限按套餐可配置。
- [Workflow 实例数量与费用] → 只为图片 / 视频任务创建实例；同步返回结果的模型在 `submit` 后直接进入转存，不进入等待。
- [配额检查与上传之间的竞争] → 声明阶段与确认阶段各检查一次；确认时以真实大小为准，超出即删除。

## Migration Plan

新增表，无既有数据。部署顺序保持 jobs 先于 web（web 依赖 jobs 中的 Workflow 定义）。

## Open Questions

（无）
