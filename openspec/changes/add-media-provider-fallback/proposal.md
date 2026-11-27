# Proposal

## Why

图片与视频生成目前只走 fal，文本模型也只绑定单一服务商：fal 新账号并发只有 2，遇到限流、故障或密钥失效时任务直接失败退款，没有第二条路。
2026-11-27 的服务商调研后，使用者确定 fal 为主渠道、Replicate 为备用渠道、kie.ai 为成本备用渠道，并会申请三家的密钥；随后要求文本模型也加上同样的备用机制。

## What Changes

- 新增 Replicate 与 kie.ai 两个媒体服务商实现（异步提交、回调验签、状态查询、产出域名白名单），
  在 `template.config.ts` 的 `ai.media.providers` 中可选启用，密钥放 Wrangler secrets。
- 模型登记新增「备用模型」：每个文本、图片或视频模型可按顺序指定至多 2 个同类型备用模型（可在其他服务商），
  并可声明参数改名映射。后台模型编辑页与 Admin MCP `models.*` 工具同步支持。
- 媒体任务新增自动切换：主模型的服务商未配置、提交被明确拒绝（限流、5xx、鉴权失败），
  或作业因服务商侧原因失败时，任务按顺序改用下一个备用模型重新提交；内容审核拒绝、参数错误与「提交结果不确定」不切换。
- 文本模型（对话、后续问题建议、agent 每一步）在**尚未输出任何内容**前遇到服务商侧失败（未配置、限流、5xx、鉴权失败）时，
  改用下一个备用模型；已开始输出后不切换，沿用现有的重试与续写规则。
- 用户只看到并支付主模型：预扣与结算仍按提交时主模型的定价快照，切换不改变用户扣费；
  任务记录实际执行的服务商与模型，并记录切换原因，供后台与审计查看。
- kie.ai 的「成本」用途不做自动路由：管理员可把 kie 模型设为某模型的主模型（低价档）或排在最后的备用。
- 第三方登记表、`docs/06-ai.md`、`docs/admin-mcp.md` 与模型配置技能同步更新。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `ai-media-tasks`：服务商可插拔扩展到 Replicate / kie；新增备用模型自动切换、切换后的计费与回调归属规则。
- `ai-model-registry`：模型可配置有序备用模型及参数映射，保存时校验类型、服务商与参数兼容性。
- `ai-text-runtime`：文本调用在首个输出前按备用顺序切换，计费仍按主模型。

## Impact

- 代码：`packages/ai/src/media/`（新增 `replicate.ts`、`kie.ts`，`registry.ts`、`provider.ts` 错误分类）、
  `packages/ai/src/models.ts`、`packages/ai/src/text/`（备用模型包装）、`apps/web/src/features/ai/`（对话与后续问题）、`plugins/agents`（agent 运行器）、`plugins/media/src/jobs/media-runner.ts` 与 `src/web/media-tasks.ts`（切换与回调归属）、
  后台模型编辑页、`plugins/admin-mcp` 的模型工具。
- 数据：`ai_model` 新增 `fallbacks`（jsonb）；`ai_task` 记录切换历史（复用现有 jsonb 字段或新增列，见 design）。需要一条迁移。
- 配置与密钥：新 secrets `REPLICATE_API_TOKEN`、`REPLICATE_WEBHOOK_SECRET`、`KIE_API_KEY`（kie 回调验签密钥按其文档确定）。
- 第三方：Replicate、kie.ai 进入 `docs/third-party.md`；不引入官方 SDK 时无需 `third-party-deps.json` 映射。
- 衍生项目：新增能力默认关闭（未启用服务商、未配置备用即与现状一致），非破坏性升级。
