# Design

## Context

- 媒体服务商经 `packages/ai/src/media/registry.ts` 的 `mediaProviderDefinitions` 登记（目前 fal、workers-ai），
  `MediaProvider` 接口为 submit / getStatus / parseWebhook / cancel；`template.config.ts` 的 `ai.media.providers` 控制启用。
- `ai_model` 一行绑定一个 `provider + providerModelId`，参数 schema 直接是服务商原生字段名，提交时原样透传。
- `plugins/media/src/jobs/media-runner.ts` 的 Workflow：提交一次（无幂等能力时不重提）→ 等回调（15 分钟）→ 轮询（30 秒起、最多 5 分钟一次）直到硬超时 2 小时；
  回调地址带任务签名，回调处理会核对作业 ID 与任务记录一致。
- 调研结论（2026-11-27）：Replicate 官方模型价格与 fal 相同，有回调，但 API 产出 1 小时后删除；
  kie.ai 价格约为 fal 的一半，有带签名的回调，产出保留 14 天，但未声明与 Google / OpenAI 的官方合作。

## Goals / Non-Goals

**Goals:**
- Replicate、kie 以与 fal 同等的可靠性接入（验签、白名单、只提交一次、回调丢失可查询）。
- 主渠道故障时自动切换，用户无感、扣费不变；文本与媒体共用同一份备用链配置与错误分类口径。

**Non-Goals:**
- 按成本或健康度的自动选路、熔断器与服务商健康评分（后续需要再加）。
- 文本输出开始后的中途换模型（续写依赖同一模型的能力，且会让用户看到风格突变）。
- 因「运行太久」而切换：已受理的作业可能仍在生成，切换会重复花费。
- 向用户展示实际服务商或按备用价格计费。
- 同步服务商（workers-ai）参与切换：首版只在异步服务商之间切换。同步服务商作为主模型时其生成失败不切换；作为备用时受理阶段跳过（`skipped` 记 `synchronous_provider`）。

## Decisions

### D1 直接用 fetch 实现适配器，不引入 SDK
与 fal 一致，Worker 体积小、错误与日志可控，免去 `third-party-deps.json` 映射。
- **Replicate**：官方模型用 `POST /v1/models/{owner}/{name}/predictions`（`providerModelId` 填 `owner/name`，
  带版本号时用 `/v1/predictions`），`webhook_events_filter: ["completed"]`；查询 `GET /v1/predictions/{id}`，取消 `POST .../cancel`。
  回调按 Standard Webhooks 校验（`webhook-id` / `webhook-timestamp` / `webhook-signature`，HMAC-SHA256，
  密钥由 `GET /v1/webhooks/default/secret` 取得后存为 `REPLICATE_WEBHOOK_SECRET`），并拒绝超过 5 分钟的时间戳。
- **kie.ai**：首版只支持统一任务接口（`createTask` + `callBackUrl`，`recordInfo` 查询）；只能走专用接口的模型（如部分 Veo 端点）首版不支持，
  登记时拒绝。回调验签按其 webhook-verification 文档实现（格式实施时核对）。
- 两者 `idempotentSubmit: false`，沿用现有「不确定即不重提」路径。产出域名白名单实施时以真实回包确认后写死精确主机名。
- 备选：官方 SDK（`replicate` npm）——增加依赖与 Worker 体积，且回调验签仍需自写，不采用。

### D2 备用链挂在模型上，以 key 引用
`ai_model.fallbacks jsonb not null default '[]'`，元素 `{ modelKey, paramMap?: Record<主字段, 备用字段> }`，最多 2 个。
用 key 而不是 id 引用，便于 Admin MCP 与跨环境导入；删除模型时在同一事务内从引用它的链中移除。
- 备选：独立的「逻辑模型 → 多个实现」表。更规范，但要改模型选择、权益与定价的全部读取路径，首版代价过大。

### D3 统一错误分类决定是否切换
新增 `MediaFailure` 分类：`unavailable`（未配置 / 未启用）、`rate_limited`、`provider_error`（5xx、上游内部错误）、`auth`、
`rejected_input`、`content_policy`、`ambiguous`。前四类可切换，后三类不可。
各适配器把 HTTP 状态与上游错误类型映射到分类（fal 的 `error_type`、Replicate 的 `error` 文本、kie 的 code），未知错误按 `provider_error`；
映射表与单测覆盖每个服务商的真实错误样例。

### D4 尝试记录与回调归属
- `ai_task` 新增 `provider_attempts jsonb not null default '[]'`，每项 `{ provider, modelKey, providerModelId, jobId?, failure?, at }`；
  `provider`、`provider_job_id` 与输入中的 `providerModelId` 始终表示**当前**尝试。
- 每次尝试使用新的 `provider_request_key`（原值 + `:a{n}`），回调地址签名包含尝试序号；
  回调处理先按 URL 中的尝试序号选服务商验签，序号不是当前尝试时返回 200 并忽略（避免服务商重试风暴）。
- 定价快照、`unitsLimit` 与预扣在任务创建时按主模型确定，切换不改动。

### D5 Runner 中的切换点
- **接受时**：Web 端提交时按 `[主模型, ...备用]` 过滤出已启用且已配置的候选，空则按现有规则拒绝；第一个候选作为初始尝试。
- **提交时**：提交返回可切换错误 → 记录尝试 → 下一候选；`ambiguous` 走现有「提交确认中」。
  不确定标记优先（协调者 2026-11-27）：提交阶段的 5xx / 408 / 网络异常 / 无法解析的回包，三个适配器都标为
  `submissionOutcome='ambiguous'`（Replicate 的 failure kind 虽为 `provider_error`，不确定标记同样置位），一律走「提交确认中」，
  不重提、不切换；只有明确未受理（`submissionOutcome='rejected'`，如 429、401/403、回包明确拒绝）且分类可切换时才切换。
- **完成时**：回调或查询得到失败且分类可切换 → 同上。
- 切换前检查距硬超时 ≥ 20 分钟；Workflow 步骤名带尝试序号，保证重放确定性。
- 每个候选在提交前按 `paramMap` 改名后用其自身 schema 重新校验，不通过则视为该候选不可用（记录 `rejected_input`）并继续下一候选。

### D6 后台与 MCP
- 模型编辑页增加「备用模型」有序列表（选择模型 + 可选参数映射），属小型表单改动，按设计规范免设计稿。
- 任务详情显示尝试记录。Admin MCP `models.create` / `models.update` / `models.get` 增加 `fallbacks`，
  同 PR 更新参数说明与 `docs/admin-mcp.md`；保存校验与后台共用同一函数。

### D7 文本：在模型层包装备用链
- 新增 `fallbackLanguageModel(candidates, { onFallback })`，实现 AI SDK `LanguageModel` 接口：
  `doGenerate` / `doStream` 依次尝试候选；`doStream` 读取首个分片，若在任何文本、推理或工具调用分片之前出现错误，
  且错误可切换（未配置、`APICallError` 的 429 / 5xx / 401 / 403、网络异常），关闭该流并尝试下一候选；首个内容分片之后的错误原样透传。
- 候选在首次使用时才经现有 `LanguageModelFactory` 构造，未配置的服务商（`AI_PROVIDER_NOT_CONFIGURED`）直接跳过。
- 包装位于模型层，因此对话（`text-stream.ts`）、后续问题（`generateText`）与 agent 的每一步（多步 `streamText`）都自动获得切换，
  无需改动各自的重试与结算逻辑；对话现有「同模型重试 2 次」在整条备用链都失败后才生效。
- 计费：定价快照、预扣与 token 上限都按主模型；失败尝试的估算用量沿用现有 `absorbed` 口径，不向用户收费。
- 约束：主模型带「支持工具调用」时备用也必须带；思考 / 续写能力按各自模型的 capabilities 处理（包装器把当前候选的 provider 交给调用方）。
- `onFallback` 写日志 `ai.text.failover`，并把实际模型 key 记入对话消息或 agent 轮次的元数据，供后台查看。
- 备选：在 `text-stream.ts` 的重试循环里换模型——只覆盖对话，agent 与后续问题要各写一遍，不采用。

### D8 观测与故障注入
- 日志 `ai.media.failover`（taskId、from、to、failure），不含参数与提示词。
- 扩展 `ai-fault-injection` 的媒体故障模式，新增「服务商限流」与「服务商作业失败（可切换）」，用于 staging 验收切换路径而不依赖真实故障；文本复用 `ai-fault-injection` 现有的 `before-stream` 阶段注入可切换错误。

## Risks / Trade-offs

- [同名参数语义不同（如时长单位、分辨率档位）] → 保存时只能校验类型与枚举；`configure-feature-model` / `add-ai-model` 技能要求为每对主备做一次真实生成验收。
- [切换后成本高于定价] → 运营成本由站点承担；后台任务详情与日志可统计切换率，切换率高时应调整主渠道。
- [Replicate 产出 1 小时删除] → 回调路径下立即转存；回调丢失时首次查询在 15 分钟后，最长轮询间隔 5 分钟，留有余量；转存失败的重试总时长须小于 30 分钟。
- [kie 渠道可能违反上游条款、随时失效] → 默认不启用；文档注明风险，建议只作低价档主模型或最后一位备用，不承载 Google / OpenAI 模型的唯一通道。
- [文本备用模型上下文窗口较小，主模型预算下的输入被拒] → 保存时提示管理员核对；被拒属 `rejected_input` 不再继续切换，按现有失败退款。
- [作业实际已产出却回报失败，切换导致重复花费] → 只对明确的服务商侧失败切换，次数受备用数量限制。
- [切换到下一尝试后、尚未向新服务商提交时用户取消] → 按「未开始」免费取消（`free_unstarted`），不消耗已开始免费次数：上一尝试已失败或被明确拒绝，用户不应为失败的尝试付费。
- [Workflow 重放时凭据被移除或恢复] → 每个尝试开始时在持久步骤内读数据库当前尝试并判定服务商可用性；「不可用」切换在锁内核对该尝试从未提交（无作业 ID、无提交标记、非提交确认中），否则拒绝切换并按原错误失败，避免重复生成。
- [旧尝试的唤醒事件残留] → 事件带尝试序号，序号不符时按原定截止时间继续等待。
- [web 先于 jobs 部署] → 旧 jobs 不认识候选快照，受理时已改用备用的任务会以主模型参数调用备用服务商，也不会切换；升级须按迁移 → jobs → web 的顺序部署（staging 与生产流水线已如此）。

## Migration Plan

1. 迁移新增两列，默认空数组，不影响现有任务与模型。
2. 部署后未启用新服务商、未配置备用时行为不变。
3. 取得密钥后：写入 Wrangler secrets → 启用服务商 → 登记模型 → 配置备用 → staging 用故障注入与真实生成验收。
4. 回滚：清空模型的 `fallbacks` 并从启用列表移除新服务商即可；列保留无害。

## Open Questions

- kie 回调签名的确切格式与产出域名、Replicate 产出域名：实施时按官方文档与真实回包核对，不影响方案。
  - kie 已按文档核对（2026-11-27，任务 4.1）：`base64(HMAC-SHA256(taskId + "." + X-Webhook-Timestamp))`，密钥为设置页的 webhookHmacKey，存为 `KIE_WEBHOOK_SECRET`；签名不覆盖正文，回调只作通知、结果以 recordInfo 为准；产出主机取文档示例 `tempfile.aiquickdraw.com`、`file.aiquickdraw.com`、`static.aiquickdraw.com`，待 8.2 真实回包确认。
- 首批登记哪些主备模型对：使用者取得密钥后一起确定。
