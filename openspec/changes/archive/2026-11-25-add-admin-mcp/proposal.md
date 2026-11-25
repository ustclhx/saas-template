## Why

衍生项目的运营配置（功能所用模型、开关、价格等运行时设置，模型启停与定价）目前只能由人登录后台页面修改。使用者希望 agent（Claude Code 等）直接负责这些配置：新功能上线时由 agent 选好模型并验证，不再要求人去后台操作。需求来自 xuanxue（R8、R9，2026-11-24），使用者决定先做进模板，衍生项目经 template-sync 采纳；agent 功能完成后统一规划开发（2026-11-24）。

同时，「某功能没单独选模型时沿用相近功能的模型」（xuanxue PR #311）在多个功能间反复出现，但模板没有按功能选择模型的运行时设置，各项目只能各写一套。

## What Changes

- 新增 `admin-mcp` 插件（Cloudflare 与 Node 双目标，模板默认启用）：
  - 管理员个人 API 令牌：管理员在后台为自己创建、查看、吊销令牌；令牌只存哈希，完整值只在创建时显示一次；必须设置过期时间（默认 90 天）；scope 为 `admin:read` / `admin:write`；每次使用实时校验所属用户仍是未封禁的平台管理员。令牌不能登录网页。
  - 远程 MCP 端点 `/api/admin/mcp`（Streamable HTTP、无会话、`Authorization: Bearer`），按 MCP 规范处理 initialize、tools/list、tools/call；每令牌限流、请求体上限、`Cache-Control: no-store`。
  - 第一期工具。读：运行时设置、AI 模型、用户、空间、订单、积分流水、审计、指标、功能模型。写：`settings.set`、`models.update`，均支持 `dryRun`。明确不提供退款、删除或封禁用户、积分调整、支付平台写操作、模拟登录。
  - 每次工具调用（含只读）写审计，`meta.via = 'mcp'`，带令牌 id、工具名、脱敏后的参数摘要与结果；写工具复用后台同一 `adminAction` 包装与校验，审计新旧值格式与后台保存一致。
- 运行时设置定义化：每个设置项登记类型 schema、默认值与是否为密钥；新增项目自有文件登记项目设置项（template-sync 保留），后台、MCP 与读取路径共用同一套校验。密钥类设置经 MCP 只返回「已设置 / 未设置」。
- 功能模型设置与沿用（R9）：项目登记「功能 → 模型种类 + 沿用顺序」；每个功能对应一个运行时设置项；解析时显式选择优先，空值按沿用顺序取第一个可用的模型，返回模型与来源（显式 / 沿用自某功能 / 未配置）；后台设置页新增功能模型分组，MCP `settings.get` / `features.models` 标出沿用来源。
- 文档：管理员令牌与 MCP 配置（含 Claude Code `claude mcp add --transport http`）、工具清单、审计查看；新增技能说明「新功能上线时由 agent 配置模型并验证」。

不在本次范围：OAuth 授权流、令牌给非管理员使用、只读之外的用户/计费写操作、MCP 资源与提示词（resources/prompts）、服务端推送通知、按令牌限定 IP。

## Capabilities

### New Capabilities

- `admin-mcp`: 管理员 API 令牌生命周期与校验、MCP 端点协议与安全约束、工具清单与 scope、审计与 dryRun。
- `feature-models`: 项目登记的功能模型设置、沿用顺序与解析来源，以及后台与 MCP 中的展示。

### Modified Capabilities

- `runtime-config`: 运行时设置项改为带 schema、默认值与密钥标记的定义表，支持项目自有设置项；写入前统一按定义校验。

## Impact

- 新增 `plugins/admin-mcp`；新依赖 `@modelcontextprotocol/server`（v2，与锁文件中已有的 client/core 同版本，精确锁定）。
- `packages/db`：迁移新增 `admin_api_token` 表；`settings.ts` 改为定义表并新增 `settings.project.ts`（项目自有）。
- `packages/ai`：功能模型登记（项目自有文件）与解析函数。
- `apps/web`：后台设置页新增功能模型分组；后台读写逻辑从 `*.functions.ts` 中抽出可复用的服务端函数，供 MCP 工具与后台共用；后台导航新增「API 令牌」页（经插件 `adminNav`）。
- 生成器与 template-sync：插件选项、项目自有文件保留列表；文档 `docs/plugins.md`、`docs/` 新增 admin MCP 一节。
- 新页面（令牌管理）与设置页布局改动需先经 `ui-design` 取得使用者确认。
