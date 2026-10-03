# Proposal

## Why

模板要作为不同 AI 应用的起点，需要一套可直接改文案上线的营销站、博客与法律页，以及多语言和搜索引擎优化的基础设施；这些与业务逻辑无关，但每个新站点都必须有，放在核心功能完成后统一实现（`docs/08-roadmap.md` Phase 6）。

## What Changes

- 落地页区块：Hero、功能、定价（读取 `plan` 数据）、FAQ、评价、CTA、页脚；营销页预渲染。
- 内容：博客（MDX）、法律页（隐私政策、服务条款、退款政策）、可选文档站（`features.docs`）。
- 多语言：Paraglide 覆盖页面、邮件模板与错误码；语言按 URL 前缀区分，用户偏好语言保存在账号设置中。
- SEO：metadata、sitemap、robots、OG 图片、JSON-LD、hreflang。
- 暗色模式与主题定制（基于 shadcn/ui 的 CSS 变量）。
- 决定待决事项 Q2（内容方案）。

## Capabilities

### New Capabilities
- `marketing-site`: 营销首页、定价展示、博客、法律页与可选文档站的对外行为。
- `i18n`: 多语言的路由、语言选择与回退、覆盖范围。
- `seo`: 搜索引擎与社交分享所需的元数据、站点地图与抓取规则。

### Modified Capabilities
（无）

## Impact

- 依赖 `add-billing-and-credits` 的 `plan` 数据（定价区块）与 `add-auth-and-workspaces` 的用户语言设置。
- 新增 `apps/web/content/`、`apps/web/messages/` 内容与文案；邮件模板改为多语言。
- 退款政策页的内容需与 `docs/05-billing.md` 中「默认不主动退款、可申请」的规则一致。
