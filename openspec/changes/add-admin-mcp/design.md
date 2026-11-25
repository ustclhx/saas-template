## Context

- 后台写操作统一走 `apps/web/src/features/admin/action.ts` 的 `runAdminAction`：写事务内加共享锁实时校验管理员角色，handler 必须在同事务写审计。后台读写的业务逻辑已部分抽在非 `*.functions.ts` 模块中（`settings.ts` 的 `readRuntimeSettings` / `writeRuntimeSettings` / `invalidateRuntimeSettings`，`users.ts`、`audit.ts`、`metrics.ts`、`credits.ts` 等），模型管理的校验仍在 `features/ai/admin-models.functions.ts` 内。
- 运行时设置是 `packages/db/src/settings.ts` 中的封闭接口 `SettingValues` + `settingDefaults`，只对 `credits.daily*` 做取值校验，项目无法在不修改模板文件的情况下新增设置项。
- 插件系统（add-plugin-system）提供：插件路由（可挂到根）、`adminNav`、`@web/*` 别名（插件路由与 web 入口可用）、双目标构建；数据库迁移统一在 `packages/db`。
- 公开 API 的 API Key 基于 Better Auth `apiKey` 插件，绑定空间、受 `features.publicApi` 开关控制，语义是「空间调用 AI」，与「平台管理员操作后台」不同。
- 锁文件中已有 `@modelcontextprotocol/client` / `core` 2.4.0（经 agents 依赖引入）；对应的服务端包为 `@modelcontextprotocol/server` 2.4.0。
- 需求来源：`~/.claude/codex-specs/saas-template/2026-11-24-admin-mcp-from-xuanxue.md`（R8）与 xuanxue PR #311（R9）。

## Goals / Non-Goals

**Goals:**
- agent 用管理员个人令牌，经远程 MCP 读取全部后台数据、写运行时设置与 AI 模型，权限、校验与审计与后台完全一致。
- 运行时设置可由项目扩展且有统一 schema，使 MCP「写任意设置」安全可行。
- 通用的「功能模型 + 沿用」能力，替代各项目自写的沿用逻辑。

**Non-Goals:**
- OAuth / 动态客户端注册；非管理员令牌；MCP resources / prompts / 服务端通知；有会话的 SSE 流。
- 退款、用户删除或封禁、积分调整、支付平台写操作、模拟登录（即使后台已有）。

## Decisions

### 1. 以双目标插件 `admin-mcp` 交付，模板默认启用
MCP 是可选能力，按插件交付可在构建期整体移除（路由、依赖、文案）。端点用插件路由（TanStack server route，挂到根的 `routes/api/admin/mcp.ts`），Cloudflare 与 Node 共用，无需 Worker 绑定或前置 fetch 处理。令牌管理页与后台导航经插件 `routes/admin/...` 与 `adminNav` 加入。`admin_api_token` 表与迁移按约定放在 `packages/db`（插件停用时表保留但无入口，同 agents 的 `ai_agent_turn`）。
备选：做进核心——无法在不需要的项目中移除依赖与端点，否决。

### 2. 独立的 `admin_api_token` 表，不复用 Better Auth apiKey
字段：`id`（UUIDv7）、`user_id`（FK user，删号级联）、`name`、`prefix`（`xat_` + 8 位，用于展示与查找）、`token_hash`（SHA-256 hex，唯一）、`scopes`（text[]，`admin:read` / `admin:write`）、`expires_at`（必填）、`last_used_at`、`revoked_at`、`created_at`。令牌为 `xat_` + 32 字节随机 base64url。
校验：按哈希查行 → 未吊销、未过期 → 同查询 join `user` 实时判断 `isPlatformAdmin(role)` 且未封禁（与 `action.ts` 的 `isActiveAdmin` 同规则，抽成共用函数）。`last_used_at` 距上次超过 60 秒才更新，避免每次请求写库（Neon 成本基线）。
备选：Better Auth `apiKey`——绑定空间与 `features.publicApi` 开关、权限模型不同，且其 `verify` 不做平台角色实时校验，否决。

### 3. MCP 传输：无会话 Streamable HTTP，仅 POST + JSON 响应
用 `@modelcontextprotocol/server` 的 Web 标准传输，`sessionIdGenerator: undefined`、`enableJsonResponse: true`，每个请求新建 server 实例（无模块级状态，Worker isolate 复用安全）。GET / DELETE 返回 405。请求体上限 256 KB（读 `Content-Length` 并在读取时截断）。鉴权在进入 MCP 之前完成，失败返回 401 + `WWW-Authenticate: Bearer`。限流用运行时 `rateLimiter`，键为令牌 id，策略每分钟 120 次（新增策略名 `admin-mcp`）。响应统一加 `Cache-Control: no-store`、`X-Robots-Tag: noindex`。
任务 1.1 做 spike 验证该包在 workerd 与 Node 下可用、打包体积可接受；不可用时退回在插件内手写 JSON-RPC（只需 initialize / tools/list / tools/call / ping），接口不变。

### 4. 工具层：一个工具 = 一个 schema + 一个调用后台领域函数的 handler
插件内 `src/web/tools/*.ts` 用统一的 `defineAdminTool({ name, scope, input: zod, run })` 声明，`run` 收到 `{ db, admin, token, cache, dryRun? }`。读工具直接调用后台已有的领域函数（必要时先把 `*.functions.ts` 中的查询抽到同目录的非 functions 模块，后台改为调用抽出的函数——行为不变）；字段沿用后台页面返回的投影，不新开查询。分页参数为 `offset` / `limit`（limit ≤ 后台页大小 50）。
工具名使用点号命名空间（`settings.get`、`models.list` 等），与需求一致。

第一期工具：
| 工具 | scope | 复用 |
|---|---|---|
| `settings.list` / `settings.get` | read | 设置定义表 + `readRuntimeSettings`；功能模型项附解析来源 |
| `settings.set` | write | 定义表校验 + `writeRuntimeSettings` + `invalidateRuntimeSettings` |
| `models.list` | read | 后台模型列表查询（不含密钥字段） |
| `models.update` | write | 抽出的后台模型校验与保存（启停、参数、定价） |
| `features.models` | read | 功能模型解析 |
| `users.search` / `users.get` | read | `listAdminUsers` / `adminUserDetail` |
| `workspaces.list` | read | 后台空间列表 |
| `orders.list` | read | 后台计费订单列表 |
| `credits.ledger` | read | 后台积分流水 |
| `audit.list` | read | `listAuditLogs` |
| `metrics.summary` | read | `readAdminMetrics` |

### 5. 审计：每次调用一条，写工具与业务同事务
- 写工具：在 `runAdminAction(ctx, 'mcp.<tool>', ...)` 内执行，handler 用后台相同的 action 名与 `meta.changes` 新旧值格式写审计，并合并 `meta.via='mcp'`、`tokenId`、`tool`。`dryRun` 时不进 `runAdminAction` 写业务，只做实时角色校验与校验计算，另写一条 `admin.mcp.call` 审计（`dryRun: true`）。
- 读工具与被拒调用：调用结束后写一条 `action='admin.mcp.call'` 的审计，`meta` 含 `via`、`tokenId`、`tool`、参数摘要、`result: 'ok' | <错误码>`。参数摘要：对象只保留键与标量，字符串截断到 200 字符，密钥类设置值替换为 `[redacted]`。
- 读审计量：每次调用一行，管理员个人使用量级可接受；不做采样。

### 6. 运行时设置改为定义表，项目设置在 `settings.project.ts`
`packages/db/src/settings.ts` 新增 `defineSetting({ schema: zod, default, description, secret? })` 与 `templateSettings` 定义表；`SettingValues` 从定义推导；新增项目自有 `packages/db/src/settings.project.ts`（默认导出空表），合并为 `settingDefinitions` 并在模块加载时检查键名不重复。`resolve` 改为按定义 schema 校验（保留 `credits.daily*` 的边界规则，迁移进其 schema）。`getSetting` 的签名保持不变，现有调用点无需修改。后台保存路径改为同样调用定义校验。`packages/db` 已依赖 zod（如未依赖则加入，属 db 允许的外部依赖）。
template-sync 与生成器把 `settings.project.ts` 加入项目自有文件列表。

### 7. 功能模型：`packages/ai` 的登记与解析
- 项目自有 `packages/ai/src/feature-models.project.ts` 用 `defineFeatureModels({ '<feature>': { kind, inherit?: [...] } })` 登记；模板默认空表。
- 每个功能对应设置键 `ai.model.<feature>`（string，默认 `''`），由 `packages/ai` 在导入时生成定义，经 `packages/db` 的项目设置合并入口注入（db 不依赖 ai：由 ai 导出定义，`settings.project.ts` 中展开 `...featureModelSettings`，模板默认文件已包含这行）。
- `resolveFeatureModel(db, settingsCtx, feature)`：读显式设置 → 模型存在、启用且种类匹配则返回 `{ modelKey, source: 'explicit' }`；否则按 `inherit` 顺序读各功能的显式设置，取第一个可用的，返回 `{ modelKey, source: 'inherited', from }`；否则 `{ modelKey: null, source: 'unset' }`。不递归。套餐权限仍由调用方原有检查负责。
- 登记校验（单元测试 + 启动检查）：`inherit` 只引用已登记、同种类的功能，无自引用。
- 后台设置页新增「功能模型」分组：每个功能一个模型下拉（只列同种类已启用模型，含「未选择」），旁边显示解析结果与来源；保存走现有运行时设置保存与审计。登记表为空时不显示分组。
- xuanxue 采纳时把 `READING_MODEL_INHERIT` 改为登记表，`readings/config.ts` 调用 `resolveFeatureModel`。

### 8. 界面设计（已确认）
令牌管理页与设置页功能模型分组的设计稿已于 2026-11-25 取得使用者确认，见 `docs/design-system/prototypes/README.md` 中「后台 API 令牌」「后台运行时设置·功能模型分组」两行，副本在 `docs/design-system/prototypes/admin-mcp/`。随画布确认的细节：已吊销与已过期令牌在列表中置灰保留 30 天后不再显示（数据行保留，供审计关联）；设置页提示也可经 MCP `settings.set` 修改。

## Risks / Trade-offs

- [令牌泄露即获得后台写权限] → 必填过期（≤365 天）、scope 最小化、每次实时校验角色、审计每次调用、可随时吊销；文档要求令牌只存钥匙串。
- [MCP SDK v2 较新，Worker 兼容性未知] → 任务 1.1 spike；不可用时手写最小 JSON-RPC，接口不变。
- [设置定义化改动面大，可能影响现有读取] → `getSetting` 签名不变，现有 `credits.daily*` 校验迁入 schema 并保留测试；数据库中现有值全部按 schema 回归。
- [读审计行数增长] → 管理员个人调用量小；后台审计页已分页；不采样以保证可追溯。
- [`settings.set` 能写任意设置，如运营通知令牌] → 走同一 schema 校验；密钥类设置可写不可读，审计中脱敏。

## Migration Plan

1. 迁移 `0026_admin_api_token`（新表，无数据迁移）。
2. 设置定义化对数据库无结构改动；部署后后台与读取行为不变。
3. 插件默认启用；已有衍生项目经 template-sync 采纳后，在 `template.config.ts` 保留或删除 `plugins['admin-mcp']`。
4. 回滚：停用插件即移除端点；令牌表保留无害。

## Open Questions

- 无阻塞问题。限流额度（120 次/分钟）与令牌最长有效期（365 天）为默认取值，可在 review 时调整。
