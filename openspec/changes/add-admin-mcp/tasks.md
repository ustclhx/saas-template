## 1. 技术验证

- [x] 1.1 spike：在 `plugins/admin-mcp` 中用精确锁定的 `@modelcontextprotocol/server`（与锁文件中 client/core 同版本）实现无会话、仅 POST、JSON 响应的最小端点（一个 `ping` 类只读工具），经插件路由挂到 `/api/admin/mcp`；验证 Cloudflare（`wrangler dev` 与 `pnpm build`）与 Node（`pnpm build:node` 后运行）均可用，记录 web 产物体积增量；用 `@modelcontextprotocol/client` 完成 initialize → tools/list → tools/call。不可用时改为手写最小 JSON-RPC。结论写进 design.md「验证结果」

## 2. 设置定义化与功能模型（R9）

- [x] 2.1 `packages/db/src/settings.ts` 改为定义表：`defineSetting`（zod schema、默认值、说明、`secret`）、模板设置项定义、从定义推导 `SettingValues`；`credits.daily*` 边界迁入 schema；新增项目自有 `settings.project.ts`（默认空表）并合并、启动时检查键名重复；读取按 schema 校验。`getSetting` 签名不变。后台 `writeRuntimeSettings` 改为按定义校验。现有设置与后台设置测试全部通过，新增定义校验、项目设置项与重复键单元测试
- [x] 2.2 `packages/ai` 功能模型：项目自有 `feature-models.project.ts`（默认空表）、`defineFeatureModels`、按功能生成 `ai.model.<feature>` 设置定义并经 `settings.project.ts` 展开注入、登记校验（未登记、跨种类、自引用）、`resolveFeatureModel`（显式 → 按沿用顺序 → 未配置，不递归，模型须存在、启用、同种类）。单元与集成测试覆盖显式、沿用、显式模型被停用后沿用、未配置
- [x] 2.3 生成器与 template-sync：`settings.project.ts`、`feature-models.project.ts` 加入项目自有文件列表；`pnpm test:create-project` 通过

## 3. 令牌与端点（R8）

- [x] 3.1 迁移 `0026_admin_api_token`：表、`token_hash` 唯一索引、`user_id` 索引、删号级联；`docs/03-data-model.md` 更新。本地 PG 应用通过
- [x] 3.2 `plugins/admin-mcp` 清单（targets cloudflare + node，配置段可选 `rateLimitPerMinute` 默认 120、`maxTokenDays` 默认 365）；模板 `template.config.ts` 启用；限流策略 `admin-mcp` 接入两目标的 rateLimiter（Cloudflare 绑定按插件清单声明，各环境 wrangler 补齐）；`pnpm check` 通过
- [x] 3.3 令牌服务：创建（随机值、前缀、哈希、scope、过期时间上限）、按用户列出、吊销、校验（哈希 → 未吊销未过期 → 实时管理员且未封禁，与 `action.ts` 共用判定函数）、`last_used_at` 节流更新。单元与集成测试覆盖过期、吊销、降级、封禁、错误令牌均为 401
- [x] 3.4 端点：鉴权、限流（429）、请求体上限（413）、GET/DELETE 405、`no-store` 与 `noindex` 头、错误映射（不含堆栈与密钥）、每请求新建 MCP server。集成测试用 `@modelcontextprotocol/client` 走完整协议

## 4. 工具（R8）

- [x] 4.1 工具框架：`defineAdminTool`（name、scope、zod 输入、run）、scope 检查、参数摘要脱敏、读工具与被拒调用写 `admin.mcp.call` 审计、写工具经 `runAdminAction` 并合并 `meta.via/tokenId/tool`、`dryRun` 不落库。单元测试覆盖只读令牌调写工具被拒且有审计、脱敏
- [x] 4.2 设置与模型工具：`settings.list` / `settings.get`（密钥项只返回是否已设置；功能模型项附解析来源）、`settings.set`（定义校验、清缓存、返回新旧值、dryRun）、`models.list`（无密钥字段）、`models.update`（把后台模型校验与保存从 `admin-models.functions.ts` 抽到可复用模块，后台改为调用它）、`features.models`。集成测试：`settings.set` 写功能模型后 `resolveFeatureModel` 立即变化（清缓存）、审计含 via=mcp 与新旧值；`models.update` 停用模型后依赖它的功能解析回退
- [x] 4.3 只读业务工具：`users.search` / `users.get`、`workspaces.list`、`orders.list`、`credits.ledger`、`audit.list`、`metrics.summary`，复用后台查询与字段投影（必要时把查询从 `*.functions.ts` 抽出，后台改为调用抽出的函数），分页 offset/limit ≤ 50。集成测试确认字段与后台一致、跨空间数据按后台规则展示

## 5. 界面（先设计确认）

- [x] 5.1 经 `ui-design` 产出令牌管理页（列表、创建弹窗含 scope 与有效期、一次性显示完整令牌与复制、吊销确认、空状态、移动端）与设置页「功能模型」分组的设计稿，取得使用者确认并登记原型索引
- [x] 5.2 实现令牌管理页（插件路由 `admin/api-tokens`、`adminNav` 条目、Server Functions 经 `adminAction` 写审计、文案进插件 `messages/`）与设置页功能模型分组（同种类模型下拉、解析结果与来源、登记表为空时隐藏）。组件测试与 `pnpm check`（含 UI 规范检查）通过

## 6. 文档、技能与验收

- [x] 6.1 文档：`docs/` 新增 admin MCP 一节（创建令牌、`claude mcp add --transport http <url>/api/admin/mcp --header "Authorization: Bearer …"`、工具清单与 scope、dryRun、审计查看、令牌保管）；`docs/plugins.md` 登记插件；运行时设置文档说明定义表与项目设置项；功能模型用法；新增技能「新功能上线时由 agent 配置模型并验证」（`.agents/skills` 与 `.claude/skills` 字节一致）；`security-scan` 清单加入管理员令牌与 MCP 端点
- [x] 6.2 本地验收：用 Claude Code（或 `@modelcontextprotocol/client` 脚本）连本地 dev 完成 tools/list → `settings.get` → `settings.set` dryRun → 写入 → 读回，并在后台审计页看到记录；生成器 `--plugins` 去掉 admin-mcp 的副本不含端点与依赖。证据写入 `EVIDENCE_DIR`
- [ ] 6.3 staging 验收：管理员在 staging 创建令牌，经 MCP 读设置与模型、对一个无害设置项 dryRun 与写入并还原，确认审计；吊销后调用返回 401。证据写入私有证据库。需要 staging 管理员登录，未执行时在 PR 中标为未完成验收
