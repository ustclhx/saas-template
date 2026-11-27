---
name: add-ai-model
description: 在本模板配置文本、图片或视频模型的参数、定价和套餐授权；优先使用后台模型管理，只有新增 Provider 能力时扩展源码。
---

# 添加 AI 模型

定位含 `package.json` 与 `template.config.ts` 的项目根，路径均相对根目录。先读 `AGENTS.md`、`docs/06-ai.md` §1–3；媒体模型再读 §4–5，跨平台修改读 `docs/platform-capabilities.md`。执行命令前读取包 manifest，生成项目用自己的 scope 替换示例 `@saas`。

## 1. 区分模型配置与新 Provider

确认种类、模型 key、provider、服务商真实 `providerModelId`、参数、定价、允许套餐、部署目标和验收环境。运行时模型数据在 `packages/db/src/schema/ai.ts` 的 `ai_model`，后台入口是 `/admin/models`，实现见 `apps/web/src/routes/admin/models.tsx`、`apps/web/src/features/ai/admin-models.functions.ts`。

已有 Provider 的新模型优先在后台新建/复制，复用现有 schema 编辑器与保存校验；无需改源码或迁移。当前文本入口 `packages/ai/src/text/model.ts` 支持 openai、anthropic、google、deepseek；媒体注册见 `packages/ai/src/media/registry.ts`。OpenAI 兼容服务也可使用管理员配置的 openai 直连入口。核对具体模型的官方协议/参数后再配置，不能把同 Provider 模板视为通用协议。

`template.config.ts` 控制文本/媒体开关、媒体 Provider 列表和默认定价模式；AI 要求 billing 与 credits 同时启用。模型记录保存 schema/价格/标签，端点与 key 属于部署配置，不放进模型记录。保存后台模型是目标环境写入，遵守用户指定环境；用户只要求准备方案时交付字段清单而不操作后台。

完成标准：确认已有 Provider 能否支持，并将工作限定为后台配置或必要的 Provider 扩展。

## 2. 配置参数、定价与权限

后台先用「Insert reference template」，核对覆盖原 JSON 的影响，再填写模型实际参数。参考与保存校验在 `apps/web/src/features/ai/admin-model-params.ts`。

- 文本 `params_schema` 可为 `{}`；`x-text` 只允许 `tokensPerChar`（正数）、`maxOutputTokens`（正整数）、可选 `thinking`（boolean）与 `continuation`（native/none）。默认系数 1、输出 4096、continuation none。thinking/续写还须 `packages/ai/src/text/capabilities.ts` 的 adapter 支持，设置 schema 不会创造新能力。
- 为 Agent 配置文本模型时，核对具体 `providerModelId` 与目标出口支持工具调用，再启用后台「支持工具调用」（`supportsTools`，数据库 `supports_tools`，默认关闭）。Agent 的模型列表和执行都要求此标记及正常套餐权益。媒体模型始终关闭该标记。工具规则见 `docs/06-ai.md` §8。
- 媒体 `params_schema` 使用 `packages/ai/src/media/params.ts` 的 `parseMediaSchema`；现有表单支持平面 string/number/integer/boolean、枚举与范围，嵌套对象需另行设计。参数名、默认值和边界与服务商协议一致。
- `pricing` 由 `packages/ai/src/pricing.ts` 校验：token、per_call、per_unit。按次文本必填 `limits.maxInputTokens` 和 `limits.maxOutputTokens`；按单位媒体需要真实可获得的 image/second 用量，不能把任务运行时间当作视频秒数。积分计算向上取整，复用现有预算与定价快照。
- 模型 key 或标签（数据库 `min_plan_features`）必须匹配套餐 `features.models` 的授权；核对 `/admin/billing/plans` 与 `packages/entitlements/src/index.ts`。启用模型不等于所有用户可用；提交还检查空间权益、积分余额、并发和限流。通过既有 billing/credits 流程解决授权与余额，不直接改账本。

- 备用模型（主备）：在后台模型编辑页「备用模型」或 Admin MCP `models.update` 的 `fallbacks` 中，按顺序为模型指定至多 2 个同类型、服务商与主模型及彼此不同的已登记模型；备用可保持停用、无需套餐授权，用户只看到并按主模型付费。主模型尚未产出内容时服务商侧失败（未配置、限流、5xx、鉴权）才切换，参数、内容审核和结果不确定不切换。规则见 `openspec/specs/ai-model-registry/spec.md`「备用模型配置」与 `ai-media-tasks` / `ai-text-runtime` 规格（change `add-media-provider-fallback` 归档前见其 design 与 specs）。
- 参数映射：媒体备用字段名不同时声明 `paramMap`（主字段 → 备用字段，如 `image_size → size`），未列出的字段同名透传。保存校验（`packages/ai/src/models.ts` 的 `validateModelFallbacks`，后台与 MCP 共用）要求主 schema 每个字段映射后被备用接受（类型一致、枚举为子集、范围被覆盖）、备用必填项有来源、计量字段（`num_images` / `duration`）一一对应；文本主模型开启「支持工具调用」时备用也必须开启，文本不支持映射。拒绝信息 `MODEL_FALLBACK_INVALID` 指出模型 key 与字段，按提示改映射或换备用；不要为通过校验而删减主模型参数。
- 保存校验只比对类型与取值，无法发现同名参数语义不同（时长单位、分辨率档位、风格差异）。每一对主备都要按 §5 用真实生成各验收一次。

先保存停用记录，复核 schema、价格和目标 Provider 配置后启用。保存服务会做管理员校验、审计并调用 `packages/ai/src/models.ts` 的缓存失效；列表存在缓存，提交前会直接读库复核。已提交调用继续用自己的参数与定价快照。

完成标准：schema/定价保存校验通过；允许与不允许的套餐、目标能力和余额条件都已列明。

## 3. 凭据与目标能力

Cloudflare 文本默认 Gateway/BYOK，Node 默认 OpenAI 兼容直连；选择依据是 `AI_TEXT_EGRESS`，细节见 `docs/06-ai.md` 的「Gateway 与密钥」和 `packages/config/src/node-schema.ts`。Gateway 的 account/id 是公开配置，token/Provider key 是 secret。直连使用部署管理员配置的 `OPENAI_BASE_URL` 与 key，普通聊天请求不能选择端点；DeepSeek 的 direct 分支与缺 key 时的 Gateway 路径按现有实现处理。

本地 AI 密钥放 app 的已忽略 `.dev.vars` 或 Node 配置支持的 secret 文件；根 `.env.local` 的 dev 支付同步只加载支付项。输出配置键名和缺项，不输出值。取得/填写 key 按 `docs/07-infrastructure.md` §4；本技能不替用户申请账号或默认写云端 secrets。

Cloudflare Workers AI 图片要求真实 `AI` binding；Node 不提供 Workers AI，后台和模型列表会过滤并在提交端复核。fal 与媒体持久任务依赖当前运行时装配的 workflow、storage 等能力，检查 `apps/web/src/server/runtime.ts`，能力不可用时应在 task/hold 副作用前报告。不要用模板启用状态替代能力检查。

完成标准：选择的模型、Provider 与实际部署目标能力相符；缺凭据或外部环境时首次真实调用明确记为未验收。

## 4. 仅在新 Provider 时扩展

先读 `docs/01-architecture.md`、`docs/02-project-structure.md`，确定变更范围：

- 文本在 `packages/ai/src/text/model.ts` 接入已有 LanguageModelFactory；有 thinking/续写能力才扩展 `text/capabilities.ts`。key/env 增项同步对应 Cloudflare/Node 配置和 composition，保持 SDK 运行时兼容；协议逻辑不放页面。
- 媒体实现 `packages/ai/src/media/provider.ts` 的 MediaProvider 或 SyncMediaProvider，并在 `media/registry.ts` 注册 supportedKinds、配置判定、同步/幂等能力和精确 outputHosts。异步提交保持 provider_request_key、原始请求验签、先回调落库后唤醒、超时查询和结算边界；不确定的非幂等提交不能盲重试。
- 新媒体 Provider 同步更新 `packages/config/src/template.ts` 的 `MediaProviderId` 与默认配置，并在 `template.config.ts` 启用所需 Provider；更新 `scripts/create-project.mjs` 的允许列表、密钥/资源清单和关闭功能时的裁剪，扩展 `scripts/create-project.test.mjs` 的相关生成器回归用例。按需补 web/jobs Wrangler bindings 与 `packages/config/src/node-schema.ts`、`apps/web/src/node/runtime.ts`、`apps/jobs/src/node/runtime.ts` 的 env/composition；配置、生成项目与运行时装配必须一致，只有受支持目标才提供能力。
- 下载复用 `packages/storage/src/media-validation.ts`，按 Provider 精确主机白名单限制重定向、大小和 MIME；不要增加通配域名绕过 SSRF 边界。
- 后台 Provider 可用性校验见 `apps/web/src/features/ai/admin-model-provider.ts`；新增配置或能力同时覆盖这里及注册表可见性。平台调用经 platform 中立入口，业务包不直接导入 cloudflare:workers。

完成标准：新增能力沿用现有接口，核心成功/失败、未知 usage、幂等与目标能力缺失分支通过相关现有测试或必要的精简回归测试。

## 5. 验收与故障处置

源码变更时在根目录执行：

```sh
pnpm check
pnpm check:deps
pnpm check:singletons
pnpm --filter @saas/ai test
pnpm --filter @saas/web test --project unit src/features/ai/admin-model-params.test.ts src/features/ai/admin-model-provider.test.ts
pnpm typecheck
git diff --check
```

按目标完成 build 或 build:node；新增媒体服务再运行受影响的 storage/jobs 测试，范围以对应 manifest 为准。仅配置后台模型时无需为未改源码增加测试，复用编辑器校验并核对保存/列表/权限行为。
修改生成器时执行 `pnpm test:create-project`；有新增配置组合时在一次性副本验证生成结果及目标构建，使用现有 `pnpm test:create-project:verify` 承载需要真实生成/安装的验收。

用户已授权真实服务调用时，以允许套餐且有足够积分的本地/测试空间发起一次调用：文本检查流式输出、最终状态、定价快照与 hold 结算；媒体检查提交、终态、文件落存储和预扣释放/扣款。复核禁止套餐或余额不足在外部调用前拒绝。真实调用会消耗服务商额度，配置准备本身不代表调用授权。测试 fixture 和假 fetch 仅证明离线行为。

验收 Agent 模型时，先核对开关保存后的模型可选性，再用同一出口验证一次工具调用及续步。未执行真实工具调用时记录待验收。

验收主备时，对每一对主模型与备用模型各做一次真实生成（调用已获授权、使用测试空间）：先用与主模型相同的输入（按 `paramMap` 改名）直接调用备用模型生成一次（例如在 staging 临时启用备用并授权给测试空间，验收后恢复原状态），确认产出与主模型同等的规格（图片张数与尺寸、视频时长与分辨率）；再在 staging 用故障注入（`ai-fault-injection` 的服务商限流或可切换作业失败、文本 `before-stream`）让主模型失败，核对任务尝试记录 / 对话实际模型显示已切换、用户按主模型定价结算、全部失败时全额退回。每对的结果与证据写入 `EVIDENCE_DIR`，未验收的主备对在交付中列为待验收，不要只凭保存校验通过就视为可用。

- `PARAMS_SCHEMA_INVALID`：检查 JSON 对象、x-text 类型/未知键或媒体平面 schema，按具体模型模板修正。
- `MISSING_TOKEN_LIMITS`：补齐按次文本的两项 token 上限。
- `MODEL_FALLBACK_INVALID`：按信息中的模型 key 与字段修正备用选择或 `paramMap`；同服务商、自身、不同类型和超过 2 个备用都会被拒绝。
- `MODEL_UNAVAILABLE` / `UPGRADE_REQUIRED`：检查启用、目标能力、pricing 与套餐 key/标签。
- `AI_PROVIDER_NOT_CONFIGURED` / 能力不可用：报告缺少的配置名称/能力；补配置后重验，保留未验收状态。
- 余额不足：通过既有积分流程准备测试空间；有失败产出时按现有退款规则核对账本，避免额外扣费或伪造成功。

交付配置字段或修改文件、实际命令及结果、目标能力与套餐/余额检查，以及未执行的外部调用和部署。
