# Design

## Context

- 渲染核心 `renderer.ts` 目标中立：Workers 与 Node 只提供图片引擎与字体来源。Noto Sans SC（约 8.3 MB）作为静态资源发布，只在文本含 Inter Latin 子集之外的字符时读取（`add-og-images` design 第 5 条）。
- 项目自有扩展点已有 `share-cards.project.ts`（注册类型）、`share-cards.theme.ts`（品牌覆盖）与 `theme/html-attributes.ts`（按 host / locale / pathname 返回 `data-site` 等属性）。模板创建后不再修改，`template-release check` 守护。
- 卡片地址 `v=<version>-<digest8>`；Cache API 键含 origin，R2 键含 `v`。

## Decisions

1. **字体登记放在新的项目自有文件 `share-cards.fonts.ts`**，而不是 `share-cards.theme.ts`：主题文件已被项目改过，模板无法再向其中加入默认导出。新文件只导出 `projectShareCardFonts: readonly ProjectShareCardFont[]`。类型名用 `ProjectShareCardFont`，避免与渲染器已有的 `ShareCardFont`（含字节）冲突。
2. **登记在模块加载时校验**（`fonts.ts`）：文件名只能是 `public/fonts/share-card/` 下的单个 `.otf/.ttf/.woff` 文件名（不含路径分隔符、不含 `..`，satori 不支持 woff2）；文字名必须是合法的 Unicode Script 值，且不能是 Common / Inherited（否则标点会让每张卡片都读取字体）；族名不能与 Inter、Noto Sans SC 重名；同一族名与字重不能重复。不合法时抛错，构建期分享图与测试即失败。
3. **字体顺序**：Inter → Noto Sans SC → 项目字体。项目字体只补前两者没有的字形；Noto 能显示的字符仍加载 Noto。`fallbackFontPlan(text)` 给出是否需要 Noto 与需要的项目字体；渲染器按文件缓存字节、按组合缓存字体数组，读取失败不缓存。默认版式的 `fontFamily` 追加项目字体族名。
4. **标题字重**：需要 Noto 时整行 400（沿用）；只需要项目字体时，所需字体族都登记了 600 才保持 600。
5. **多站点钩子放在 `share-cards.theme.ts` 的可选导出** `resolveProjectShareCardSite(context)`，上下文沿用 html-attributes 的 `{ host, locale, pathname }`（字段名 `pathname` 与之对应）。模板以命名空间导入并遍历导出查找，旧项目没有该导出时不告警、不报错。返回值可含 `theme`、`brand { name, initial? }`、`host`、`tagline`，省略的字段沿用单站点默认值。
6. **站点传入版式**：`render(data, theme, site)` 增加第三个参数；`shareCardLayout` 的内容增加可选 `brand`、`host`，省略时用模板配置（行为不变）。多站点项目在自己的 `render` 中把 `site.brand`、`site.host` 传入；模板的 `sample` 与默认分享图已传入。
7. **地址指纹**：`shareCardVariant` = `<version>-<digest8>`，项目字体指纹（族名、文件、字重、文字，不含字节）或站点覆盖指纹任一非空时追加 `-<fnv8>`。都为空时地址与之前相同，升级不会让已缓存的卡片全部失效。
8. **站点按请求 host 解析**：卡片路由、分享页与 `shareCardMeta` 共用 `resolveRequestShareCardSite(requestUrl, APP_URL)`。站点覆盖声明了 `host`（项目的规范域名）时，分享页与卡片的绝对地址改用该域名（协议沿用 `APP_URL`），卡片请求才会落到同一站点；未声明 `host` 或没有覆盖时仍用 `APP_URL`。从不使用请求的原始 Host：www 变体、预览与 workers.dev 域名不进入对外元数据，也不信任任意 Host 头。`host` 必须是裸主机名（可带端口），否则整个覆盖视为无效。
9. **默认分享图副标题**：去掉写死的「AI workspace」，取站点 `tagline`，未提供时取该语言首页的 SEO 标题（`staticPage('/', locale).title`，项目随产品文案修改）。构建期按页面 locale 解析，中文页面得到中文副标题。

## Risks / Trade-offs

- **构建期静态分享图按路径输出**：`/og/<locale>/<path>.png` 由所有域名共用，构建期解析只有 `app.url` 的 host 与页面 locale / pathname。按域名区分的站点要么用 locale / 路径区分，要么分别构建（与 html-attributes 预渲染的限制相同），文档写明。
- **字体登记或站点覆盖变化时所有卡片换地址**：下一次请求重新渲染，旧对象留在 R2 直到失效、到期或删空间清理。变化很少发生，可以接受。
- **请求 host 只用于选择站点**：绝对地址只用 `APP_URL` 或项目声明的规范域名。覆盖未声明 `host` 时卡片地址落在 `APP_URL` 的站点，该站点解析出的覆盖不同会 302 到它自己的地址，所以多站点覆盖应总是返回 `host`（文档写明）。
- **项目字体体积**：完整韩文字体通常 4–16 MB，冷实例首次解析会增加 CPU。文档建议使用子集（如 KS X 1001 常用 2350 音节）或 Regular 单字重。
