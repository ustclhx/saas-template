## Why

使用者在 xuanxue 确认了一份多语言 SEO 规范（ML-01～ML-10，原文见私有证据库 `xuanxue-saas-evidence/i18n-spec/multilingual-seo-spec.md`），核心目标是「每个语言有一个能让搜索引擎单独收录、单独排名的网址」，并要求模板库同步这份规范，让所有衍生项目同步即得。

模板现状与规范有三处冲突：

- 语言建议横幅在服务端 HTML 中输出（每种候选语言一条，默认隐藏），由 `<head>` 内联脚本与偏好 Cookie 决定显示哪一条，违反 ML-03「提示只在前端出现、不进服务端 HTML」。
- 0.7.4 起，缺少译文的页面以原语言内容挂在其他语言前缀下发布，canonical 指向原语言；ML-04 要求未翻译页面默认不发布。
- 语言前缀直接取语言 id，`zh-Hant` 会生成 `/zh-Hant`；ML-01 要求小写 BCP 47 前缀。

另外，规范中的验收项（Accept-Language 不影响响应、hreflang 双向互指、`html lang` 正确、公开页没有语言 Cookie 等）目前没有自动检查。

## What Changes

- **BREAKING（行为）**：未翻译页面默认不发布。该语言前缀下返回 404，不进站点地图、hreflang 与站内链接。以原语言回退显示改为项目可选（`i18n.untranslated: 'fallback'`），开启后仍按 0.7.4 的规则输出 canonical。
- **BREAKING（组件与 URL）**：
  - 移除服务端输出的语言建议横幅、首帧脚本和建议用的偏好 Cookie，改为水合后才挂载的固定定位提示条。提示条只读 `navigator.language` 和本页 hreflang，用普通 `<a>` 跳转，关闭状态记在 localStorage。新组件需先经 `ui-design` 设计关卡。
  - 语言前缀统一为小写，旧的大小写写法 301 到小写地址。
- 默认语言不得有两套地址：`/<默认语言>/…` 301 到无前缀地址。公开页不按 Accept-Language、IP 或 UA 跳转，也不按 Cookie 渲染不同语言。
- hreflang 支持各语言路径不同（本地化 slug）：`SeoPage` 新增可选的 `alternates`（语言 → 路径），项目自有页面可用当地关键词作 slug。语言切换器也只链接该页真实存在的语言版本。
- `<html>` 输出与页面语言一致的 `lang` 和 `dir`，RTL 语言输出 `dir="rtl"`。
- 新增可选的「已登录用户首页记住语言」（ML-09），默认关闭。只对已登录、且主动切换过语言的用户，在首页 `/` 跳到他选的语言首页；匿名访客、爬虫和内页都不跳。
- 构建后链接图检查增加多语言规则：canonical 指向自身、hreflang 双向互指且同域、恰有一条 x-default、`html lang` 正确、Accept-Language 不改变响应、公开页没有语言 `Set-Cookie`、没有 `?lang=` 链接、默认语言没有两套地址、服务端 HTML 中没有语言提示。规则失败时按 `seo.linking.mode` 处理。
- 新增规范文档 `docs/multilingual-seo.md`，覆盖 ML-01～ML-10；其中内容独立（ML-07）与上线节奏（ML-10）只作为编写与运营指引，不做检查。

不在本次范围：模板内置内容集合（博客、文档等）的本地化 slug（项目自有页面可用 `alternates`）、按地区区分的语言代码（如 `en-US`）、自动翻译。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `i18n`：「语言路由」改为小写前缀、默认语言唯一地址、不按请求头跳转，`html lang` 与 `dir` 也在这里规定；「语言选择与记忆」改为前端提示条；新增「已登录用户首页记住语言」。
- `seo`：「多语言关联」改为未翻译页默认不发布、回退可选，并加入 `alternates` 与 x-default 规则；「站点地图与抓取规则」明确站点地图等于可索引页面集合。
- `seo-internal-linking`：「构建后链接图检查」增加多语言规则。

## Impact

- `apps/web/src/features/i18n/`（`suggestion.ts` 删除或改写、`language-controls.tsx`、`preference.ts`、`request.server.ts`）、`apps/web/scripts/i18n-project.ts`（Paraglide URL 规则）、`routes/__root.tsx`（`lang`、`dir`、移除首帧脚本）。
- `apps/web/src/features/seo/`（`metadata.ts`、`pages.ts`）、`features/marketing/content.ts`（`localizedEntries`）、内容路由（未翻译时 404）。
- `packages/config`：`i18n.untranslated`、`i18n.rememberHomeLocale` 配置与校验。
- `apps/web/scripts/check-links*.mjs`：多语言规则与请求头对比。
- `packages/ui` 或 `@saas/web`：新的语言提示条组件（经设计关卡）。
- 衍生项目：需按升级说明处理未翻译页 URL 变为 404、移除对 `LanguageSuggestion` 与偏好 Cookie 的依赖、检查大小写前缀的外链。版本为 MINOR（0.8.0）。
- 不涉及数据库迁移；ML-09 复用已有的 `user.locale`。
