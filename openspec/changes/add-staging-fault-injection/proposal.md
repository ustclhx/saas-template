# Proposal

## Why

staging 的媒体 7.1/7.2 与 chat 5.1 仍缺受控故障证据，现有 runbook 的人工注入不能稳定重跑。增加只限 staging 管理员的故障模型与验收套件，让失败退款、轮询恢复和幂等保护通过真实业务链路得到可重复验证。

## What Changes

- 包装现有 fal、Workers AI 和文本 Provider，不引入全假 staging Provider；故障模式来自后台模型配置，普通用户不可见且接口不可选。
- 增加显式 `AI_FAULT_INJECTION=enabled` 闸门；只允许 staging，production 或未明确标记的环境配置该开关时校验失败。关闭时保留正常模型原有行为，故障模型停止可见与可用。
- 覆盖 Workers 推理失败及硬超时；fal 回调丢失、回调早到、提交响应丢失、服务商失败及硬超时；文本流前与流中报错分别覆盖 token / per_call 两种计费。
- 验收脚本经后台模型编辑器创建或启用专用 `acceptance-fault-*` 模型，并在 finally 停用；复用管理员登录、只读对账与脱敏证据工具，不直接写 staging 数据库、不写迁移种子。
- 故障任务冻结模式与经评审的固定短 deadline，保留真实 request ID 和最小执行证据；断言终态、预扣结算、一次提交/结算及对账不变式。
- 此 change **不覆盖** Gateway 日志 token 差异比对、fal 视频成功产出、超长 chat 断开与回收验收；这些仍走常规验收，原 media 7.1/7.2、chat 5.1 不因套件实现完成而勾选。

## Capabilities

### New Capabilities

- `ai-fault-injection`: staging 故障模型的配置、访问闸门、真实 Provider 包装及故障生命周期。
- `staging-fault-acceptance`: 故障模型的受控准备与停用、场景断言、重跑保护和可审计证据。

### Modified Capabilities

无。现有 `runtime-config` 与 `staging-deployment` 的加载、校验及 main 自动部署契约保持；新故障专用约束由上述能力定义。未归档的媒体/文本 change 的正常计费和失败语义保持。

## Impact

- `packages/ai`：模型元数据解析、模型访问过滤、媒体/文本 Provider 包装和媒体任务快照；`packages/db/src/schema/ai.ts` 仅扩展检查点 JSON 的可选 TS 证明类型，不改数据库列。
- `packages/config` 与 apps 的 env 装配：显式 staging 校验；`apps/{web,jobs}/wrangler.jsonc` 仅 staging vars 增加开关。
- `apps/web`：后台模型 JSON 编辑校验、所有列表/调用入口的管理员闸门、真实签名回调的任务级处理。
- `apps/jobs`：runner 的持久延迟/短等待与 deadline、自检和故障证据保留，沿用现有结算与 DB-only 回收器。
- `apps/web/e2e/staging-acceptance`、本地 Provider 测试与 runbook：故障套件和证据。复用现有 JSONB 存储，不增加数据库列、迁移或依赖；若实施发现必须更改这些边界，先交协调者审阅。
- 阶段一仅提交本 change 的规划文件；提案合并并得到协调者通知后才实施。实施不手动部署、不改 secrets、不运行 staging 验收；合并发布后由协调者执行。
