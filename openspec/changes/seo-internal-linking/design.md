## Context

- 公开页面清单 `publicPages()`（`apps/web/src/features/seo/pages.ts`）产出 `SeoPage[]`，站点地图、构建期 OG 图、`llms.txt` 都读取它。`SeoPage` 目前只有 `path / title / description / locale / cover / date`。
- 预渲染以各语言首页为入口、`crawlLinks: true` 爬取（`apps/web/scripts/vite-shared.ts`），范围限定为 `/`、`/blog`、`/legal`、`/docs`、`/guides`（`features/marketing/prerender.ts`）。`/pricing`、`/newsletter`、`/waitlist` 由 SSR 输出，不在 `dist/client` 中。
- 内容集合（`apps/web/content-collections.ts`）用 zod 校验 frontmatter，缺字段时构建失败，答案页已采用这种约定。
- 回退：`localizedEntries()` 在缺少译文时用默认语言条目填充；`pageHead()` 的 canonical 总是当前路径，`alternateLinks()` 总是列出全部语言。站点地图因此包含回退页。
- 页头、页脚由 `site-header.tsx`、`site-footer.tsx` 渲染，页脚目前约 8 个链接。没有面包屑组件。
- 模板不放领域规则：模板只提供机制与博客、文档、答案页、法律页上的默认接入，牌义、数字等 hub 结构由项目声明。

## Goals / Non-Goals

**Goals:**
- 内容作者和项目开发者不需要手写大部分 `parent`：内容集合按目录推导，静态页在模板内声明，只有项目自有的程序化页需要显式声明。
- 检查基于真实渲染输出，声明与实际链接不一致时以实际为准。
- 衍生项目同步后构建不立刻失败，可以先看报告再收紧。

**Non-Goals:**
- 不做运行时内链推荐或自动在正文中插链。
- 不统计锚文本占比（已取消）。
- 不检查跨站点的链接图；姊妹站只检查本站发出的链接：nofollow、不在导航层、不指向同路径镜像。

## Decisions

### 1. 字段挂在 `SeoPage` 上，各来源负责填写

`SeoPage` 增加 `parent`、`titleMain`、`anchorShort`、`group`、`related`、`indexable`、`priority`、`sourceLocale`（回退页记录原语言）。

- 内容集合：`parent` 默认取集合的列表页（博客文章 → `/blog`，文档 → `/docs`，答案页 → `/guides`，法律页 → 首页），`titleMain` 默认取 `title`；frontmatter 可覆盖并新增 `anchor_short`、`related`。
- 模板静态页：在 `staticPage()` 中声明。
- 项目自有页面：通过项目所有的 `pages.project.ts` 注册函数返回 `SeoPage[]`，与模板清单合并。该文件首次复制后归项目所有，同步不覆盖。

备选：单独维护一张站点结构表。否决：会与 `publicPages` 漂移，站点地图和检查看到的页面集合不一致。

### 2. 检查对象：本地 preview 服务的爬取结果，而不是只读 `dist`

检查脚本启动 `vite preview`（与 e2e-smoke 相同的启动方式），以站点地图中的全部地址加各语言首页为种子，按 HTTP 抓取并解析 `<a href>`。站点地图就是可索引集合；钱页、sister 域名等从模板配置读取。这样检查脚本只依赖构建产物与配置，不依赖 `publicPages()` 的内部实现，可与元数据改动并行开发。

备选：只读 `dist/client` 的预渲染 HTML。否决：定价、通讯、候补名单不在其中，会把它们误报为死链或漏检它们的出链。

备选：在 TanStack 预渲染爬取时顺带收集。否决：预渲染只覆盖部分前缀，且与构建实现耦合太紧。

### 3. 用区域标记区分导航层与正文

页头、页脚、面包屑、语言切换器外层加 `data-link-zone="nav"`，模板区块加 `data-link-zone="related"` 等，未标记的视为正文。
转化入口（首页、定价页指向 `/register` 的 CTA，定价卡片与悬浮 Ask AI 指向 `/app` 的按钮，产品矩阵主按钮）标为
`data-link-zone="action"`：它们是引导注册或进入应用的按钮，不是内容之间的链接，不参与正文链接计数。
区域可以写在链接自身或其祖先元素上，链接自身的标记优先。用途：
- 「链接到不可索引页」只在正文与区块中判失败，导航层的登录、账户入口与 action 区域的转化入口不算；
- 页脚链接数只统计页脚区域；
- 姊妹站链接出现在导航层即失败；
- 正文链接数只统计正文。

备选：按 CSS 选择器或组件名识别。否决：衍生项目改布局后就失效。

### 4. 回退页：canonical 指向原语言，hreflang 与站点地图只含真实译文

`localizedEntries()` 返回条目时保留其真实 `locale`，`publicPages()` 据此写 `sourceLocale`。`pageHead()` 遇到 `sourceLocale !== locale` 时，canonical 使用原语言地址；`alternateLinks()` 接收该页真实存在的语言列表。站点地图跳过回退页。回退页仍可访问，内部链接可以指向它（导航到当前语言），但它不作为检查对象。

备选：回退页 noindex。否决：使用者选择了 canonical 指向原语言。

### 5. 配置位置

`template.config.ts` 新增 `seo.linking`：`mode`（`report` / `enforce`）、各阈值、禁用词增补、`moneyPages`、`sisterDomains`、`series`（按 `group` 声明有序系列及排序字段）、hub 分页上限。类型和默认值在 `packages/config`。未配置时 `mode` 为 `report`；模板自身配置写 `enforce`。

### 6. 接入位置

- 本地：`pnpm --filter @saas/web check:links`，要求先 `pnpm build`。
- CI：放在已经产出 web 生产构建的 `build` job 中，紧跟 `pnpm build`，避免再次构建。实施时发现 e2e-smoke 运行的是 `vite dev`、没有生产产物，因此不放在那里。按 `docs/ci.md` 更新 job 说明与耗时预算。

### 7. 区块设计稿

组 3 的区块以模板原型索引（`docs/design-system/prototypes/README.md`）中「公开页内链区块」一行为准，副本在 `docs/design-system/prototypes/seo-internal-linking/`。已确认的组件变更：`packages/ui` 新增 Breadcrumb、Pagination、LinkCard、LinkList，不新增 token；面包屑替换文章顶部的「← 返回」链接；区块顺序为正文 → 系列上一篇／下一篇 → 相关 → 同组 → 页脚。

## Risks / Trade-offs

- [preview 抓取增加 CI 耗时] → 只抓公开页面；模板约百个地址，目标 30 秒内；在 PR 中记录实测耗时。
- [衍生项目页面量大（上千程序化页）] → 并发抓取并限制并发数；超过阈值时仍全量检查，但报告只列前 N 条明细。
- [区域标记被项目改坏，导致误判] → 检查脚本在页面完全没有 `nav` 区域时给出单独警告。
- [回退页 canonical 改变已收录地址] → 升级说明注明：已被收录的回退页会逐渐被合并到原语言页，属于预期结果。
- [内容集合推导的 parent 不符合项目结构] → frontmatter 可覆盖；检查失败信息给出覆盖方法。

## Migration Plan

1. 模板发布时 `mode` 未配置即为 `report`，衍生项目同步后构建不失败，CI 日志输出报告。
2. 升级说明给出：为项目自有页面补 `pages.project.ts` 声明；按报告修正孤岛与死链；确认后在 `template.config.ts` 设 `mode: 'enforce'`。
3. 回滚：回退代码即可；不涉及数据库与外部配置。

## Open Questions

- 检查报告除了日志，是否同时写入 `EVIDENCE_DIR` 作为验收证据：不影响规则，实现时按现有证据约定决定。
