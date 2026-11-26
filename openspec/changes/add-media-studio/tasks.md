# Tasks

## 1. 数据、插件骨架与契约（P0）

- [x] 1.1 迁移：`studio_work`、`studio_report` 表与索引（design 决策 2，含 `moderation_before_hide`），`ai_model.display_name`；Drizzle schema 与 `docs/03-data-model.md` 更新。验收：本地 PG 应用迁移，`pnpm --filter @saas/db test` 与 `pnpm typecheck` 通过
- [x] 1.2 `plugins/studio` 骨架：清单（requires media + billing/credits，targets cloudflare/node，配置段 schema 与默认值）、web / worker / webNode 入口、messages 目录、vitest 配置；启用模式解析函数（`kinds` ∩ 模板 AI 开关）；模板 `template.config.ts` 启用 studio；`docs/plugins.md` 内置插件表登记。验收：插件单元测试覆盖配置解析与模式求交，`pnpm check`、`pnpm typecheck`、`pnpm build` 通过
- [x] 1.3 模型显示名：后台模型编辑器字段与校验（≤60 字符，可空）、`models.list` 返回与 `models.update` 可写、`docs/admin-mcp.md` 工具表与 `docs/06-ai.md` 更新；面向用户的模型列表查询返回 `displayName ?? key`。验收：后台组件测试、MCP 工具单测
- [x] 1.4 插件 web 契约增加 `sitemaps`，`robots()` 输出已启用插件的附加站点地图；生成器测试确认未启用插件时不出现。验收：`crawlers` 单测与 `pnpm test:create-project`
- [x] 1.5 启用 studio 时隐藏 media 的「生成」导航项（任务列表保留）。验收：导航单测覆盖启用 / 未启用

## 2. 创作提交（P0，依赖 1）

- [x] 2.1 media 插件显式导出 `submitWorkspaceMedia`、可用模型查询与参数表单组件（`@saas/plugin-media` 导出入口），media 不依赖 studio。验收：`pnpm check:deps`、media 现有测试通过
- [x] 2.2 `submitStudio` Server Function：模式启用校验、只接受 schema 含 `prompt` 字段的模型、预设组合（作品快照只记用户提示词）、参考图字段校验，调用 `submitWorkspaceMedia`。集成测试覆盖：正常提交与预扣、模式未启用 404、无 prompt 字段的模型被拒、缺参考图、余额不足、只读成员被拒
- [x] 2.3 `studio.project.ts` 提示词预设（默认空）与 `moderation.project.ts` 发布前检查（默认 allow），登记为 template-sync 项目自有文件（merge.mjs、template-release.mjs、create-project 测试清单）与 `docs/02-project-structure.md`。验收：template-sync 与 create-project 相关测试通过

## 3. 作品生命周期服务（P0，依赖 1）

- [x] 3.1 「我的作品」查询（输出文件视图左连接作品，类型 / 公开状态筛选、游标分页、`scoped` 租户隔离）。集成测试覆盖跨空间不可见与筛选
- [x] 3.2 发布 / 取消发布 / 重新发布：状态机（design 决策 7）、slug 生成、提示词快照、站点键、每日上限（UTC，事务内）、发布前检查三种结果与异常转人工、已下架不可再发布、版本递增。集成测试逐条覆盖状态迁移
- [x] 3.3 删除作品：删作品行（举报级联）、软删文件与 R2 删除、版本失效；删号 / 删空间经 `registerDeletionStep` 在文件与任务清理前删除作品，幂等可重试。集成测试覆盖部分失败重试
- [x] 3.4 公开谓词与查询（画廊分页、精选、作品详情按 slug + 站点、相关作品、站点地图列表、封禁作者过滤），供公开页与媒体路由共用。集成测试覆盖封禁 / 解封、他站 404、hidden / removed 不可见

## 4. 设计稿（P0，阻塞第 6–8 组界面）

- [ ] 4.1 协调者经 `ui-design` 产出 Design 画布（design 决策 12 的全部页面与状态，桌面 / 手机 × 浅 / 深），取得使用者本人确认，保存副本并登记原型索引；本 change 的 design.md 引用索引行

## 5. 公开媒体路由（P0，依赖 3）

- [x] 5.1 `/media/w/<workId>/<version>` 处理器（worker fetch 前置处理与 Node 等价实现）：公开谓词与版本校验、R2 流式返回、Range 206、ETag、Cache-Control、Cache API 回填；非公开 / 版本不符 404。单元测试覆盖命中、未命中、Range、旧版本
- [x] 5.2 失效：状态变化时本机房 `cache.delete`；可选 `CF_PURGE_TOKEN` / `CF_ZONE_ID` 按 URL 清除（第三方登记表与 `scripts/third-party-deps.json` 无新 SDK，仅登记 API 用法与官方文档链接）。单元测试用替身确认调用；`docs/06-ai.md` studio 章节写明缓存窗口与清除凭据

## 6. 公开画廊与作品页（P0，依赖 3、4、5）

- [ ] 6.1 `/gallery`：类型筛选、最新 / 精选、`?page=n` 可抓取分页、空态；多站点过滤；`pageHead` 与 canonical 规则。组件测试与路由集成测试
- [ ] 6.2 `/gallery/$slug`：媒体（图片 / 视频）、标题、显示名、尺寸或时长、可选提示词、相关作品、做同款（登录回跳并预填）、举报入口；`noindex` 仅在未通过时；OG 与 JSON-LD（Image / VideoObject）。组件测试与 SEO 头单测
- [ ] 6.3 匿名请求边缘缓存（地址 + 站点 + 部署版本，`s-maxage=300`）、作品状态变化时本机房失效；数据库不可达的友好错误页（503、不缓存）；插件不可用时 503。集成测试覆盖降级与缓存键
- [ ] 6.4 `/sitemap-gallery.xml`（仅 approved、分片上限、lastmod、缓存 1 小时）与 `/gallery` 列表页进入站点地图；与主站点地图不重叠。单测确认待审核作品不出现
- [ ] 6.5 e2e（本地，测试替身媒体模型）：发布 → 画廊可见且作品页 noindex → 后台通过 → noindex 消失并进入画廊站点地图 → 取消发布后作品页与媒体地址 404；390px 无横向滚动。截图与副本对照，证据写入 `EVIDENCE_DIR`

## 7. 举报与后台审核（P0，依赖 3、4）

- [ ] 7.1 举报接口：Turnstile（未配置时仅登录可举报）、网络标识 HMAC、去重、原生限流 + 每作品每小时匿名上限、阈值自动隐藏与版本递增。集成测试覆盖重复举报、验证失败、达到阈值
- [ ] 7.2 后台 `/admin/studio`：四个分栏 DataTable、预览、举报原因汇总、通过 / 下架（必填原因）/ 恢复 / 精选，`adminAction` 与审计，`defineAdminActions('studio')` 登记 step-up 级别，`adminNav` 计数按需加载（不进后台入口包水合闭包，`check-home-bundle` 通过）。组件测试与集成测试
- [ ] 7.3 批量通过 / 下架（每次 ≤ 50，逐条审计）（P1）。集成测试
- [ ] 7.4 e2e：举报达阈值自动隐藏 → 后台被举报栏恢复；下架后作者在我的作品看到原因。证据写入 `EVIDENCE_DIR`

## 8. 创作页与我的作品界面（P0，依赖 2、3、4）

- [ ] 8.1 `/app/$slug/studio`：图片 / 视频模式切换（只显示启用的模式）、提示词、模型显示名、参考图、预设、更多设置折叠表单、预估积分、提交、进行中与结果、余额不足充值入口、空态；做同款预填参数。组件测试与 `pnpm check`（含 UI 规范检查）
- [ ] 8.2 `/app/$slug/studio/works`：网格、类型 / 公开状态筛选、审核状态与下架原因徽标、发布对话框（标题、公开提示词开关、每日上限提示）、取消发布、删除确认（`AlertDialog`，不用 `confirm()`）、只读成员只读。组件测试
- [ ] 8.3 视频模式：时长 / 分辨率等参数经表单展示、视频结果播放器、视频卡片首帧预览与悬停播放（桌面）。组件测试；e2e：以图生视频提交（测试替身）→ 结果 → 发布 → 作品页播放器带 Range 请求
- [ ] 8.4 导航入口（appNav：创作、我的作品）与文案（插件 `messages/` 中英）。验收：`pnpm typecheck`、文案完整性检查

## 9. 管理员 MCP 插件工具（P2，依赖 7）

- [ ] 9.1 admin-mcp 插件工具注册：已启用插件 web 入口导出 `adminMcpTools` 汇总进工具表，前缀与重名生成时校验，scope / 审计 / dryRun 与内置一致。单测覆盖未启用不出现、重名失败
- [ ] 9.2 studio 工具 `studio.works.list` 与 `studio.works.moderate`（dryRun），同 PR 更新 `docs/admin-mcp.md` 工具表。集成测试覆盖只读令牌被拒与审计 `via=mcp`

## 10. 集成与验收

- [ ] 10.1 生成器验证：`--plugins studio`（含 media）的 CF 副本与 `--target selfhost` 副本通过 check、typecheck、test、build；未启用 studio 的副本产物不含 studio 代码；`kinds: ['image']` 的副本无视频入口
- [ ] 10.2 文档收尾：`docs/06-ai.md` studio 章节（启用、模式、发布与审核流程、缓存与失效、项目自有钩子）、`docs/08-roadmap.md` 生图站 / 视频站状态、`docs/bulk-jobs.md` 确认无新增批量任务、升级说明 `docs/upgrades/<版本>.md`
- [ ] 10.3 staging 验收（需 `FAL_KEY`，与 add-plugin-system 7.1 一同执行）：真实图片与视频生成 → 发布 → 画廊与作品页 → 媒体 Range 与边缘缓存命中（`cf-cache-status`）→ 取消发布失效 → 举报与后台审核；证据写入私有证据库。未执行时在 PR 中标为未完成验收
