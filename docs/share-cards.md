# 分享卡片与分享页

衍生项目把一次结果（报告、生成内容等）分享到社交平台时，预览图显示这次结果自己的标题和要点。
模板只负责渲染、缓存、到期、失效与元数据；**分享关系由项目自己的表维护**，模板不存储谁分享了什么。
设计依据见 OpenSpec change `add-og-images`（归档后在 `openspec/specs/share-cards/`）。

- 卡片图片：`GET /share-card/<type>/<token>.png?v=<version>-<digest8>`，1200×630 PNG。
- 通用分享页：`GET /s/<type>/<token>`，显示卡片、标题、描述与站点入口，`noindex`。
- 代码：`apps/web/src/features/share-cards/`；对象存储与失效：`packages/storage/src/share-cards.ts`；
  主题基线：`packages/ui/src/share-card-theme.ts`。
- 没有注册任何类型的项目没有行为变化：两条路由对所有请求返回 404。

构建期为公开页面生成的静态分享图（`dist/client/og/`）与本文的运行时卡片共用默认版式与渲染核心，
说明见 [SEO README](../apps/web/src/features/seo/README.md#分享图片)。

## 1. 接入步骤

1. **建分享表**（项目 schema，见第 2 节），撤销与删除流程调用失效函数（第 3 节）。
2. **注册卡片类型**：在项目自有文件 `apps/web/src/features/share-cards/share-cards.project.ts` 的
   `registerProjectShareCards()` 中调用 `registerShareCard`。模板只创建这个文件，之后不再修改，
   `template-sync` 也不会覆盖它。注册入口在分享路由首次加载时执行，首页不加载分享模块。
3. **生成分享**：创建分享时用 `createShareToken()` 生成令牌并写入分享表，把 `/s/<type>/<token>`
   （或项目自建页面的地址）交给用户。
4. **页面二选一**：使用通用分享页，或设置 `sharePage: false` 后自建页面并用 `shareCardMeta` 输出元数据（第 5 节）。
5. **版式需要设计稿**：新的卡片版式与自建分享页先经 `ui-design` 技能取得使用者确认的设计稿。

注册示例（`report` 为假设的项目类型；表与查询按项目实际 schema 改写）：

```tsx
// apps/web/src/features/share-cards/share-cards.project.ts
import { reportShare } from '@saas/db/schema' // 项目自己的分享表（示例）
import { and, eq, isNull } from 'drizzle-orm'
import { shareCardLayout } from './layout.tsx'
import { registerShareCard } from './registry.ts'

interface ReportShareData {
  title: string
  summary: string
}

export function registerProjectShareCards() {
  registerShareCard<ReportShareData>({
    type: 'report', // 小写字母、数字与短横线，用于路由
    version: 1, // 改版式时递增，卡片地址随之变化
    // ttlDays: 30,          // 可选：本类型的默认有效天数；null 表示永不过期
    // sharePage: false,     // 可选：关闭通用分享页，项目自建页面
    // tokenPattern: /^.../, // 可选：默认 /^[A-Za-z0-9_-]{22,64}$/
    async resolve(token, { db }) {
      // 按令牌查找是跨空间的公开查询；令牌本身即访问凭据，只返回未撤销的记录。
      const [share] = await db
        .select()
        .from(reportShare)
        .where(and(eq(reportShare.token, token), isNull(reportShare.revokedAt)))
        .limit(1)
      if (!share) return null
      return {
        workspaceId: share.workspaceId,
        sharedAt: share.createdAt,
        expiresAt: share.expiresAt, // 省略字段 = sharedAt + ttlDays；null = 永不过期
        data: { title: share.title, summary: share.summary },
      }
    },
    // 只对卡片上展示的字段做摘要：展示内容一变，卡片地址就变
    digest: (data) => JSON.stringify([data.title, data.summary]),
    render: (data, theme) => shareCardLayout({ title: data.title, summary: data.summary }, theme),
    alt: (data) => data.title,
    page: (data) => ({ title: data.title, description: data.summary }),
  })
}
```

要点：

- `share-cards.project.ts` 从 `./registry.ts` 导入 `registerShareCard`，不要从 `./index.ts` 导入（`index.ts` 会调用本文件，形成循环）。
- 同一类型名重复注册在启动时抛错；开发服务器热更新时以新定义替换旧定义。
- `digest` 返回值只取前 8 位进入地址（`v=<version>-<digest8>`），应是对展示字段的稳定摘要；
  它不承担访问控制，访问始终由随机令牌与 `resolve` 决定。
- `resolve` 每次缓存未命中、每次打开分享页都会被调用，应只查必要的一两行；数据库不可达时抛错，卡片返回 500。
- 资源被删除、所属空间已软删除或项目判定不可再分享时，`resolve` 返回 `null`。
  团队空间软删除后的 30 天保留期内模板不会清理卡片（见第 3 节），所以项目的 `resolve` 应排除已删除空间的记录。

## 2. 项目分享表的建议结构

模板不提供分享表。建议字段（以 Drizzle 为例，放在项目的领域 schema 文件中，迁移按项目流程生成）：

```ts
export const reportShare = pgTable(
  'report_share',
  {
    id: uuid('id').primaryKey().$defaultFn(newId),
    workspaceId: uuid('workspace_id').notNull().references(() => organization.id, { onDelete: 'restrict' }),
    reportId: uuid('report_id').notNull(), // 资源 ID 只存在表里，不进入令牌或 URL
    token: text('token').notNull(), // createShareToken()：32 字节随机数 base64url，43 个字符
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }), // 可空：交给类型默认值或永不过期，见第 4 节
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps, // 所在 schema 文件已有的 createdAt / updatedAt 常量
  },
  (t) => [
    uniqueIndex('report_share_token_uidx').on(t.token),
    // 同一资源最多一条有效分享；撤销后可以重新分享（新令牌）
    uniqueIndex('report_share_active_uidx').on(t.reportId).where(sql`${t.revokedAt} is null`),
  ],
)
```

- **令牌不含资源 ID**：令牌只能用 `createShareToken()` 生成，不能编码或推出资源、用户或空间 ID；
  也不要用签名 URL（无法单条撤销）。
- **令牌不复用**：撤销后重新分享必须生成新令牌。撤销墓碑永不删除，旧令牌复用后会永远 404。
- **部分唯一索引**（`where revoked_at is null`）保证同一资源只有一条有效分享，重复点击「分享」时返回已有令牌。
- 写操作（创建、撤销）是普通的空间内写入，按 `scoped(db, workspaceId)` 与成员权限处理；
  只有 `resolve` 按令牌跨空间查询。
- 上例在 `resolve` 中返回 `expiresAt: share.expiresAt`：列为 `null` 时表示永不过期，而不是类型默认值。
  希望 `null` 列沿用默认天数时，改为 `...(share.expiresAt ? { expiresAt: share.expiresAt } : {})`。

## 3. 撤销、删除资源与删空间

失效函数 `invalidateShareCard({ type, token, workspaceId })`
（`apps/web/src/features/share-cards/invalidate.server.ts`）依次：

1. 写 KV 撤销标记 `share-revoked:<type>:<token>`，TTL 1 天；
2. 写 R2 撤销墓碑 `share-cards/revoked/<type>/<token>`（空对象，**永不删除**）；
3. 删除 R2 图片前缀 `share-cards/img/<type>/<token>/` 与空间索引 `share-cards/ws/<workspaceId>/<type>/<token>`。

**项目必须调用它的时机**：

- 用户撤销分享：先在分享表写 `revoked_at`，再调用失效函数。
- 删除被分享的资源：删除前或同一流程中，对该资源的每条有效分享调用失效函数。
- 修改资源**不必**调用：展示数据变化后摘要变化，分享页引用新的卡片地址，旧地址 302 到新地址。

`invalidateShareCard` 使用当前 web 请求的运行时（Server Function 或 HTTP 路由内调用）。
在 jobs 或其他无 web 请求的场景，用 `@saas/storage` 的 `createShareCardInvalidator(objects, kv)` 构造同样的函数。
未装配对象存储时它抛出 503（`CAPABILITY_UNAVAILABLE`），撤销流程应把它当失败处理并重试。

**删空间**由模板清理卡片：

- 删号时的个人空间：删号请求内按空间索引最多失效 20 张，其余由 jobs 每日 03:00 UTC 的清理继续；
- 团队空间：软删除后保留 30 天，保留期结束时 jobs 的清理按 `share-cards/ws/<workspaceId>/` 列出索引并逐个失效。

**项目自己的分享表由项目删除**：在项目的删空间 / 删号清理步骤（`registerDeletionStep` 或项目的清理任务）中
删除或匿名化该空间的分享记录；模板不知道项目表的存在。

## 4. 到期规则

- `resolve` 返回的 `expiresAt` 优先：一个 `Date` 表示该时间到期，`null` 表示永不过期。
- 省略 `expiresAt` 时，到期时间 = `sharedAt` + 类型的 `ttlDays` 天（按 UTC 毫秒计算整天）。
- `ttlDays` 省略时取 `template.config.ts` 的 `shareCards.defaultTtlDays`（默认 **90**）；
  设为 `null` 表示该类型默认永不过期。必须是正整数或 `null`，否则注册时报错。
  - 整体修改：`template.config.ts` 中 `shareCards: { defaultTtlDays: 30 }`；
  - 按类型修改：`registerShareCard({ ..., ttlDays: 30 })`。
- 到期后卡片地址与分享页都返回 404，包括对象存储已有图片的情况（图片元数据记录到期时间，命中时检查并删除）。
- 剩余有效期不足 1 秒视为已到期。

## 5. 通用分享页与自建页面（二选一）

**通用分享页** `/s/<type>/<token>`（默认开启）：显示卡片图片、`page(data)` 的标题与描述（可选 `label`）、
分享日期与到期日期、前往首页 / 注册的入口；无效、到期、撤销或格式不符时显示 404 页（到期有单独文案）。
文案在 `apps/web/messages/<locale>/share-page.json`。响应头：

- `Cache-Control: public, s-maxage=<min(300, 剩余秒数)>`：撤销后边缘最多 5 分钟仍返回旧页面；
- `X-Robots-Tag: noindex`，页面 `<meta name="robots" content="noindex">`；
- 限流时直接返回 429 与 `Retry-After: 60`。

**自建页面**：注册时设 `sharePage: false`，`/s/<type>/<token>` 对该类型返回 404，卡片地址不受影响。
在项目页面的服务端取元数据：

```ts
// 项目路由的 *.functions.ts：服务端模块在 handler 内按需加载，不进入客户端包
import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const getReportShareMeta = createServerFn({ method: 'GET' })
  .inputValidator(z.object({ token: z.string() }))
  .handler(async ({ data }) => {
    const { shareCardMeta } = await import('../share-cards/meta.server.ts')
    const meta = await shareCardMeta('report', data.token, {
      pageUrl: `https://example.com/r/${data.token}`, // 可选：作为 og:url
    })
    if (!meta) throw notFound()
    return meta
  })
```

`shareCardMeta(type, token, options?)` 与通用分享页执行相同的撤销、格式、限流、解析与到期检查，
无效时返回 `null`，超过限流时抛出 429 的 AppError。返回值的 `meta` 数组可直接并入路由 `head`，包含
`robots: noindex`、`og:title/description/image`（`APP_URL` 下的绝对地址，带 `v`）、`og:image:width/height/alt`、
`twitter:card=summary_large_image` 与 `twitter:image`；页面标题由项目决定。

`/share-card/` 与 `/s/` 在 `robots.txt` 中放行（部分平台的抓取器遵守 robots），不进入站点地图与 `llms.txt`，
是否收录由 `noindex` 决定。

## 6. 版式与主题

- **版式**：`render(data, theme)` 返回 satori 支持的 JSX（只用 flex 布局子集，不支持 grid、`line-clamp`、远程图片）。
  优先复用 `shareCardLayout({ title, summary?, badge?, meta? }, theme)`，它已按设计稿处理品牌行、截断与站点域名；
  需要新版式时在项目文件中实现，并先经 `ui-design` 取得设计稿。
- **只用主题值**：颜色、圆角与字号取 `theme`（`ShareCardTheme`：background、foreground、muted、mutedForeground、
  secondary、primary、primaryText、primaryForeground、brandAccent、border、radius、fontSize），版式文件不写颜色字面量，
  `.tsx` 版式文件仍受 `pnpm check:ui` 检查。
- **截断**：不要依赖 CSS 截断。用 `truncateText(text, { maxWidth, lineWidth, lines })` 在渲染前按字宽加权截断
  （CJK 记 1，拉丁小写约 0.6、大写约 0.72），超长时以省略号结尾；`SHARE_CARD_TEXT_LIMITS` 是默认版式的上限。
- **含 CJK 的标题整行 400 字重**：Noto Sans SC 只有常规体，含需要回退字体的字符时整行用 400；纯拉丁标题用 Inter 600。
  中文标题靠字号区分层级，不要依赖加粗。
- **主题覆盖**：模板基线在 `packages/ui/src/share-card-theme.ts`（与 `tokens.css` 基线一致，有单测保证）。
  项目品牌值写在项目自有文件 `apps/web/src/features/share-cards/share-cards.theme.ts`：

  ```ts
  export const projectShareCardTheme: Partial<ShareCardTheme> = {
    brandAccent: '#0f766e', // 与 styles/brand.css 的 --fluid-accent 对应
  }
  ```

  覆盖对浅色与深色同时生效，取值与 `apps/web/src/styles/brand.css` 保持一致（服务端渲染无法读取 CSS 变量）。
  按约定在 `scripts/check-ui.allow.local.json` 为该文件登记例外，原因写「分享卡片在服务端渲染，无法读取 CSS 变量」：

  ```json
  {
    "exceptions": {
      "apps/web/src/features/share-cards/share-cards.theme.ts": [
        { "rule": "color-literal", "reason": "分享卡片在服务端渲染，无法读取 CSS 变量" }
      ]
    }
  }
  ```

  当前 `check:ui` 只扫描 `.tsx`，该 `.ts` 文件不会报错；登记是为了扫描范围扩大后不被拦截，并留下原因。
- 卡片固定用浅色主题渲染；`/dev/ui` 预览可切换深色。

## 7. 字体与文字支持

字体在 `apps/web/public/fonts/share-card/`，作为静态资源发布（`/fonts/share-card/*` 不经 Worker，长期缓存、`noindex`）：

- 西文：Inter Latin 400/600 woff（`.woff.bin`，约 61 KB），随渲染器打包；
- CJK：Noto Sans SC Regular 完整简体子集 OTF（约 8.3 MB），**只在文本含 Inter Latin 子集之外的字符时**加载，
  Workers 经 `ASSETS.fetch` 读取、Node 读本地文件，同一实例内只解析一次，不进 Worker 包。

文字覆盖范围（分享卡片与构建期分享图相同，实现见 `features/share-cards/text.ts`）：

- 支持：英文与西欧拉丁字母、中日文（简体子集）、基本西里尔与基本希腊字母（部分覆盖）、拼音声调字母；
- 两种字体都缺字的带附加符号字母降级为基本字母（如 `Ą`→`A`、`ά`→`α`）；
- emoji（含 ZWJ 序列、变体选择符、肤色修饰与旗帜）在渲染前去除；
- **不支持**：谚文（韩文）、泰文、老挝文、高棉文、缅甸文，以及简体子集之外的扩展西里尔字母（如乌克兰文 `і`、`ї`），
  这些字符显示为方框；需要时由项目换用含对应字形的字体。

## 8. 缓存语义

请求处理顺序：注册与令牌格式 → KV 撤销标记 → Cache API（自托管跳过）→ 对象存储图片
→ 限流 → `resolve` → 到期 → 摘要比对（`v` 不一致时 302 到当前地址）→ 渲染 → 复查撤销墓碑 → 写入对象存储与 Cache API。

- **只渲染一次**：同一令牌、版式版本与展示数据的图片写入 R2 `share-cards/img/<type>/<token>/<v>.png`，
  并写空间索引 `share-cards/ws/<workspaceId>/<type>/<token>`。命中 Cache API 或 R2 时**不调用 `resolve`、不查库**。
- **R2 永久存储**：图片不设生命周期，直到失效、到期命中时删除或删空间清理。不要给 `share-cards/` 前缀配置自动过期规则：
  索引与墓碑被自动删除会导致删空间清理漏删、已撤销令牌重新可用。
- **浏览器与公共缓存最长 1 天**，且不超过剩余有效期：`Cache-Control: public, max-age=N, s-maxage=N`，
  `N = min(86400, 剩余秒数)`；不使用 `immutable`。另带 `X-Robots-Tag: noindex` 与 `X-Content-Type-Options: nosniff`。
- **撤销标记**：KV 标记 1 天（与公共缓存上限相同，标记过期时 Cache API 条目也已过期）；R2 撤销墓碑永不删除，
  保证渲染与撤销并发时不留下孤儿图片。KV 读取有约 60 秒缓存，撤销后同一数据中心最多约 1 分钟内仍可能返回旧图。
- **撤销对已被社交平台抓取的卡片无效**：平台会自行缓存预览图与页面摘要，模板无法清除；
  浏览器或中间代理已缓存的副本最长 1 天。需要立即生效的场景请在产品文案中说明。
- 404 / 429 / 500 / 503 响应 `Cache-Control: no-store`，正文不含资源信息或错误详情。

## 9. 防滥用

- **限流** `RL_SHARE_CARD`：按来源 IP，每分钟 30 次。只在卡片缓存未命中（需要调用 `resolve`）、打开分享页、
  调用 `shareCardMeta` 与 `/dev/ui` 预览图时消耗配额；超出返回 429 与 `Retry-After: 60`。
  Cloudflare 原生限流绑定在线上目前不生效（已知问题），下面两道兜底始终有效。
- **令牌格式**：不符合类型 `tokenPattern`（或超过 256 个字符）的请求直接 404，不读 KV、不调用 `resolve`。
- **渲染并发上限**：同一实例同时最多渲染 2 张，超出返回 503 与 `Retry-After: 5`。
- **没有渲染超时**：单张渲染在实测中为几十到一百多毫秒，由平台的 CPU 时间限制兜底；版式不要放入无上限的文本，用截断控制长度。

## 10. 自托管（Node）差异

- 没有 Cache API：卡片由对象存储（S3 兼容，`S3_*` 配置）与 HTTP 缓存头承担，前置 CDN 按响应头缓存。
- 对象存储键、元数据与墓碑与 R2 相同（元数据键为小写短横线，兼容 S3 的小写化）。
- KV 撤销标记与限流由 Node 缓存适配器（Redis）承担，`shareCard` 策略默认每分钟 30 次，可经 `policies.shareCard` 调整。
- 渲染器使用 `cf-workers-og` 的 Node 入口，字体从 `public/fonts/share-card/` 读取；静态字体响应补长期缓存与 `noindex`。
- 未配置对象存储时：卡片仍可渲染，但每次未命中都会重新渲染；`invalidateShareCard` 返回 503，删空间清理跳过卡片。

## 11. 部署要求

- **Workers 付费版**：渲染器（satori 与 resvg WASM、西文字体）使 web Worker 整包 gzip 约 3.5 MiB，
  超过免费版 3 MiB 上限；付费版上限 10 MB。部署前用下文的 dry-run 确认体积。
- **`RL_SHARE_CARD` 限流绑定**：在 `apps/web/wrangler.jsonc` 顶层、`env.staging` 与 `env.production` 各声明一次，
  `namespace_id` 在同一账号内不得与其他限流绑定重复；`pnpm check`（`check-wrangler-envs`）会检查。
- **静态资源直出**：`assets.run_worker_first` 排除 `/fonts/share-card/*`，构建产物 `_headers` 为该路径配置长期缓存与 `noindex`。
- **R2**：使用现有 `FILES` 桶的 `share-cards/` 前缀，不设生命周期自动过期。
- 运行时没有数据库迁移；回滚只需回退代码，`share-cards/` 下的对象可保留或手动删除。

## 12. 示例类型 `sample` 与预览

- `sample` 只在测试（测试中显式注册）、开发以及开启 `UI_PREVIEW=true` 的环境（staging）中登记；生产不设 `UI_PREVIEW`，
  从不登记。项目注册了同名类型时不覆盖。
- `/dev/ui` 的「分享卡片」一节用真实渲染器展示中文、英文、长标题与默认分享图，浅色 / 深色各一张，
  图片来自 `/api/dev/share-card-preview?variant=<zh|en|long|default>&mode=<light|dark>`（同受 `UI_PREVIEW` 开关与限流约束）。
- `POST /api/dev/share-cards` 是 e2e 与 staging 验收夹具，需要**平台管理员会话**，否则 404：
  - `{"action":"create"}`：用固定示例数据登记一条新的 `sample` 分享，返回 `{ token, page }`。
    记录存 KV（`share-sample:<token>`，TTL 1 天），staging 多个隔离区之间也能解析；
  - `{"action":"invalidate","token":"<令牌>"}`：对 `sample` 令牌调用失效函数，与项目撤销分享相同。

本地手动走一遍（先 `pnpm dev`，端口见 `.env.worktree` 的 `WEB_PORT`，用平台管理员账号登录后从浏览器开发者工具复制 Cookie）：

```sh
BASE=http://localhost:$(grep '^WEB_PORT=' .env.worktree | cut -d= -f2)
COOKIE='<平台管理员会话 Cookie>'
TOKEN=$(curl -s -X POST "$BASE/api/dev/share-cards" -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d '{"action":"create"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -sI "$BASE/s/sample/$TOKEN"                       # 200，x-robots-tag: noindex
curl -sIL "$BASE/share-card/sample/$TOKEN.png?v=0"     # 302 到当前 v，随后 200 image/png
curl -s -X POST "$BASE/api/dev/share-cards" -H "cookie: $COOKIE" -H 'content-type: application/json' \
  -d "{\"action\":\"invalidate\",\"token\":\"$TOKEN\"}"
curl -sI "$BASE/s/sample/$TOKEN"                       # 404
```

## 13. 验证

在项目根执行（生成的副本把 `@saas/*` 换成实际包名）：

```sh
pnpm --filter @saas/web exec vitest run --project unit src/features/share-cards src/node/share-card-renderer.test.tsx
pnpm --filter @saas/storage test
pnpm --filter @saas/web test:e2e share-cards.spec.ts
pnpm --filter @saas/web build        # 含首页包检查：首页服务端与客户端闭包中不得出现渲染器、satori、resvg 与字体
cd apps/web && pnpm exec wrangler deploy --dry-run --outdir /tmp/share-card-worker   # 查看 Total Upload 的 gzip 体积
```

`pnpm --filter @saas/storage test` 的对象存储集成用例使用本地 R2 / KV 模拟，不需要外部凭据；
e2e 需要本地 Postgres 与已执行的迁移（`pnpm --filter @saas/db db:migrate`）。
上线后用社交平台的卡片调试工具（如 X Card Validator、Facebook Sharing Debugger）抓取一次分享页，确认预览图显示。
