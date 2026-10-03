# Design

## Context

技术选型见 `docs/01-architecture.md` 技术栈（Paraglide JS、MDX、Tailwind v4 + shadcn/ui、`motion`）；动机见 proposal.md。前面的 change 已用 Paraglide 写了部分文案（错误码、邮件），本 change 把覆盖范围补全并统一语言路由。

## Goals / Non-Goals

**Goals:**
- 新站点只需替换文案、内容文件与主题变量即可得到完整营销站。
- 营销页在数据库不可用时仍能访问。

**Non-Goals:**
- CMS 后台编辑内容：内容以仓库中的 MDX 文件管理。
- 自动机器翻译。
- 应用区的 URL 加语言前缀：应用区语言取自用户设置，不进入 URL。

## Decisions

1. **内容方案（Q2）**：选 content-collections。理由：博客与法律页只需要「MDX + frontmatter 校验 + 类型化数据」，content-collections 更轻、与 TanStack Start 的构建集成简单；Fumadocs 更适合完整文档站，但会引入其路由与 UI 体系。`features.docs` 打开时，文档页同样用 content-collections + 自建侧边导航与客户端搜索（构建期生成索引）。若某个站点需要重型文档，可在该站点单独引入 Fumadocs。
2. **预渲染**：营销页、博客、法律页使用 TanStack Start 的预渲染（构建期生成）；定价页的套餐数据在构建期读取一次并通过 `HYPERDRIVE_CACHED` 在运行时按 1 小时缓存刷新，数据库不可达时使用构建期数据。
3. **语言路由**：默认语言无前缀，其他语言 `/<locale>/...`；中间件识别前缀并设置 Paraglide 语言。首次访问只在页面上显示语言建议横幅，不做自动重定向，避免影响爬虫与缓存。
4. **语言偏好存储**：未登录存 Cookie；登录用户写入 `user.locale`，登录后以账号设置为准。
5. **OG 图片**：使用 `workers-og`（或同类基于 satori + resvg-wasm 的库）在 Worker 中生成，按 URL 缓存到 R2 / Cache API。若 WASM 体积超出 Worker 限制，改为构建期为每个公开页面预生成。
6. **主题**：`next-themes` 风格的实现（类名切换 + 内联脚本在首屏前设置类），避免闪烁；颜色全部为 shadcn/ui CSS 变量，新站点只改变量。

## Risks / Trade-offs

- [OG 图片生成库的 WASM 体积影响 Worker 包大小] → 见决策 5 的退路。
- [预渲染页面中的定价与实际不一致] → 运行时 1 小时缓存刷新；定价页结账按钮以服务端实时价格为准。

## Migration Plan

无数据迁移。上线时提交站点地图到搜索引擎控制台。

## Open Questions

（无）
