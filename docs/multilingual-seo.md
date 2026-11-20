# 多语言 SEO 规范

目标：每个语言有一个能被搜索引擎单独收录、单独排名的网址。本文按 ML-01～ML-10 说明模板怎么满足每一条、
哪些靠配置、哪些属于项目自己的职责。设计依据见 OpenSpec change `multilingual-seo`；
链接与 hreflang 的检查规则见 [站内链接规范 §3](seo-internal-linking.md#3-链接图检查)。

## ML-01 一个语言一个前缀

- 默认语言（`i18n.defaultLocale`）使用无前缀地址，其他语言用**小写**语言 id 作前缀：`zh-Hant` → `/zh-hant/…`。
- 两个语言 id 只差大小写时配置直接报错。
- `/<默认语言>/…` 一律 301 到无前缀地址；大小写不同的前缀写法 301 到小写地址。只看路径，保留查询参数。
- 语言只由路径表达：不用 `?lang=`，不按 Cookie 或脚本在同一地址渲染不同语言。
- 多站点项目的各站点可以有自己的无前缀语言（`seo.linking.sites[].defaultLocale`），见下文「多站点」。
- 各语言路径可以不同（本地化 slug）：项目自有页面在 `SeoPage.alternates` 中声明各语言地址（见 ML-05）。
  模板内置的博客、文档、答案页、法律页仍按同一 slug 对应。

## ML-02 不按语言跳转

- 公开页不按 Accept-Language、IP、User-Agent 或 Cookie 返回 30x，也不改变内容语言。
  应用区（`/app` 等）仍按账号语言与 Paraglide Cookie 决定语言，不受此限。
- `<html lang>` 等于页面实际语言；`dir` 由 `Intl.Locale` 的文本方向推出，运行时不支持时用内置 RTL 表兜底。
  项目的 `html-attributes.ts` 可以覆盖 `dir`，但不能覆盖 `lang`。

## ML-03 只在前端提示语言

- 语言提示条 `LanguagePrompt`（`@saas/ui`）只在公开页水合、且浏览器空闲后挂载，服务端与预渲染 HTML 中没有它。
- 候选语言取自本页 `<link rel="alternate" hreflang>`，与 `navigator.languages` 匹配（完整标签 → 语言加书写系统 → 主语言），
  所以只会提示本页已发布的语言。后两步不跨地区：配置了 `pt-BR` 时 `pt-PT` 不匹配，只回退到没写地区的 `pt`
  或地区相同的语言；`zh-TW` → `zh-Hant` 这类书写系统匹配照常。
- 项目自有的提示组件不用模板的 `data-language-prompt` 标记时，把它的属性名写进 `seo.linking.promptMarkers`
  （如 `['data-locale-prompt']`，结尾 `*` 表示前缀），`language-prompt-ssr` 才能检查到。
- 提示条固定定位在桌面右下、手机底部，叠在 Ask AI 上方，不占版面、不引起布局位移。
  提示文案来自目标语言的文案，链接是普通 `<a href hreflang>`。
- 关闭后记在 localStorage，不写 Cookie。设计稿见原型索引「语言提示条」一行。

## ML-04 canonical 指向自身，未翻译页不发布

- 公开页 canonical 一律指向自身绝对地址。
- 未翻译页默认不发布（`i18n.untranslated: 'hide'`）：该语言地址返回 404，不进入站点地图、hreflang、列表与站内链接。
- 确需以原语言内容显示时设 `i18n.untranslated: 'fallback'`：回退页 canonical 指向同一站点内的原语言页，
  不进入 hreflang 与站点地图（多站点规则见 [站内链接规范 §7](seo-internal-linking.md#7-多站点)）。
- `'hide'` 下页面清单中仍有回退页（`sourceLocale` 与 `locale` 不同）时构建失败。

## ML-05 hreflang 完整一套

- 每页输出自身、该页真实存在的其他语言版本，以及恰好一条 x-default；绝对地址，双向互指，不跨域名。
- x-default 默认指向默认语言版本（多站点时先取本页站点的默认语言）；该页没有默认语言版本时指向配置顺序中第一个存在的版本。
- 需要指定时写 `seo.linking.xDefaultLocales`（有序，如 `['en', 'zh-Hant']`）：x-default 指向列表中本页存在的第一个语言，
  都不存在时按上一条。站点可用 `sites[].xDefaultLocales` 覆盖。模板的 hreflang 输出与 `hreflang-x-default` 检查用同一个函数
  （`locale-url.ts` 的 `pageXDefaultLocale`）；配置了列表时检查还会核对 x-default 的指向，未配置时只检查条数。
- 本地化 slug：在页面清单的条目上写 `alternates: { en: '/four-pillars', ko: '/만세력' }`（路径不带语言前缀）。
  构建时校验：键必须是已配置语言，目标页存在且可索引，双方互相声明同一组。
- 语言切换器 `LanguageMenu` 是普通链接的下拉菜单，公开页只列出本页 hreflang 中的语言。

## ML-06 站点地图

站点地图自动生成，地址集合等于可索引页面集合：不含 404、noindex、回退页与带查询参数的地址。

## ML-07 内容独立（项目职责）

每个语言先找该语言的关键词，再分别写标题、描述、H1、正文与 slug，不直译默认语言的 TDK；品牌名可保留原文。
模板不判断内容质量，内容相似度的门槛由项目自行实现。

## ML-08 其他元素按语言输出

标题、描述、结构化数据（`inLanguage`）、OG 标签、`<html lang>` 与 `dir` 都按页面语言输出；语言切换器使用普通链接。

## ML-09 记住已登录用户的语言（可选，默认关闭）

- 在 `template.config.ts` 设 `i18n: { rememberHomeLocale: true }` 开启。
- 已登录用户在语言切换器中手动选择语言时，浏览器记下所选语言；之后打开默认语言首页 `/`，
  若本页 hreflang 中有该语言，就 `location.replace` 到该语言首页。
- 匿名访客、爬虫、内页与分享链接都不跳；公开页不为此查询数据库。
- 登录状态来自浏览器中的登录标记（进入应用区、账户或后台页时写入，7 天有效，退出登录与删除账号时清除）。
  在服务端撤销会话、但该设备没有退出时，最多 7 天内仍可能跳转。

## ML-10 上线节奏（项目职责）

新站先做默认语言加 3～5 个有真实需求的语言；每个语言验证「独立找词 → 独立收录 → 有曝光」后再扩，不一上来铺十几种。

## 多站点

同一部署按 Host 服务多个站点的项目（[站内链接规范 §7](seo-internal-linking.md#7-多站点)），各站点可以有不同的无前缀语言：

```ts
seo: {
  linking: {
    sites: [
      // 省略 defaultLocale：含全局默认语言 en，en 无前缀
      { locales: ['en'], hosts: ['west.example.com'], previewHost: 'west.localhost' },
      {
        locales: ['zh-Hant', 'zh-Hans'],
        hosts: ['east.example.com', 'www.east.example.com'],
        previewHost: 'east.localhost',
        defaultLocale: null, // 该站点所有语言都带前缀；也可写本站点的某个语言
      },
    ],
    xDefaultLocales: ['en'], // 可选；站点也可写自己的 xDefaultLocales
  },
},
```

- `defaultLocale` 必须是该站点的语言。省略时：站点包含 `i18n.defaultLocale` 则为它，否则为 `null`。
- `hosts` 为该站点的生产主机名：只写主机名，不含协议与端口，各站点之间不能重复。
- 未配置 `sites` 时行为与单站点完全相同。

模板按站点处理的部分（不需要改模板文件）：
- **请求时的 301**：`request.server.ts` 进入 Paraglide 前，用 `requestLocaleRouting()`（`features/i18n/locale-url.ts`）选出站点。
  - 按请求 Host（忽略端口与大小写）匹配站点的 `hosts` 或 `previewHost`。
  - 匹配到站点时只处理该站点的语言：站点默认语言前缀 301 到无前缀地址，大小写不同的前缀 301 到小写；其他站点语言的前缀原样放行，例如东方站的 `/en` 不会被跳到 `/`。
  - 没有匹配（staging、未登记的域名）时按全局 `i18n` 处理。
- **链接图检查**：`default-locale-prefix` 对每个声明了 `previewHost` 的站点请求 `/<站点默认语言>`，期望 301 到无前缀地址。
  站点默认语言的首页为 `/`；没有无前缀语言的站点不检查。
- **hreflang 输出与检查**：x-default 的默认规则先取本页站点的默认语言，站点的 `xDefaultLocales` 优先于全局列表。

项目自有代码可直接使用 `locale-url.ts` 的纯函数：
- `siteOfHost`：按 Host 找站点；
- `siteRouting`：站点的 `{ locales, defaultLocale }`；
- `localePath`：按站点默认语言生成地址；
- `pageXDefaultLocale`：x-default 的选择规则。

限制：站点默认语言不是全局 `i18n.defaultLocale` 时，该站点的无前缀地址还要在 Paraglide 中解析为站点默认语言。
Paraglide 的 URL 规则（`localeUrlPatterns`）、`localizeHref` 与预渲染只认全局默认语言，模板目前无法通用地按 Host 解析。
这种站点要么把 `defaultLocale` 设为 `null`（站点内全部带前缀），要么让站点默认语言与全局默认语言一致；否则项目需要自行按 Host 生成 URL 规则并本地化链接。

## 验收与检查规则对照

`pnpm --filter @saas/web check:links` 在构建后运行（CI 的 build job 中也会运行）：

| 规范验收项 | 检查规则 |
|---|---|
| 不同 Accept-Language 结果一致、没有 `Location` | `accept-language-vary`（首页、各语言首页与抽样页，`--accept-language-samples` 调整抽样数） |
| canonical 指向自身 | `canonical-self` |
| hreflang 正确、双向、同域、x-default 恰一条（配置了 `xDefaultLocales` 时指向偏好语言） | `hreflang-reciprocal`、`hreflang-cross-host`、`hreflang-x-default`、`hreflang-target` |
| `html lang` 正确 | `html-lang` |
| 公开页没有语言 `Set-Cookie` | `language-set-cookie`（项目自有的语言 Cookie 名写进 `seo.linking.languageCookies`） |
| 没有 `?lang=` 链接 | `lang-query-link` |
| `/` 与 `/<默认语言>` 不并存 | `default-locale-prefix`（多站点按各站点默认语言） |
| 站点地图等于可索引集合 | `dead-link`、`link-to-noindex` 与站点地图种子 |
| 语言提示不在服务端 HTML 中 | `language-prompt-ssr`（项目自有标记写进 `seo.linking.promptMarkers`） |
| 提示条不增加 CLS | e2e `i18n-preference.spec.ts` |

以上都是失败级规则，按 `seo.linking.mode` 处理：`report` 只报告，`enforce` 有失败项时退出码为 1。
