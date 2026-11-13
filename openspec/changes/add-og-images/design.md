# Design

## Context

- **现有分享图**：`apps/web/scripts/og-images.ts` 用 `cf-workers-og@3.0.1` 的 Node 入口（satori 0.18 + resvg-wasm 2.6）在构建期生成公开页面的 1200×630 PNG，输出到 `dist/client/og/`。字体是 Noto Sans SC Regular 的完整简体子集 OTF（约 8.3 MB），只供构建期读取，WASM 也不进 Worker（见 `apps/web/src/features/seo/README.md`）。
- **Worker 现状**：服务端入口约 0.7 MB，gzip 后约 0.15 MB（2026-10 的构建产物）。新增 `@resvg/resvg-wasm` 约 2.5 MB、yoga 约 0.08 MB、satori JS 约 0.5 MB。按 Workers 付费版 10 MB 的压缩上限仍有余量，但会增加部署体积和首个请求实例化 WASM 的成本。
- **已有的可复用部分**：
  - R2 `FILES` 绑定与 `packages/storage`；
  - KV `CACHE`；
  - 限流绑定 `RL_AUTH`、`RL_AI`、`RL_API`。线上原生限流绑定当前不生效，见已知问题。
    - 删空间清理（`packages/auth/src/ai-content-cleanup.ts` 等）；
  - 首页包检查 `apps/web/scripts/check-home-bundle.mjs`。
- **约束**：
  - React 只允许在 `packages/ui`（以及 email）中使用，但 apps/web 本身是 React 应用，可以放服务端 JSX。
  - 页面与版式不能写死颜色（`check:ui`）。
  - 公开路由查库必须符合 Neon 成本基线：缓存命中时不查库。
  - 自托管目标（Node）也要能用。

## Goals / Non-Goals

**Goals:**
- 衍生项目只需注册卡片类型、写一个解析函数和一个版式，就能得到会到期、可失效、可缓存的结果卡片和通用分享页。
- 访问控制归项目：模板不存分享关系，只按项目解析结果渲染，并统一执行到期与失效。
- 渲染成本只在缓存未命中时发生；首页与其他路由的包体积、冷启动不变。

**Non-Goals:**
- 不做通用的图片编辑或模板设计器。
- 不支持卡片内的远程图片（头像、外链图）。远程抓取会带来 SSRF 与超时风险，以后需要时再单独评估。
- 不把构建期静态分享图改为运行时生成。
- 不提供分享按钮、分享表与撤销界面，这些属于项目业务；模板只提供令牌工具、失效函数、通用分享页与元数据工具。

## Decisions

### 1. 访问控制归项目：解析函数

模板不建分享表。分享关系（谁分享了什么、是否撤销）由项目在自己的表中维护，模板只认项目注册的解析函数：

```ts
interface ShareResolution<T> {
  workspaceId: string          // 用于缓存索引与删空间清理
  sharedAt: Date
  expiresAt?: Date | null      // 省略 = sharedAt + ttlDays；null = 永不过期
  data: T
}
resolve(token: string, ctx: ShareCardContext): Promise<ShareResolution<T> | null>
```

- 模板提供 `createShareToken()`：32 字节随机数，base64url 编码。文档要求令牌不含资源 ID，并建议项目用部分唯一索引保证同一资源只有一条有效分享。
- 每个类型可声明 `tokenPattern`，默认 `/^[A-Za-z0-9_-]{22,64}$/`。格式不符直接 404，不调用 `resolve`。
- 备选方案：
  - 模板提供 `share_link` 表（原方案）：每个项目少写一张表，但模板要承担资源归属与撤销语义；使用者决定交给项目（2026-11-13）。
  - 签名 URL：无法单条撤销，且把资源 ID 编码进 URL，不采用。

### 2. 卡片类型注册

在 `apps/web/src/features/share-cards/registry.ts` 提供 `registerShareCard(def)`：

```ts
interface ShareCardDefinition<T> {
  type: string                 // 小写短横线，用于路由
  version: number              // 版式版本，改版式时递增
  tokenPattern?: RegExp
  ttlDays?: number | null      // 默认 90；null = 永不过期
  sharePage?: false            // 关闭通用分享页，项目自建页面
  resolve(token: string, ctx: ShareCardContext): Promise<ShareResolution<T> | null>
  digest(data: T): string      // 只对展示用的字段做摘要
  render(data: T, theme: ShareCardTheme): JSX.Element
  alt(data: T): string
  page(data: T): { title: string; description: string }   // 通用分享页与元数据用
}
```

- 有效期：`expiresAt` 优先；省略时为 `sharedAt + ttlDays`；`ttlDays` 默认 90 天，常量放 `template.config.ts` 的 `shareCards.defaultTtlDays`，项目可整体或按类型修改。
- 项目在自有文件 `share-cards.project.ts` 中注册，与 `nav.project.ts` 的模式相同，模板不写这个文件。重名注册在启动时抛错。
- 模板的示例类型 `sample` 只在测试与 `/dev/ui` 中注册，用内存数据实现 `resolve`。

### 3. 地址与缓存

- **卡片地址**：`/share-card/<type>/<token>.png?v=<version>-<digest8>`。由元数据工具调用 `resolve` 与 `digest` 生成，所以展示数据一变，地址就变。
- **R2 键**：
  - 图片：`share-cards/img/<type>/<token>/<version>-<digest>.png`，customMetadata 记 `expiresAt` 与 `workspaceId`；
  - 空间索引：`share-cards/ws/<workspaceId>/<type>/<token>`，空对象，供删空间时按前缀列出。
- **请求处理顺序**：
  1. 令牌格式校验（不符 404）。
  2. KV 撤销标记 `share-revoked:<type>:<token>`（存在则 404）。
  3. Cache API（自托管跳过）。
  4. R2 图片：命中时检查 customMetadata 的 `expiresAt`，已过期就删除并 404。
  5. 都未命中才限流、调用 `resolve`，校验到期，确认当前摘要与 `v` 一致（不一致 302 到新地址），然后渲染，写入 R2 图片、空间索引与 Cache API。
- **响应头**：
  - `Content-Type: image/png`
  - `Cache-Control: public, max-age=min(86400, 剩余秒数), s-maxage=min(31536000, 剩余秒数)`；永不过期时加 `immutable`
  - `X-Robots-Tag: noindex`
  - `X-Content-Type-Options: nosniff`
- **失效函数** `invalidateShareCard({ type, token, workspaceId })`：删除 R2 图片前缀与空间索引，写 KV 撤销标记（TTL 一天，覆盖边缘缓存周期）。项目在撤销分享、删除被分享资源时调用。修改资源不必调用，摘要变化会换地址。
- **备选方案**：只用 Cache API，不用 R2。Cache API 按数据中心隔离，各地会重复渲染，所以不采用；R2 保证全局只渲染一次。

### 4. 渲染器与懒加载

- 新建 `apps/web/src/features/share-cards/render.server.ts`。路由处理函数用动态 `import()` 加载它，所以 WASM 与 satori 只在分享卡片路由的首次请求时实例化，同一实例内复用。
- Cloudflare 使用 `cf-workers-og` 的 Workers 入口，Node（自托管与构建期）使用 `/node` 入口。两者共用版式代码 `layout.tsx` 与主题。
- 构建期生成器 `og-images.ts` 改为复用同一套默认版式。已确认的变更：默认分享图不再用写死的深蓝渐变，改为主题 token 版式（原型索引「分享卡片版式」行，`share-cards/Card.dc.html` 的 `default` 变体）。
- 首页包检查扩展一条：服务端与客户端的首页闭包中不得出现 `share-cards/render`、`resvg`、`satori`。

### 5. 字体

- 西文用 Inter 的 Latin 子集（约 100 KB），随渲染器打包。
- CJK 用现有的 Noto Sans SC Regular OTF，作为静态资源发布到 `/fonts/share-card/` 下，带长期缓存与 `X-Robots-Tag: noindex`。只有待渲染文本含 CJK 字符时才通过 `ASSETS.fetch` 读取，同一实例内缓存解析后的字体。自托管从本地文件读取。
- 风险是完整 CJK 字体在冷实例上的解析耗时与内存，第 7 条的验证会量化它。不达标时改用 GB2312 一级常用字子集（约 1.5–2 MB）作为运行时字体，构建期仍用完整字体。

### 6. 主题与版式约束

- `packages/ui` 新增 `share-card-theme.ts`，导出解析后的 token 值，包括 background、foreground、muted、primary、primary-text、border、radius 与字号阶梯。单测保证它与 `tokens.css` 的基线值一致。
- 项目在自有文件 `share-cards.theme.ts` 中覆盖品牌值，与 `brand.css` 保持对应，并登记到 `check-ui.allow.local.json` 的 exceptions，原因写「分享卡片在服务端渲染，无法读取 CSS 变量」。
- 版式只用 satori 支持的 flex 子集，文本最长字数由各类型定义；超长时截断并加省略号，在渲染前按字数截断，不依赖 CSS 的 `line-clamp`。

### 7. 可行性验证（先做，决定后续步骤）

在一个 worktree 中，把渲染路由与示例卡片部署到 staging 的临时 Worker 版本，或者用 `wrangler versions upload` 上传但不切换流量，测量以下指标，阈值如下：

| 指标 | 阈值 |
|---|---|
| 部署包压缩体积增量 | ≤ 2.5 MB |
| 冷实例首次渲染（含 CJK 字体）CPU 时间 | ≤ 1500 ms |
| 热实例渲染 CPU 时间 | ≤ 300 ms |
| 峰值内存 | ≤ 96 MB |
| 首页冷启动 | 无可测变化 |

- **全部达标**：按本设计继续。
- **CJK 冷启动超标**：改用第 5 条的常用字子集。
- **包体积或内存超标**：把渲染移到 jobs Worker（经服务绑定调用），web 路由只负责缓存与转发。
- 结论写入本文件和证据库，再进入实现。

### 8. 通用分享页

- 路由 `apps/web/src/routes/s.$type.$token.tsx`：服务端调用 `resolve`，有效时渲染卡片图片、`page(data)` 的标题与描述、前往首页 / 注册的入口；无效、到期、撤销或该类型 `sharePage: false` 时渲染 404 页。
- 每次访问都调用 `resolve`，会查库；访问来自真实访客与平台抓取器，符合 Neon 成本基线。响应带 `Cache-Control: public, s-maxage=300` 与 `X-Robots-Tag: noindex`，撤销后最多 5 分钟失效（失效函数同时写 KV 标记，页面路由也先查标记）。
- 页面只用 `@saas/ui` 组件；设计稿见原型索引 `docs/design-system/prototypes/README.md` 的「通用分享页 /s/$type/$token」行。
- 自建分享页的项目用 `shareCardMeta(type, token)` 输出同一套元数据。

### 9. 限流

卡片缓存未命中与分享页请求时，按 IP 走 `RL_API` 同类的新限流绑定 `RL_SHARE_CARD`，默认每分钟 30 次。线上原生限流绑定目前不生效（见 cf-ratelimit 记录），所以另有两道兜底：
- 令牌格式校验：不符合类型声明格式的请求直接返回 404，不调用 `resolve`；
- 渲染并发上限：同一实例同时最多渲染 2 张，超出返回 503，并带 `Retry-After`。

### 10. 删除

- 删空间清理（含删号时的个人空间）按 `share-cards/ws/<workspaceId>/` 列出索引，对每个令牌执行失效函数。
- 项目自有的分享表由项目在自己的清理流程中删除；模板文档写明这一点。

## Risks / Trade-offs

- **[Worker 包体积增长，部署和冷启动变慢]** → 渲染器懒加载，并在验证阶段量化；超标时移到 jobs Worker。
- **[完整 CJK 字体解析慢、占内存]** → 只在文本含 CJK 时加载，并在实例内缓存；超标时改用常用字子集，生僻字可能显示为方框，这一点在升级说明中写明。
- **[项目忘记调用失效函数，撤销后 R2 仍返回旧图]** → 文档与示例把失效写进撤销流程；到期仍由 R2 元数据兜底。
- **[边缘缓存在撤销后最多一天内仍可能返回旧图]** → 加 KV 撤销标记；文档说明撤销对已经抓取过卡片的社交平台无效，平台自己会缓存。
- **[原生限流不生效]** → 用令牌格式校验与渲染并发上限兜底；限流修复后自动生效。
- **[项目版式写死颜色]** → 主题对象加 `check:ui` 例外机制，版式文件本身仍受检查。

## Migration Plan

1. 没有数据库迁移。
2. 部署：只需部署 web；新增 `RL_SHARE_CARD` 绑定须先在各环境声明。
3. 回滚：回退代码即可，R2 中 `share-cards/` 前缀的对象可保留或手动删除。
4. 衍生项目同步后不注册卡片类型，就不会有行为变化。注册之后需要：自建分享表并在撤销与清理时调用失效函数；在 R2 中确认 `share-cards/` 前缀的生命周期规则（不设自动过期）；新增 `RL_SHARE_CARD` 限流绑定（各环境都要声明）。

## Open Questions

无。2026-11-13 使用者决定：只做渲染、访问控制归项目；默认 90 天到期、项目可改；模板提供通用分享页路由。
