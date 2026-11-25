# Tasks: add-ops-safeguards

分组即 worker 划分。第 1–5 组彼此独立，可同时开始；1.2 之后的子任务依赖 1.1 合并。共享文件：`AGENTS.md` 每组只在「编码与配置」末尾追加自己的一条规则（冲突时按行合并）；`docs/plugins.md` 只由第 2 组与第 5 组修改不同小节。验收方式标注：〔本地〕〔staging〕〔外部凭据〕。拍板结果见 design.md「拍板结果（使用者 2026-11-25 确认）」，实施以其为准。

## 1. 定时删除与群发防护（worker A，Claude：跨包且涉及删除语义）

- [ ] 1.1 框架：`packages/shared` 新增时间防护纯函数（下限 `2024-01-01T00:00:00Z`、未来、最小保留期、应用与 DB 时钟偏差 5 分钟）与 `defineBulkJob` 声明类型；`apps/jobs` 新增 `ops.bulk_job.guard_tripped` 运维事件（按任务 + UTC 日去重）与 `job.cap_reached` 日志；插件 `PluginCronTask` 增加必填 `safety` 字段；`runBillingSchedule` 改为遍历定义数组。单元测试覆盖 0、负数、1970、未来、时钟偏差五种截止时间。〔本地〕`pnpm typecheck`、`pnpm test --filter @saas/shared --filter @saas/jobs` 通过
- [ ] 1.2 存储与账号清理：文件清理（#2，空间与对象双上限、按到期时间排序、行时间区间过滤）、删号凭据（#1）、分享卡（#3a）、过期空间（#3b，含通知与邀请删除的空间上限）、已删用户 AI 内容（#3c 维持现有批量上限，补时间防护）。集成测试：超过上限时分轮处理且最早到期先处理；单行删除时间为 1970 时不删除并告警一次；保留期常量被测试替换为 0 时整轮不执行。〔本地〕相关包集成测试通过（需隔离测试库）
- [ ] 1.3 计费任务：积分过期（#4）、预扣结算（#5）、订阅对账取消（#8）、退款联系邮箱清理（#10）加上限与时间防护；退款邮件（#6）与补偿（#7）补时间防护并登记现有上限；对账告警（#9）每轮最多 10 条明细 + 1 条汇总，`sourceId` 改为任务 + UTC 日期。`packages/billing` postgres 测试覆盖上限、排序与告警去重。〔本地〕
- [ ] 1.4 agents 保留期（#11）用同一时间防护（`retentionDays` 最小 1 天、`updatedAt` 区间）；Node 队列清理（#12）声明上限并登记为「未调度」。`apps/web/test/agents-lifecycle.test.ts` 增加异常时间用例。〔本地〕
- [ ] 1.5 `docs/bulk-jobs.md` 登记表（任务、触发、动作、每轮上限、时间防护、代码位置；备份保留列现状）；查 Workers 子请求上限并写明出处与日期；守卫测试 `apps/jobs/test/bulk-jobs.guard.test.ts`：枚举核心任务组、计费子任务、生成的插件 cron 与已知非 cron 入口，与登记表双向一致；各环境 wrangler `crons` 与 `CRON_TASK_GROUPS` 一致。AGENTS.md 加规则：新增删除或群发任务必须声明上限与时间防护并登记。升级说明草稿记录插件 cron 的 `safety` 字段。〔本地〕`pnpm check`、`pnpm test` 通过

## 2. MCP 工具说明守卫（worker B，Codex：改动集中、模式明确）

- [x] 2.1 `defineAdminTool` 增加按输入 schema 键类型强制的必填 `params` 说明映射，生成 inputSchema 时写入属性 `description`；为现有 14 个工具补全参数说明并检查工具描述完整；`mcp.ts` 导出 `adminTools` 供运行时与测试共用。〔本地〕`pnpm typecheck` 通过；删去任一参数说明时 typecheck 失败（在 PR 中说明已手动验证）
- [x] 2.2 守卫测试：工具描述 ≥20 字符、每个参数说明非空、`readOnlyHint` 与 scope 一致；解析 `docs/admin-mcp.md` 工具表核对名称、scope、参数名与可选性；`apps/web/test/admin-mcp.test.ts` 增加 `tools/list` 返回参数说明的断言。〔本地〕
- [x] 2.3 文档：`docs/admin-mcp.md` 校正工具表（如有差异）；`docs/plugins.md` 与 AGENTS.md 加规则：新增或改动 MCP 工具能力，同一 PR 更新工具与参数说明及文档。〔本地〕`pnpm check` 通过

## 3. 第三方登记表（worker C，Claude：需逐项查官方文档与判断证据）

- [ ] 3.1 新建 `docs/third-party.md`：按 design D5 的覆盖行回填，每行的出处链接当场打开核对并写日期；证据只来自仓库文档、runbook 与已归档 change，不确定的标「未核对」；表下列「可改为自动查询」清单。〔本地〕人工审阅
- [ ] 3.2 按 Q4 结论把现有文档中的真账号数据替换为占位符（原值写入私有证据库，不改写 git 历史）；`docs/README.md` 加入口。〔本地〕
- [ ] 3.3 守卫测试：表格列完整、验证方式取值、日期格式、出处为 https 或「待核实」；「SDK 依赖 → 登记行」映射与受监视模式，新增未映射依赖时失败。接入 `pnpm test` 或 `pnpm check`。〔本地〕
- [ ] 3.4 AGENTS.md 三条规则：能查询状态就不教步骤；写第三方操作前查官方文档并注明出处与日期；真账号数据不进仓库（衔接私有证据库）。〔本地〕`pnpm check` 通过

## 4. 存储临时错误重试（worker D，Claude：错误分类需要谨慎）

- [x] 4.1 `packages/shared` 新增 `retryTransient`：分类器返回「临时」「同键限流」「不可重试」，两类分别计数（临时最多 3 次重试，100/300/900 ms ±50% 抖动；同键限流最多 2 次，1000/2000 ms + 0–250 ms 抖动），延时可注入用于测试；单元测试覆盖成功、各类重试后成功、不可重试立即失败、两类各自耗尽、两类交替出现时互不消耗次数。〔本地〕
- [x] 4.2 R2 分类器与接入：`packages/storage/src/cloudflare/{index,media,share-cards}.ts` 的 put/delete 经重试，按 design D6 的错误码表分类（10058 归同键限流类；同时识别数字码与名称，未识别不重试）；流式请求体不重试；耗尽返回 `STORAGE_UNAVAILABLE`（503）。先在本地 `wrangler dev` 或文档中确认绑定错误消息格式并记录到 design。单元测试用构造错误覆盖每个码。〔本地〕
- [x] 4.3 KV 接入：`packages/platform/src/cloudflare/index.ts` 的 put/delete 对网络中断与内部错误按临时类重试，`KV PUT failed: 429 Too Many Requests` 按同键限流类重试，耗尽返回 `CACHE_UNAVAILABLE`。单元测试覆盖两类。〔本地〕
- [x] 4.4 Node：`packages/storage/src/node/client.ts` 显式设置 `maxAttempts: 3`、`retryMode: 'standard'`，查 AWS SDK 官方重试文档写出处与日期；Redis 缓存保持现状并在 `docs/platform-capabilities.md` 写明两目标的重试语义与出处。〔本地〕`pnpm test` 通过

## 5. 公开页面优先（worker E，Claude：涉及请求入口与界面）

- [x] 5.1 `apps/web/src/server.ts`：环境校验失败时仍先返回命中的预渲染静态资源；`env.test.ts` 增加「认证密钥缺失时预渲染首页 200、动态请求 500」。〔本地〕
- [x] 5.2 插件绑定缺失只让该插件路由返回 503（admin-mcp、agents、media 的入口各自检查），健康检查体现插件状态；`scripts/production/check-wrangler-envs.mjs` 校验启用插件声明的绑定在各环境都已声明。测试：缺 `RL_ADMIN_MCP` 时公开页正常、`/api/admin/mcp` 503；检查脚本对缺失绑定报错。`docs/plugins.md` 更新绑定语义。〔本地〕
- [x] 5.3 `features/i18n/request.server.ts`：`/_serverFn/` 请求读会话的非 401/403 错误降级为无账号语言并记警告；`request.test.ts` 增加数据库抛错用例；更正 `docs/platform-capabilities.md` 中语言处理的描述。〔本地〕
- [x] 5.4 根路由兜底 errorComponent（复用 404 页导航布局与 `@saas/ui`，文案进 messages），分享页使用同一界面；组件测试与 `pnpm check`（含 UI 规范检查）通过。〔本地〕
- [x] 5.5 补测试：根 loader 在 runtime 的 db/auth 抛错时 resolve；`getAnnouncement`（无效值、KV 非 JSON、KV put 失败、无 runtime）与 `getSafeImpersonation` 异常分支；admin 门禁 `/administrator`、`/admin-x`、`/zh/admin` 负例。AGENTS.md 加规则：访客不会因后台问题看不到公开页面。〔本地〕`pnpm test` 通过
- [x] 5.6 本地端到端：停掉本 worktree 的数据库后，已登录访客从首页导航到博客、文档、法律页正常，分享页显示错误界面；证据写入 `EVIDENCE_DIR`。〔本地〕

## 6. 部署与外部验收（协调者，全部合并后）

- [ ] 6.1 staging 部署后观察一周：jobs 日志中各任务的处理数、`job.cap_reached`、`ops.bulk_job.guard_tripped` 无异常，运维通知渠道未被刷屏；证据写入私有证据库。〔staging〕
- [ ] 6.2 staging 用 Claude Code 连接 admin MCP，`tools/list` 显示每个参数的说明。需要 staging 管理员令牌。〔staging〕〔外部凭据〕
- [ ] 6.3 staging 公开页冒烟：首页、博客、定价、文档 200；admin MCP 端点在绑定齐全时正常。〔staging〕
- [ ] 6.4 第三方登记表中标「真账号」的行，若本次回填改变了结论，由使用者用对应账号复核。〔外部凭据〕
