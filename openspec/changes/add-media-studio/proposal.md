# Proposal

## Why

路线图中的「生图站」「视频站」（`docs/08-roadmap.md`）一直待提案。现有 media 插件只提供通用的「提交任务 / 任务列表」页面：
模型下拉显示原始 key、输出只在私有空间内可见，没有作品库、公开画廊和可被搜索引擎收录的作品页，
衍生项目无法直接拿来做面向普通用户的图片 / 视频生成站，也缺少「生成 → 分享 → 新访客 → 注册」的增长回路。
插件机制与 agents 已完成（使用者 2026-11-23 定的顺序：插件机制 → agents → 图片 / 视频站），现在补上这一块。

## What Changes

- 新增可选插件 `plugins/studio`（依赖 media 插件；配置 `kinds: ['image','video']` 选择启用的模式，例如只开图片）。
  使用者 2026-11-26 确认：一个插件含图片与视频两种模式，画廊、作品页、审核共用。
- **创作页** `/app/$slug/studio`：图片 / 视频两种模式，提示词为主输入，模型选择显示后台配置的显示名，
  其余参数复用现有按 schema 生成的参数表单（折叠在「更多设置」中）；参考图上传（以图生图 / 以图生视频）；
  结果在本页轮询显示，可直接发布；项目自有的提示词预设（`studio.project.ts`）。
- **我的作品** `/app/$slug/studio/works`：本空间生成的图片 / 视频网格，筛选类型与公开状态，发布、取消发布、删除。
- **发布与公开**：作品发布到公开画廊，采用「先发后审」（使用者 2026-11-26 确认）——发布后立即在画廊与作品页可见，
  但未审核通过前作品页 `noindex`、不进站点地图；管理员通过后才允许收录。取消发布、删除、被下架后公开地址立即失效。
- **公开画廊** `/gallery`（按类型筛选、最新 / 精选、可抓取的分页）与**作品页** `/gallery/$slug`
  （媒体、标题、可选提示词、模型、相关作品内链、「做同款」入口、举报、OG / JSON-LD）。公开页面遵循
  public-site-availability：数据库不可用时降级，不依赖后台配置；HTML 走短时边缘缓存以守住 Neon 成本基线。
- **公开媒体文件**：沿用现有私有 R2 桶，由 Worker 路由按「作品 + 版本号」输出文件并设置边缘缓存，
  支持视频 Range 请求；取消发布 / 下架时递增版本号使旧地址失效（使用者 2026-11-26 确认，不新建公开桶与自定义域名）。
- **审核与举报**：后台 `/admin/studio` 审核队列（待审、被举报、已下架），通过、下架（附原因）、设为精选；
  访客与用户可举报（未登录需 Turnstile，按 IP 与作品去重）；不同举报人达到阈值时自动隐藏待复核；
  项目自有发布前检查钩子（默认放行，可接关键词或分类模型）。
- **站点地图**：插件提供 `/sitemap-gallery.xml`（只含审核通过的作品），`robots.txt` 列出插件站点地图。
- **模型显示名**：`ai_model` 增加可选显示名，后台模型编辑器可填写；创作页与作品页显示它，未填写时回退到 key。
- 删号 / 删空间清理作品与举报行；新增表的迁移与数据模型文档。
- 管理员 MCP：admin-mcp 增加插件工具注册扩展点，studio 提供作品查询与审核工具（P2）。
- 模板 `template.config.ts` 启用 studio，供 staging 演示与验收。

## Capabilities

### New Capabilities

- `media-studio`: 面向终端用户的图片 / 视频创作页、我的作品、发布与取消发布、作品生命周期（删除、删号 / 删空间）。
- `public-gallery`: 公开画廊、作品页、公开媒体文件输出与缓存失效、收录规则（noindex 与站点地图）、公开页降级。
- `content-moderation`: 作品审核队列、举报、自动隐藏阈值、发布前检查钩子、下架与审计。

### Modified Capabilities

- `ai-model-registry`: 模型增加可选显示名，后台可编辑，面向用户的页面优先显示它。
- `seo`: `robots.txt` 列出已启用插件声明的附加站点地图。
- `admin-mcp`: 插件可注册管理员 MCP 工具（沿用现有权限、审计与确认执行规则）。

## Impact

- 新插件 `plugins/studio`（web / worker 入口、路由、文案、测试）；`template.config.ts`、生成器插件清单、`docs/plugins.md`。
- `packages/db`：新表 `studio_work`、`studio_report` 与迁移，`ai_model.display_name`；删号 / 删空间清理步骤。
- `plugins/media`：导出创作页复用的提交函数与参数表单，不改变现有任务语义；`plugins/admin-mcp`：插件工具注册。
- `apps/web`：robots 插件站点地图列表、后台模型编辑器显示名字段、插件 web 契约增加 `sitemaps`。
- 新页面需 `ui-design` 设计稿经使用者确认后实现：创作页、我的作品、发布对话框、画廊、作品页、后台审核页。
- 文档：`docs/06-ai.md`（studio 章节）、`docs/03-data-model.md`、`docs/admin-mcp.md`、`docs/08-roadmap.md`。
- 验收：真实生成需 staging 的 `FAL_KEY`（与 add-plugin-system 7.1 一起执行）。
