# Proposal: add-ops-safeguards

## Why

模板已经有十余个会删除数据、销毁积分或批量对外发送的后台任务，但大多数没有每轮上限，也不检查截止时间是否合理：`files-cleanup` 一轮处理全部符合条件的空间并逐个删除 R2 对象，对账告警按空间逐条发送且跨轮不去重。同时，几类运维风险只靠作者记忆：admin MCP 的参数没有说明、工具清单与文档靠人工同步；第三方的操作步骤散落在各 runbook，没有出处与核对日期；R2 / KV 写入遇到平台临时错误直接失败；还发现两条后台/配置故障会让公开页面不可用的路径（插件的后台专用绑定缺失时整站 500；数据库故障时已登录访客在公开页之间导航报错）。这些问题都要在衍生项目上线真实用户前收口，并用守卫测试防止回退。

## What Changes

- **定时删除与群发防护**：为每个会删除数据、销毁积分、调用外部取消或批量发送的后台任务设每轮上限常量（超出留到下一轮，最早到期的先处理）；截止时间或行时间异常（无效、早于下限、秒误作毫秒、在未来、保留期低于下限）时不执行并发出去重的运维告警；新增 `docs/bulk-jobs.md` 登记表；守卫测试按实际注册的任务核对登记，新增任务必须登记才能通过。插件 cron 类型要求声明防护信息。对账告警改为每轮有上限并汇总。
- **MCP 工具说明守卫**：admin MCP 的每个工具和每个输入参数都有说明（定义工具时由类型强制）；测试按实际注册结果核对说明非空、`docs/admin-mcp.md` 工具表的名称、scope 与参数一致。AGENTS.md 与 `docs/plugins.md` 写入「改 MCP 工具能力的 PR 同时更新说明与文档」。
- **第三方流程登记表**：新增 `docs/third-party.md`，每个第三方一行（自动查询、教使用者做什么、代码/文档位置、官方出处、上次核对日期、验证方式），按现有 runbook 回填，不确定的标「未核对」；格式守卫测试与「新增第三方 SDK 依赖必须有对应行」的检查。AGENTS.md 加入三条规则：能查询状态就不教步骤；写第三方操作前查官方文档并注明出处与日期；真账号里看到的数据不进仓库。
- **存储临时错误重试**：Cloudflare 适配层的 R2 写入/删除与 KV 写入/删除按官方错误码区分可重试与不可重试，有限次指数退避（带抖动），耗尽后返回统一的 503 业务错误；流式请求体不在适配层重试。Node 适配：S3 客户端显式配置 SDK 重试、不叠加第二层；Redis 缓存保持快速失败。
- **公开页面优先**：「访客不会因后台问题看不到公开页面」写成规则；修复已发现的两条路径（预渲染页在环境校验失败时仍可返回；后台专用的插件绑定缺失只让该插件不可用；语言中间件读会话失败时降级）；根路由加兜底错误界面；补针对性测试。

## Capabilities

### New Capabilities
- `bulk-job-safety`: 会删除数据、销毁积分或批量对外发送的后台任务的每轮上限、处理顺序、时间合理性防护、告警与登记。
- `third-party-registry`: 第三方集成登记表的内容、格式、核对与仓库数据边界。
- `public-site-availability`: 后台、插件与配置故障时公开页面仍可访问的行为约束。

### Modified Capabilities
- `admin-mcp`: 新增「工具与参数说明完整且与文档一致」要求。
- `file-storage`: 新增对象存储写入/删除的临时错误重试要求。
- `cache-rate-limit`: 新增 KV 写入/删除的临时错误重试要求（Cloudflare），以及 Node 缓存保持快速失败的说明。

## Impact

- 代码：`apps/jobs/src/{handlers,billing}.ts`、`apps/jobs/src/cron/*`、`apps/jobs/src/plugins/module.ts`；`packages/storage/src/{cleanup,share-cards}.ts` 与 `cloudflare/*`、`node/client.ts`；`packages/auth/src/{deletion,workspace-lifecycle,ai-content-cleanup}.ts`；`packages/billing/src/{cron,notifications}.ts`；`packages/platform/src/cloudflare/index.ts`；`packages/shared`（时间防护与重试的纯函数）；`plugins/admin-mcp/src/web/{mcp.ts,tools/*}`；`plugins/agents`（保留期防护）；`apps/web/src/server.ts`、`server/cloudflare/env.ts`、`features/i18n/request.server.ts`、`routes/__root.tsx`；`scripts/production/check-wrangler-envs.mjs`。
- 文档：新增 `docs/bulk-jobs.md`、`docs/third-party.md`；更新 `AGENTS.md`、`docs/plugins.md`、`docs/admin-mcp.md`、`docs/platform-capabilities.md`（语言处理描述更正）。
- 数据库：无 schema 变更。防护在已有查询中完成，不新增轮询，满足 Neon 缩容到零的成本基线。
- 衍生项目：插件 cron 类型新增必填防护字段（模板内置插件目前没有 cron，项目自有插件需补字段）；在升级说明中提示。
- 无新外部依赖。
