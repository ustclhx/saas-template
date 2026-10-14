# Proposal

## Why

图片和视频生成耗时从数秒到数十分钟不等，不能在请求内同步完成，必须作为持久的异步任务运行，并且要在服务商回调丢失、回调早到、提交响应丢失、进程中断等情况下仍然只提交一次、只扣一次费、结果不丢（`docs/06-ai.md` §4–5）。这是模板中失败模式最多的链路，放在文本对话验证完计费流程之后实现（`docs/08-roadmap.md` Phase 4）。

## What Changes

- `MediaProvider` 抽象与首个实现 fal.ai（队列 API + webhook）。
- 媒体服务商注册表：任务按 `ai_model.provider` 选择服务商，`template.config.ts` 声明启用哪些服务商；新增服务商只需新增一个定义。第二个实现为 Workers AI 图片（同步产出，经 `AI` 绑定调用，无需外部账号）。
- `AiMediaWorkflow`：幂等提交 → 检查已落库回调 → 等待回调（超时转轮询）→ 转存 R2（大文件分片）→ 结算 → 站内通知。
- 媒体回调入口：自签 HMAC + 服务商签名校验，结果先落库再通知 Workflow。
- 任务提交：同一事务内加空间锁、检查并发数、创建任务（含定价快照与幂等键）、预扣；之后启动 Workflow。
- 注册媒体任务的超时兜底处理器：按 Workflow 实例状态补做结算，超过硬超时则终止并释放。
- 文件存储：R2 预签名直传（声明 → 上传 → 确认真实大小与配额）、`file` 表、鉴权下载、存储配额、未确认上传与软删文件的清理；可选公开分享链接。
- 任务列表 / 详情页（轮询，指数退避）、由参数 schema 渲染的参数表单。

## Capabilities

### New Capabilities
- `ai-media-tasks`: 图片 / 视频生成任务的提交、状态、计费结算、取消与可靠性保证。
- `file-storage`: 用户上传与 AI 产出文件的上传、访问控制、配额与清理。

### Modified Capabilities
（无。计费方式与定价快照沿用 `add-ai-text-chat` 的 `ai-model-registry`。）

## Impact

- 依赖 `add-ai-text-chat`（模型注册表、计费方式）与 `add-billing-and-credits`（预扣、超时回收框架、权益）。
- 新增表：`ai_task`、`file`。
- 新增外部服务（均可选，由模板配置启用）：fal.ai、Workers AI；R2 的 S3 兼容 API 令牌（`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`）。
- `apps/jobs` 中的 `AiMediaWorkflow` 从 Phase 0 的空实现变为正式实现。
