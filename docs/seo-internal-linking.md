# 站内链接规范

公开页面之间怎么互相链接：页面声明层级与主词，模板生成固定的内链区块，构建后对实际渲染出的链接图做检查。
新增公开页面（尤其是批量生成的程序化页面）时以本文为准。设计依据见 OpenSpec change `seo-internal-linking`
的 design.md（决策 1–7），检查规则的实现在 `apps/web/scripts/check-links-graph.mjs`。

## 1. 页面字段

公开页面清单 `publicPages()`（`apps/web/src/features/seo/pages.ts`）的每一项是一个 `SeoPage`
（`apps/web/src/features/seo/metadata.ts`）。地址类字段都写**不带语言前缀**的站内 path，按该页的 `locale` 解析。

| 字段 | 必填 | 含义 |
|---|---|---|
| `path` | 是 | 页面地址；同一语言内唯一 |
| `titleMain` | 可索引页必填 | 主词：面包屑与内链区块的锚文本，取频道名或页面名，不是 SEO 标题 |
| `parent` | 除首页外必填 | 上级页面，必须存在且可索引；面包屑与 BreadcrumbList 沿它生成，不能成环 |
| `anchorShort` | 否 | 锚文本的一个短变体（如首页「Home」、文档「Docs」），面包屑上级优先使用 |
| `group` | 否 | 同级分组的地址（通常是分组的列表页）；同组页面互为同级，显示同组区块 |
| `related` | 否 | 相关页地址列表，目标必须存在且可索引；显示相关区块 |
| `indexable` | 否 | 默认 `true`；`false` 时 noindex、不进站点地图，也不能作为 parent／group／related 的目标 |
| `priority` | 否 | `'money'` 表示钱页，检查其站内入链数 |
| `sourceLocale` | 自动 | 内容的真实语言；与 `locale` 不同即回退页：canonical 指向原语言，不进站点地图（多站点项目中原语言在另一站点时例外，见 §7）。只在 `i18n.untranslated: 'fallback'` 时允许，默认 `'hide'` 下构建失败 |
| `alternates` | 否 | 各语言版本的地址（语言 → 不带前缀的 path），用于本地化 slug；hreflang 与语言切换器使用这些地址。键必须是已配置语言，每个版本都要在清单中并声明同一组地址，同路径的其他语言页也要声明，否则构建失败 |

各来源怎么填：

- **内容集合**（博客、文档、答案页、法律页）：`parent` 默认取集合列表页（`/blog`、`/docs`、`/guides`，法律页为首页），
  `titleMain` 取 `title`。frontmatter 可写 `parent`、`anchor_short`、`related` 覆盖或补充：

  ```yaml
  ---
  title: 欢迎使用本模板
  related: [/blog/writing-posts]
  ---
  ```

- **模板静态页**（首页、定价、博客、指南、文档、通讯、候补名单）：在 `staticPage()` 中声明，上级都是首页。
- **hub 分页**：博客列表、标签页的第 2 页起由 `hubPages()` 自动生成，上级是 hub 首页。
- **项目自有页面**：在 `pages.project.ts` 注册，见 §5。

构建时 `features/seo/linking.ts` 对清单做静态校验：地址重复、缺 `titleMain`／`parent`、目标不存在或不可索引、
parent 成环时构建失败并给出页面地址；主词重复只警告。

## 2. 模板区块

组件在 `@saas/ui`（`Breadcrumb`、`SeriesNav`、`LinkCardGrid`、`LinkList`、`Pagination`），页面接入在
`apps/web/src/features/marketing/page-links.tsx`，设计稿见原型索引「公开页内链区块」一行。
区块数据由 server function 按公开页面清单计算（`features/seo/page-links.ts`、`pages.server.ts` 的 `getPageLinks`），
清单不进入客户端包。

| 区块 | 位置 | 出现条件 | 锚文本 |
|---|---|---|---|
| 面包屑（`data-link-zone="nav"`） | 正文上方 | 除首页外的公开页 | 上级 `anchorShort` 或 `titleMain`；当前页不是链接 |
| 系列上一篇／下一篇（`series`） | 正文之后 | 页面的 `group` 在 `seo.linking.series` 中声明 | 目标 `titleMain` |
| 相关（`related`） | 系列之后 | 页面声明了 `related` | 目标 `titleMain`，附目标描述 |
| 同组（`siblings`，带 `data-link-group`） | 相关之后 | 页面声明了 `group` | 目标 `titleMain`；「查看全部」为组页主词 |
| hub 分页 | 列表之后 | 下级超过 `hubPageSize` | 页码与「上一页／下一页」 |

- 区块顺序固定为：正文 → 系列 → 相关 → 同组 → 页脚；未声明的区块不渲染，不出现空标题。
- 页面同时输出与面包屑一致的 BreadcrumbList JSON-LD（上级为当前语言的绝对地址，当前页只写名称）。
- 同组区块最多列出 `groupLinksMax` 个，从本页之后轮转选取，使组内每一页都有入链；系列已链接的上一篇／下一篇不重复列出。
- hub 分页地址为 `<hub>/page/<n>`，第 1 页即 hub 本身（`/blog/page/1` 301 到 `/blog`），超出页数返回 404；
  分页页进入站点地图，第 2 页起标题与 H1 带页码。
- 模板区块的锚文本只取 `titleMain` 或 `anchorShort`，不接受自由文本。正文与其他组件里的站内链接也不能用禁用词（§3）；
  例如首页产品矩阵的次级链接写 `secondaryLabel`（目标主词或具体说明），省略时为产品标题。

## 3. 链接图检查

`apps/web/scripts/check-links.mjs` 启动 `vite preview` 运行生产构建产物，以站点地图全部地址加各语言首页为种子按 HTTP 抓取，
只解析 `<a href>`（按钮、`onclick`、脚本跳转不计入）。站点地图就是可索引集合；回退页、带查询参数的地址、应用区与 noindex 页
不是检查对象，也不能成为正文链接的目标（回退页除外：它的 canonical 指向可索引页）。

区域标记 `data-link-zone`：

| 值 | 用于 | 检查中的含义 |
|---|---|---|
| `nav` | 页头、页脚、面包屑、语言切换器 | 导航层：可链接登录、账户等不可索引页；页头/页脚链接数分别计数；姊妹站链接不得出现 |
| `action` | 注册、进入应用的转化按钮，悬浮 Ask AI | 转化入口：可链接不可索引页，不计入正文链接数 |
| `series`、`related`、`siblings` | 模板区块 | 区块：链接到不可索引页失败 |
| 未标记 | 正文 | 链接到不可索引页失败；计入正文链接数 |

标记可以写在链接自身或祖先元素上，链接自身的优先。衍生项目改布局时保留这些标记；页面完全没有 `nav` 区域时会单独警告。

规则分两级：

| 级别 | 规则 | 说明 |
|---|---|---|
| 失败 | `orphan` | 可索引页没有站内入链（站点地图不计） |
| 失败 | `dead-link` | 站内链接目标返回 4xx/5xx，或可索引页自身不可访问 |
| 失败 | `link-to-noindex` | 正文或区块链接到不可索引页（`nav`、`action` 除外） |
| 失败 | `banned-anchor` | 锚文本是禁用词（默认「点击这里」「了解更多」「查看详情」「here」「click here」「read more」「learn more」，忽略大小写与首尾箭头） |
| 失败 | `image-link-alt` | 只含图片的链接缺少非空 `alt` |
| 失败 | `sister-nofollow`、`sister-in-nav`、`sister-mirror` | 姊妹站链接缺 `rel="nofollow"`、出现在导航层、指向相同路径的镜像页 |
| 失败 | `h1-count` | 可索引页的 `<h1>` 不是恰好一个 |
| 警告 | `h1-duplicate` | 同一语言中两页 H1 相同 |
| 警告 | `header-links` | 页头频道链接数不在 `headerLinksMin`–`headerLinksMax` |
| 警告 | `group-body-links` | 声明了 group 的详情页正文链接少于 `groupBodyLinksMin` |
| 警告 | `depth`、`unreachable` | 从首页的最短点击深度超过 `maxDepth`；有入链但从首页无法到达 |
| 警告 | `money-inlinks` | 钱页站内入链少于 `moneyInlinksMin` |
| 警告 | `footer-links` | 页脚链接数超过 `footerLinksMax` |
| 警告 | `no-nav-zone` | 页面没有 `nav` 区域 |

## 4. 配置

`template.config.ts` 的 `seo.linking`（类型、默认值与解析在 `packages/config` 的 `resolveSeoLinking`，检查脚本读同一份）：

```ts
seo: {
  linking: {
    mode: 'enforce', // 'report'（默认）只报告；'enforce' 有失败项时退出码为 1
    thresholds: { maxDepth: 4 }, // 逐项覆盖，未写的取默认值
    bannedAnchors: ['详情'], // 只能增补，内置词不能移除
    moneyPages: ['/pricing'], // 也可在 SeoPage 上写 priority: 'money'
    sisterDomains: ['west.example.com'], // 只写主机名
    series: [{ group: '/templates/writing', orderBy: 'declared' }], // declared | date | titleMain
    hubPageSize: 100, // hub 单页最多列出的下级数
    groupLinksMax: 5, // 同组区块最多列出的页面数，建议 3–5
    sites: [], // 多站点项目按站点分组语言，默认为空（单站点），见 §7
  },
},
```

默认阈值：`headerLinksMin` 3、`headerLinksMax` 7、`groupBodyLinksMin` 2、`maxDepth` 3、`moneyInlinksMin` 3、`footerLinksMax` 10。
配置写错（未知 mode、负数阈值、带查询参数的地址、带协议的域名、重复的系列、站点分组中重复或未启用的语言）时构建与检查都直接报错。

## 5. 注册项目自有页面

项目新增的公开页面（程序化详情页、分类 hub 等）在 `apps/web/src/features/seo/pages.project.ts` 的 `projectPages()` 返回，
与模板清单合并后进入站点地图、分享图、静态校验与区块计算。该文件首次交付后归项目所有，template-sync 不覆盖。

```ts
export function projectPages({ locale }: { locale: string; defaultLocale: string; now: Date; config: TemplateConfig }) {
  const hub = { path: '/templates', locale, title: '模板库', description: '…', titleMain: '模板库', parent: '/' }
  const categories = categoryList.map((category) => ({
    path: `/templates/${category.slug}`, locale, title: category.title[locale], description: category.summary[locale],
    titleMain: category.name[locale], parent: '/templates',
  }))
  const items = templates.map((item) => ({
    path: `/templates/${item.slug}`, locale, title: item.title[locale], description: item.summary[locale],
    titleMain: item.name[locale], parent: `/templates/${item.category}`, group: `/templates/${item.category}`,
  }))
  return [hub, ...categories, ...items]
}
```

步骤：

1. 为每个页面写 `titleMain` 与 `parent`；hub 与分类页本身也要返回条目。缺译文的语言默认不返回条目；
   项目设置 `i18n.untranslated: 'fallback'` 时才写 `sourceLocale: <原语言>` 的回退条目。各语言 slug 不同时写 `alternates`。
2. 页面由 `apps/web/src/routes/` 下的路由渲染：`head` 用 `pageHead()`，并输出 `breadcrumbListData()`；
   页面数据由 server function 返回 `getPageLinks(path, locale)`，组件用 `PageBreadcrumb` 与 `PageLinkSections` 渲染区块。
3. hub 页链接到全部下级；下级超过 `hubPageSize` 时用 `hubPages()` 生成分页条目、`hubSlice()` 切分列表、`HubPagination` 渲染分页。
4. 有阅读顺序的分组在 `seo.linking.series` 中声明，详情页即显示上一篇／下一篇。
5. 构建后运行检查（§6），按报告修正孤岛、死链与禁用锚文本。

## 6. 运行与 report／enforce 切换

```sh
pnpm --filter @saas/web build
pnpm --filter @saas/web check:links                 # 模式取 seo.linking.mode
pnpm --filter @saas/web check:links --mode report   # 临时只看报告
pnpm --filter @saas/web check:links --json test-results/evidence/links.json --limit 50
```

- 报告列出页面数、链接数、各规则命中数与每条规则最多 `--limit` 条明细（默认 20），以及耗时。
- `--base-url <地址>` 检查已在运行的服务，不启动 preview。
- CI 在 `build` job 的 `pnpm build` 之后运行（`docs/ci.md` §3），复用同一份生产构建产物，不需要数据库。
- 模板自身为 `enforce`。衍生项目未配置时为 `report`：同步后构建不失败，先按报告补 `pages.project.ts` 声明、修正孤岛与死链，
  报告的失败项清零后在 `template.config.ts` 设 `mode: 'enforce'`。
- 语言首页按路由的实际前缀抓取（取 Paraglide 编译出的运行时 `localizeUrl`）：项目把 URL 前缀改成与语言 id 不同的写法
  （如 `zh-Hant` → `/zh-hant`）时不会误报死链。运行时缺失时退回 `/<语言 id>` 并打印提示。
- Turbo 缓存命中恢复的产物没有 `dist/server/.dev.vars` 时，检查按 `.dev.vars.example` 临时补一份（结束后删除）：
  示例中值为空的 `*_SECRET`／`*_TOKEN` 随机生成，本地存在 `apps/web/.dev.vars` 时叠加其中的值。项目新增的
  Worker 启动必填变量写进 `.dev.vars.example`（密钥写空值）即可，不需要改检查脚本；该文件只写在已忽略的 dist 中。
  项目插件添加或覆盖变量时，使用 `apps/web/scripts/prerender-env.ts` 导出的 `mergeDevVars(base, overrides)`。
  自动填值后键已经存在，直接追加 `KEY=value` 会产生重复键。合并时同一键以最后一次赋值为准，覆盖项优先于基础内容。

## 7. 多站点

同一部署按 Host 服务多个站点、各站点使用不同 origin 的项目，在 `seo.linking.sites` 中按站点分组语言（模板默认为空，
全部语言属于同一站点，以下行为都不生效）：

```ts
seo: {
  linking: {
    sites: [
      { locales: ['en'], previewHost: 'localhost' },
      { locales: ['zh-Hant', 'ja'], previewHost: 'second.localhost' },
    ],
  },
},
```

- `locales`：该站点服务的语言，一种语言只能属于一个站点；未列入任何分组的语言同属一个隐含站点。
- **回退页 canonical 不跨站**：`sourceLocale` 与页面语言属于同一站点时才按回退页处理（canonical 指向原语言、不进站点地图）。
  原语言在另一站点时按普通页面处理——canonical 指向本页、进入本站站点地图，`articleData` 的 `inLanguage` 仍标注内容的真实语言。
  判断函数是 `metadata.ts` 的 `fallbackSourceLocale()`／`sameSiteLocales()`，项目自有代码判断回退页时也用它们。
- **链接图分站检查**：声明了 `previewHost` 的站点各自成图。检查脚本以 `<previewHost>:<preview 端口>` 作 Host 请求头访问
  preview（等价于 `curl --resolve`），不依赖 DNS 解析 `*.localhost`；种子为该站点的站点地图与其语言首页，
  指向其他站点主机的链接不跟随、不并入本图（需要约束时把正式域名写进 `sisterDomains`）。报告与 `--json` 中的明细
  以主机名开头（如 `second.localhost/zh-hant`）。总览保留整次检查的统计，并按主机名列出各站点的页面数、链接数、
  最大点击深度和各规则命中数。JSON 对应的字段为 `sites`。没有任何站点声明 `previewHost` 时仍按单站点检查整个 preview。
- `previewHost` 是 preview 中区分站点用的主机名（不含协议与端口），由项目的 Host 路由决定；生产域名不写在这里。
