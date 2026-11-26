# Design

## Context

动机见 proposal.md。现状要点（2026-11-26 盘点）：

- `plugins/media` 已有完整的私有生成链路：`submitWorkspaceMedia`（限流 → 事务内锁积分、权益、模型、参数校验、并发与存储检查 → 建 `ai_task` → 预扣 → Workflow），
  输出持久化到私有 R2 桶 `FILES` 的 `ws/<ws>/ai/<taskId>/<index>`，`file` 行 `purpose = ai_output`、`sourceTaskId` 指向任务。
  页面只有通用提交页 `/app/$slug/media/new` 与任务列表 / 详情；模型下拉显示原始 key。
- 公开访问只有 `file.publicToken` 分享：`/api/files/shared/$token` 302 到 300 秒签名地址、`no-store`、无限流，不适合作为公开页素材。
- 分享页 `/s/<type>/<token>` 按设计 noindex、不进站点地图，不能当 SEO 落地页。
- 站点地图由 `getPublicPages()` 与 `projectPages()` 同步生成，没有数据库来源；robots 由 `features/seo/crawlers.ts` 生成。
- 插件不能拥有表（表与迁移统一在 `packages/db`），admin-mcp 的工具是静态数组，插件不能注册。
- 审核、举报、NSFW 检查都不存在；Turnstile 服务端校验在 `packages/auth/src/protection.ts`；原生限流绑定在生产不可靠（`docs/08-roadmap.md`）。
- 删号 / 删空间清理通过 `registerDeletionStep` 与 jobs `workspace-cleanup`；`file` / `ai_task` 外键对空间为 `restrict`。
- 公开页约束：public-site-availability（数据库不可达降级、插件绑定缺失只让该插件 503）、Neon 成本基线（无访客时可缩容到零、不为公开页轮询）。

## Goals / Non-Goals

**Goals:**

- 衍生项目启用一个插件即可得到可上线的图片 / 视频生成站基础形态：创作、作品库、公开画廊、作品页、审核与举报。
- 复用 media 的提交、计费、存储与 Workflow，不复制计费逻辑，不改变现有任务语义。
- 公开页在零流量时不产生数据库访问，热点作品主要由边缘缓存承担。

**Non-Goals:**

- 点赞、评论、关注、作者主页、作品集、排行榜（后续按需求另提）。
- 图片缩略图与格式转换（需要 Cloudflare Images 或额外处理管线）；首版直接输出原图，配合懒加载与 `sizes`。可选的 Image Resizing 放到风险缓解中，不在任务里实现。
- 视频转码、封面抽帧；视频卡片用 `preload="metadata"` 显示首帧。
- 自动 NSFW 分类模型：只提供发布前检查钩子，模板不内置分类。
- 独立公开 R2 桶与自定义域名（使用者 2026-11-26 选择 Worker 路由方案）。
- 多语言作品内容：作品是用户原文，作品页不做 hreflang 互链。

## Decisions

### 1. 一个 `studio` 插件，依赖 media

`plugins/studio` 清单：`requires: { plugins: ['media'], features: ['billing','credits'] }`，`targets: ['cloudflare','node']`，
配置段 `z.strictObject({ kinds?: ('image'|'video')[], publishDailyLimit?: number (默认 20), reportHideThreshold?: number (默认 3), galleryPageSize?: number (默认 24) })`。
实际启用的模式 = `kinds`（默认两者）∩ `templateConfig.ai.image/video`。
备选：两个插件 + 共享 gallery 包——多一层依赖与重复，使用者选择单插件。

studio 不替换 media 的通用提交页与任务页：它们仍服务公开 API 用户与管理员调试；启用 studio 后 media 的「生成」导航项隐藏（media 的 `visible` 增加 `!plugins.studio` 判断），任务列表保留。

### 2. 数据模型：作品只在发布时建行，「我的作品」是输出文件视图

- 「我的作品」直接查询 `file`（`purpose = ai_output`、`deletedAt is null`、`sourceTaskId` 对应 `ai_task.status = succeeded`），左连接 `studio_work` 取公开状态。
  不为每个输出预建行，避免与 media Workflow 耦合（media 不需要知道 studio）。
- 新表 `studio_work`（`packages/db/src/schema/studio.ts`）：
  `id` UUIDv7、`workspace_id`、`user_id`（发布者）、`file_id`（唯一，一个输出文件最多一个作品）、`task_id`、`kind`、`site`（发布时站点键，单站点为默认键）、
  `slug`（唯一）、`title`、`prompt`（发布时快照，取任务输入中的用户提示词，不含预设文本）、`show_prompt`、`model_key`、`width` / `height` / `duration_ms`、
  `visibility`（`public | private`）、`moderation`（`pending | approved | hidden | removed`）、`removal_reason`、`featured_at`、`version` int、
  `report_count` int、`published_at`、`reviewed_at`、`reviewed_by`、时间戳。
  索引：`(site, visibility, moderation, published_at desc)`、`(site, featured_at desc) where featured_at is not null`、`(workspace_id, id desc)`、`(moderation, published_at)`。
- 新表 `studio_report`：`id`、`work_id`（cascade）、`reporter_key`（`u:<userId>` 或 `ip:<HMAC(ip, BETTER_AUTH_SECRET 派生键)>`）、`reason` 枚举（`sexual | violence | hate | copyright | spam | other`）、`note`（≤500）、
  `resolved_at`、`resolution`、`created_at`；唯一 `(work_id, reporter_key)`。
- 公开判定统一为一个 SQL 谓词 `visibility = 'public' and moderation in ('pending','approved') and 作者未封禁且未删号 and 文件未删除`，
  画廊、作品页、媒体路由与站点地图共用（`approved` 另用于收录判断）。
- 作者封禁：查询时连接 `user.banned`，不改作品行，解除封禁自动恢复。
- 删除：事务内递增版本、删 `studio_work`（举报级联）并软删 `file`；提交后失效旧地址并调用现有存储适配器删除 R2 对象。
  对象删除失败时，现有文件清理任务按软删记录重试。
- 删号 / 删空间：`registerDeletionStep` 在删除事务中先清理作品与举报。删号清理个人空间的作品、本人发布的作品及本人任务关联的作品。
  删空间时，底层产出仍走原有保留期，空间恢复后可重新发布。插件停用时，既有 AI 清理先删除待清理任务的作品，也按发布者清理已删号用户在团队空间发布的作品。文件清理暂缓删除仍被作品引用的文件。
- `ai_model.display_name text null`（迁移 + 后台模型编辑器字段 + MCP `models.list` 返回、`models.update` 可写）。
- 2026-11-26 核对 PostgreSQL 17 文档：`RESTRICT` 拒绝删除仍被引用的行，`CASCADE` 随作品删除举报，精选索引仅收录匹配谓词的行。[外键约束](https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-FK)、[部分索引](https://www.postgresql.org/docs/17/indexes-partial.html)
- 2026-11-26 核对 Cloudflare：R2 `delete` 成功后，随后的直接对象读取全局可见删除结果。已缓存的 HTTP 响应仍按决策 5 失效。[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions)、[R2 一致性](https://developers.cloudflare.com/r2/reference/consistency/)

### 3. 创作页复用 media 提交

media 插件导出 `submitWorkspaceMedia` 与参数表单组件给 studio（插件间依赖经 `@saas/plugin-media` 的显式导出入口；`requires.plugins` 保证同时启用）。
studio 的 Server Function `submitStudio({ mode, modelKey, prompt, presetId?, params })`：
校验模式启用 → 取模型 schema，要求有 `prompt` 字符串字段（没有的模型不出现在 studio 模型列表）→ 组合预设 → 调 `submitWorkspaceMedia`。
提交事务以同一份模型配置校验模式与参数；参考图须是当前空间已确认、未删除的图片文件。选中的预设文本另起一行附加，
合成后的文本进入 `ai_task.input.params.prompt`，原始用户文本独立保存为 `ai_task.input.userPrompt`，供发布时生成提示词快照。
页面结构：模式切换（图片 / 视频）、提示词主输入、模型选择（显示名）、参考图（schema 有 `format: file` 字段时显示）、预设、
「更多设置」折叠区（参数表单去掉 prompt 与 file 字段）、预估积分与提交；下方为本次会话结果与最近作品条。
轮询复用 media 的 `polling.ts`（页面隐藏时暂停）。提示词预设在项目自有 `plugins/studio/src/studio.project.ts`（登记为 template-sync 项目自有文件），默认空数组。

- 2026-11-26 核对官方文档：TanStack Start 在 Server Function 进入处理器前执行输入校验，客户端通过 RPC 调用。Cloudflare Workflow 的 `create({ id, params })` 可绑定任务 ID 与输入；R2 预签名 PUT 可签入 `Content-Type`。Studio 继续复用 Media 的工作流和上传确认链路。[TanStack Server Functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions#parameters--validation)、[Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/#create)、[Cloudflare R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/#best-practices)
- 2026-11-26 核对 Wrangler：`kv key delete --local` 只删除本地 KV 键，`--persist-to` 可与 Vite Worker 共用持久化目录。图生视频测试先预热旧模型列表，写入数据库夹具后只删除 `CACHE` 的模型列表键，覆盖已有缓存的场景。[Wrangler KV 命令](https://developers.cloudflare.com/workers/wrangler/commands/kv/#kv-key-delete) · [本地数据](https://developers.cloudflare.com/workers/local-development/local-data/)

### 4. 公开路由与 URL

- 画廊 `/gallery`（`?kind=image|video`、`?sort=featured`、`?page=n`）；作品页 `/gallery/$slug`。画廊数值页最多 50 页，后续用游标。空白首页可访问，超出实际页数的后续页返回 404。
- `slug = <ascii 化标题，最多 60 字符>-<作品 id 的 base36 后 8 位>`，标题无 ASCII 字符时只用后缀；标题改动不改 slug。
- 路由按插件 `routes` 挂载在根；多站点项目中按请求站点过滤 `site`，非本站作品返回 404。
- 发布时按请求来源冻结站点键。单站点用默认站点键。配置 `plugins.studio.sites` 时，请求来源须匹配对应的站点定义或仍可用的默认站点。「我的作品」中公开作品的预览用该站点的绝对媒体地址，站点地址无法解析时回退到需要会话的空间文件接口。
- 2026-11-26 核对 srvx：默认根据连接协议和收到的 Host 生成 `Request.url`，`trustProxy` 启用后可依据可信代理的转发头还原协议和主机。模板 Node HTTP 入口使用 srvx 的 URL，`TRUSTED_PROXY_CIDRS` 用于解析请求元数据。启用多站点时须核对入口看到的来源和 `sites` 配置一致。[srvx 代理设置](https://srvx.h3.dev/guide/options#trustproxy)
- 公开页是 SSR 页面（不预渲染），`pageHead` 输出 title / description / canonical / OG；作品页 JSON-LD 为 `ImageObject` 或 `VideoObject`；
  作品页 `noindex` 当且仅当 `moderation != approved`；画廊带筛选参数的地址 canonical 指向不带参数的第一页，`?page=n` 自身 canonical。
- seo-internal-linking：画廊与作品页是数据库页面，不进入构建期链接图；作品页内链（返回画廊、相关作品）在页面内满足规范，
  画廊入口加入页脚链接由项目决定（模板在 `site.config` 示例中注释说明）。

### 5. 公开媒体：Worker 路由 + 版本化地址 + 边缘缓存

- 地址 `/media/w/<workId>/<version>`。处理器挂在插件 `worker` 入口的 fetch 前置处理（静态资源之后、TanStack 之前），不进入 SSR。
- 单站点沿用 `APP_URL` 与 `default` 站点键。多站点用 `plugins.studio.sites` 声明站点键对应的规范来源，
  请求来源决定站点键，读取与清除使用同一规范 URL。单站点的预览等别名可以直读，只有规范来源写入 Worker Cache API。
- 流程：先查 `caches.default`（键为规范化地址，不含 Range 头）；未命中则查库确认公开谓词与 `version` 一致 → `FILES.get(r2Key)` →
  响应 `Cache-Control: public, max-age=3600, s-maxage=86400`、`ETag`、`Content-Type`、`Accept-Ranges: bytes`，`ctx.waitUntil(cache.put)`。
  带 Range 的请求：缓存命中时由 `cache.match` 返回 206；未命中时直接 `FILES.get(key, { range })` 返回 206 并异步回填完整对象（对象 ≤ 100MB，与上传上限一致）。
  完整请求用 `tee()` 将同一对象流交给客户端和缓存。范围请求的完整对象回填使用独立的存储流。
  2026-11-26 核对 Workers 的 `tee()` 对上游按较慢分支施加背压，前提是源支持背压。[Workers ReadableStream](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestream/#methods)
- 失效：取消发布 / 删除 / 下架 / 隐藏时 `version + 1`，并对旧地址执行本机房 `cache.delete`；
  配置了 `CF_PURGE_TOKEN` 与 `CF_ZONE_ID`（可选密钥）时调用 Cloudflare 按 URL 清除。未配置时其他机房的旧副本最长 1 天后过期——
  旧地址只在作品页曾公开期间被引用，属于可接受窗口；下架违法内容时文档要求配置清除凭据。
- Node 目标：无 Cache API，同一处理器只设置相同的 Cache-Control，交给 Caddy / CDN；Range 由存储适配器的范围读取支持（自托管 S3 兼容 `GetObject` Range）。
- 备选：独立公开桶 + 自定义域名（性能最好但需新建桶、域名与清理流程，使用者未选）；继续用 `publicToken` 302 签名地址（无法缓存、每次查库，否决）。
- 2026-11-26 核对 Cloudflare 文档：回填完整 200 响应时保留 `Content-Length`，命中查找保留请求的 `Range` 头，使 `cache.match()` 能返回 206。R2 `get` 支持按偏移、长度或后缀读取。`cache.delete()` 只作用于当前数据中心；按 URL 全局清除应使用实际缓存 URL，Cloudflare 不支持按 URL 清除 Worker 自定义缓存键。[Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)、[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads)、[缓存清除行为](https://developers.cloudflare.com/workers/reference/how-the-cache-works/)、[Purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)
- 2026-11-26 核对官方文档。Worker 使用 `FixedLengthStream` 保留流式响应的 `Content-Length`。按 URL 清除使用带 `Cache Purge` 权限的 Zone 级 Bearer token，向 `POST /client/v4/zones/{zone_id}/purge_cache` 发送 JSON `{"files":["<完整规范 URL>"]}`。HTTP 200 且 `success: true` 表示请求已接受，是否清除仍需重新访问旧地址验证。自托管 S3 `GetObject` 接收单个 `Range`，返回实际片段的 `Content-Length` 与 ETag。[Workers Response](https://developers.cloudflare.com/workers/runtime-apis/response/#set-the-content-length-header)、[Cloudflare Purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/)、[S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)

### 6. 公开页缓存与降级

- 画廊、作品页、`/sitemap-gallery.xml` 的响应由插件 worker 前置处理做边缘缓存：匿名请求（无会话 Cookie）按「地址 + 站点 + 部署版本」键缓存，
  `s-maxage=300`（站点地图 3600）；有会话的请求不缓存（页头含用户菜单）。作品状态变化时对作品页本机房 `cache.delete`，其他机房 ≤ 5 分钟。
- 数据库不可达：loader 捕获连接错误，渲染带站点导航的错误组件（`errorComponent` 复用公开页错误壳），状态 503 且不缓存。
- 插件绑定缺失：`pluginUnavailable(runtime, 'studio')` 时这些地址返回 503，其他页面不受影响。
- 无 Cron、无轮询；举报计数在写入时更新。

### 7. 发布、审核状态机

```
(无作品行) --发布[检查放行]--> public/pending --管理员通过--> public/approved
           --发布[检查转人工 或 检查异常]--> public/hidden
           --发布[检查拒绝]--> 不建行，返回原因
public/pending|approved --举报达阈值--> public/hidden --恢复--> 原状态（hidden 前若为 pending 则回 pending）
任意 public/* --管理员下架(原因)--> removed（用户不可再发布或取消发布、不可见）  --恢复--> pending
public/pending|approved|hidden --用户取消发布--> private（moderation 保留）
```

`hidden` 前的状态存 `moderation_before_hide`（小列）以支持恢复。每日上限在写入作品的同一事务中按 `studio_publication(user_id, published_at)` 统计 UTC 当天的成功发布，跨空间共用。
撤回和删除消耗过的额度保留到日切；重新发布计作新的一次，已经公开的请求重放返回现有作品。用户下一次成功发布时清理自己的过期记录，删号清除全部记录。
首次发布冻结站点键、发布者、提示词和 slug。重新发布时，已通过的私有作品在检查放行后仅当标题和提示词可见性均未变化才保留 `approved`，否则回到 `pending`。标题去首尾空白后最多 120 字符。
发布前检查：`plugins/studio/src/moderation.project.ts` 导出 `checkPublish({ title, prompt, kind, modelKey, workspaceId })` → `allow | review | reject(reason)`，项目自有、默认 `allow`，异常按 `review`。
2026-11-26 核对 PostgreSQL 17：事务级 advisory lock 在事务结束时释放；`READ COMMITTED` 的后续计数语句能看到前一事务已提交的额度。
复合 B-tree 索引用用户等值与时间范围缩小扫描。[锁行为](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS)、[隔离级别](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)、[复合索引](https://www.postgresql.org/docs/17/indexes-multicolumn.html)

### 8. 后台审核

- 路由 `/admin/studio`（插件 `routes/admin/studio.tsx`），DataTable + `features/admin/list.ts`，分栏：待审核（按 `published_at` 升序）、被举报（`report_count > 0 且有未处理举报`）、已隐藏、已下架。
- 操作经 `adminAction`：`studio.work.approve`、`studio.work.remove`（必填原因 enum 或文本，最多 200 字符）、`studio.work.restore`、`studio.work.feature`、`studio.work.unfeature`；用 `defineAdminActions('studio', …)` 登记 step-up 级别：
  全部为 `never`（不涉及资金与账号，频繁操作；下架可恢复）。批量通过 / 下架（每次 ≤ 50）放 P1。
- 恢复时将未处理举报标记为已处理，保留累计举报数与去重记录。举报原因按作品汇总累计与未处理数量。
- 2026-11-26 核对 Cloudflare R2：预签名 GET 允许在签名有效期内读取单个对象。审核预览由后台鉴权后按需签名，响应设为 `private, no-store`。[R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- `adminNav`：分组 `operations`，`count` = 待审核 + 已隐藏数量（与 add-admin-step-up 的导航计数同一机制，按需 `import()` 加载，不进后台入口包闭包）。

### 9. 举报

`POST /api/studio/reports`：作品须公开可见；登录用户以 `u:<id>` 为键；未登录必须带 Turnstile token（复用 `packages/auth/src/protection.ts` 校验，未配置 Turnstile 时匿名举报关闭，只允许登录举报）。
举报入口与公开媒体共用请求站点解析：多站点按配置中的 origin 选站，作品查询再按站点过滤。触发隐藏的已收件举报可由原举报人重试，重试不写入或增加计数。
限流：复用 `RL_AUTH` 的原生 10 次 / 分钟策略，举报使用独立键。第二层用唯一键去重，并在作品行锁内限制每作品最近 1 小时最多接受 10 条匿名举报。
插入成功（非重复）时事务内 `report_count + 1`，不同举报人的未处理举报数 ≥ 阈值且状态为 `pending|approved` 时记录此前审核状态、转 `hidden` 并递增版本。事务提交后调用作品失效回调。
- 2026-11-26 核对 Cloudflare：Turnstile token 必须经 Siteverify 校验，token 有效期 5 分钟且供单次校验使用。Workers 原生限流在各机房独立计数，按近似额度执行。[Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) · [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- 2026-11-26 核对 PostgreSQL 17：`FOR UPDATE` 串行化同一作品的举报与审核；默认 `READ COMMITTED` 下，取得行锁后的计数语句可见上一事务已提交的举报。[行锁](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS) · [事务隔离](https://www.postgresql.org/docs/17/transaction-iso.html#XACT-READ-COMMITTED)

### 10. 插件附加站点地图

插件 `web` 契约增加 `sitemaps?: readonly string[]`；`robots()` 接收已启用插件的地址并逐行输出 `Sitemap:`。
2026-11-26 核对 Google 的 robots 文档：可声明多条 `Sitemap:`，每条使用含协议和主机的完整网址。[robots.txt 规则](https://developers.google.com/crawling/docs/robots-txt/robots-txt-spec#sitemap)
`/sitemap-gallery.xml` 列出本站点 `approved` 作品（按 `published_at` 倒序，单文件上限 50,000 条；超过时分页为 `/sitemap-gallery-<n>.xml`，最多 10 片），含 `lastmod`。空的第一片可访问，超出实际分片数的后续页返回 404。
主站点地图不变，两者地址不重叠（画廊列表页 `/gallery` 本身放主站点地图：经 studio 的 `web` 契约提供静态公开页条目，由 `getPublicPages` 合并；若契约暂不支持则放画廊站点地图首条）。

### 11. 管理员 MCP 插件工具（P2）

admin-mcp 的 `adminTools` 改为「内置工具 + 已启用插件 `web` 入口导出的 `adminMcpTools`」，在生成的插件注册表中汇总，名称前缀校验在生成时失败。
studio 提供 `studio.works.list`（read：按分栏、站点、页码或游标）与 `studio.works.moderate`（write：approve / remove(reason) / restore / feature / unfeature，支持 `dryRun`，沿用后台的 `never` step-up 级别）。
插件入口用 `createServerOnlyFn` 返回以工具名为键的对象字面量，生成器仅解析名称并校验前缀和重名。生成的 MCP 注册表只导入工具贡献者。工具调用与后台确认解析共用同一工具表，Studio 正式写入在审核事务提交后清除旧版本缓存。
2026-11-26 核对官方文档。MCP 通过 `tools/list` 发现工具，名称在同一服务器内唯一，可含点号。TanStack Start 的 `createServerOnlyFn` 将实现限定在服务端，浏览器调用时抛错。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-names) · [TanStack Start 执行模型](https://tanstack.com/start/latest/docs/framework/react/guide/execution-model#server-only-execution)
同 PR 更新 `docs/admin-mcp.md` 工具表。

### 12. 设计稿

一个 Design 画布覆盖：创作页（图片 / 视频、进行中、完成、余额不足、空态）、我的作品（网格、筛选、状态徽标、空态）、发布对话框、
画廊（桌面 / 手机、筛选、空态、错误态）、作品页（图片 / 视频、待审核提示仅作者可见、举报对话框）、后台审核页。
使用者确认后登记原型索引，再实现第 4 组以后的界面任务。

**已确认**（2026-11-26）：见[原型索引](../../../docs/design-system/prototypes/README.md)「创作页」「我的作品」「公开画廊」「作品页」「后台作品审核」五行，副本在 `docs/design-system/prototypes/media-studio/`。组件变更：`@saas/ui` 新增 Collapsible（更多设置）与 RadioGroup（举报原因），DataTable 增加行选择（后台批量操作）。

## Risks / Trade-offs

- [边缘缓存的旧副本在其他机房最长 1 天] → 版本化地址使新页面不再引用旧地址；违法内容下架时配置 `CF_PURGE_TOKEN` 主动清除，文档写明。
- [原图直出导致画廊流量大、LCP 慢] → 懒加载、显式宽高防布局抖动、每页 24 条；后续可在 Cloudflare 开启 Image Resizing，用 `/cdn-cgi/image/width=…` 包装地址（单独提案）。
- [先发后审期间不良内容公开可见] → noindex 不扩散到搜索引擎；举报阈值自动隐藏；发布前检查钩子；每日发布上限；封禁作者即时隐藏。
- [匿名举报被滥用以隐藏他人作品] → Turnstile、按网络标识去重、每作品每小时匿名举报上限；隐藏后由管理员复核恢复。
- [Workers 单请求内存与 100MB 视频] → 媒体路由流式返回 R2 body，不读入内存；回填缓存用 `tee()`。
- [media 导出内部函数给 studio 造成耦合] → 只导出 `submitWorkspaceMedia`、模型查询与表单组件三处，加类型化入口与测试；media 不反向依赖 studio。
- [画廊查询在库内增长后变慢] → 复合索引覆盖筛选与排序；分页用 `published_at, id` 游标（`?page=n` 映射为偏移上限 50 页，之后只提供「更早」游标链接）。

## Migration Plan

1. 迁移新增两张表与 `ai_model.display_name`（纯新增，可回滚为 drop）。
2. 插件默认在模板启用；衍生项目经 template-sync 获得代码，但需在 `template.config.ts` 显式启用才生效（插件默认关闭语义不变）。
3. 回滚：在配置中停用 studio 并重新部署即可下线所有页面与路由；已发布作品数据保留。

## Open Questions

- 画廊入口是否默认进页脚导航：由项目在启用后决定，不影响实现。
