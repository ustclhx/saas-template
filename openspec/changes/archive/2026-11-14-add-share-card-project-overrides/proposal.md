# Proposal

## Why

衍生项目 xuanxue 暴露了分享卡片的两处硬编码：

1. **字体**：渲染器只有 Inter 与 Noto Sans SC（`CJK_FONT_FILE`），韩文（谚文）显示为方框，`text.ts` 也把谚文当作不支持的文字。项目没有不改模板文件就能补字体的入口。
2. **多站点**：一次部署服务两个品牌域名（如 ganjiday.com 与 arcanumber.com）时，默认版式的品牌行固定为 `templateConfig.app.name`，域名固定为 `app.url`，构建期默认分享图的副标题写死为「<name> · AI workspace」，主题只有一个 `projectShareCardTheme`。一个站点的分享图会显示另一个站点的名称与域名。

## What Changes

- 新增项目自有文件 `apps/web/src/features/share-cards/share-cards.fonts.ts`：登记额外回退字体（族名、`public/fonts/share-card/` 下的文件名、Unicode 文字名、可选字重）。模板只创建一次空列表与注释示例，之后不再修改；生成器原样复制，`template-sync` 只在项目没有该文件时新增，`template-release check` 拒绝模板修改它。
- 渲染器（Workers 经 `ASSETS.fetch`、Node 与构建期读本地文件）在 Inter 与 Noto Sans SC 之后按需加载项目字体：只有文本含其登记文字时读取，实例内缓存；字体字节不进 Worker 包。
- `text.ts` 把项目字体覆盖的文字视为受支持（触发加载、不降级）；谚文按全角计算字宽。
- 新增项目自有文件 `share-cards.sites.ts`，导出 `resolveProjectShareCardSite({ host, locale, pathname })`（模板默认返回 `undefined`），按站点返回主题、品牌、规范域名与副标题覆盖。卡片路由、分享页与 `shareCardMeta` 按请求 host 解析，构建期默认分享图按页面 locale / pathname 解析。
- 默认版式 `ShareCardLayoutContent` 增加可选 `brand`、`host`；注册类型的 `render` 增加第三个参数 `site`。
- 默认分享图副标题不再写死「AI workspace」：取站点解析的 `tagline`，未提供时取该语言首页的 SEO 标题。
- 卡片地址 `v` 在项目登记了字体或站点覆盖时追加指纹；两者都没有时地址与之前完全相同。
- 0.5.0 跟进（xuanxue 接入 0.4.1 后的反馈）：底部元信息不再按 satori 测量宽度裁掉末字；韩文标题与摘要按词换行（`keep-all`）；运行时卡片按分享页语言解析站点（有站点覆盖且非默认语言时卡片地址带 `l` 参数）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `share-cards`：渲染支持项目回退字体；多站点解析；卡片地址随字体登记与站点覆盖变化；站点覆盖声明规范域名时元数据使用该域名。

## Impact

- 代码：`apps/web/src/features/share-cards/`（新增 `fonts.ts`、`site.ts`、`hash.ts`、项目自有 `share-cards.fonts.ts`；修改 `renderer.ts`、`text.ts`、`layout.tsx`、`meta.ts`、`image.server.ts`、`page.server.ts`、`meta.server.ts`、`preview.server.ts`、`render.server.ts`、`types.ts`），`server/cloudflare/share-card-renderer.ts`、`node/share-card-renderer.ts`、`scripts/og-images.ts`。
- 工程脚本：`scripts/create-project.mjs`、`scripts/template-sync/merge.mjs`、`scripts/template-release.mjs` 登记新的项目自有文件。
- 文档：`docs/share-cards.md`、`apps/web/src/features/seo/README.md`、升级说明 `docs/upgrades/0.4.1.md`。
- 兼容：PATCH，非破坏。没有登记字体、没有导出站点解析函数的项目卡片地址与渲染结果不变；唯一可见变化是构建期默认分享图副标题由「AI workspace」改为首页 SEO 标题。
- 无数据库迁移、无新增依赖、无新增密钥或绑定。
