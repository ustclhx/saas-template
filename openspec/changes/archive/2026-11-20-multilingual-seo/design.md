## Context

- 路由：Paraglide 编译选项在 `apps/web/scripts/i18n-project.ts`。公开页 `strategy: ['url', 'baseLocale']`，应用区与 `/_serverFn` 为 `['cookie', 'baseLocale']`，不含 preferredLanguage，所以公开页目前不按 Accept-Language 跳转。前缀直接取语言 id（`zh-Hant` → `/zh-Hant`）。
- 账号语言：`request.server.ts` 只在应用区与 Server Function 读取会话，把 `user.locale` 写进 Paraglide Cookie，响应设为 `private, no-store` 并可能 `Set-Cookie`。公开页不写 Cookie。
- 语言建议：`features/i18n/suggestion.ts` 生成首帧内联脚本，读取 `navigator.languages` 与偏好 Cookie，给 `<html>` 写 `data-locale-suggestion`。`LanguageControls` 在 SSR 中为每个候选语言输出一条隐藏横幅，靠 CSS 只显示匹配的一条。这样做是为了避免 CLS，代价是提示进入了服务端 HTML，并依赖 Cookie。
- 回退：`features/marketing/content.ts` 的 `localizedEntries()` 用默认语言条目补齐缺失的 slug。0.7.4 起回退页 canonical 指向同站原语言（`fallbackSourceLocale()`），且不进站点地图。
- hreflang：`metadata.ts` 的 `alternateLinks(appUrl, path, languages)` 假设各语言路径相同，只按语言加前缀。x-default 已存在。
- `<html lang>` 由根路由按 Paraglide 语言输出，没有 `dir`。
- 链接图检查（`apps/web/scripts/check-links*.mjs`）已按 HTTP 抓取全部公开页，并解析 canonical 与 robots，可以在同一次抓取中加入多语言规则。

## Goals / Non-Goals

**Goals:**
- 模板默认行为满足 ML-01～ML-06、ML-08，衍生项目同步即得。
- ML-03 的提示条不进服务端 HTML，也不产生 CLS。
- ML-09 可选，默认关闭。
- 规范第六节的验收项尽量自动化，并入现有链接图检查与 CI，不新增 job。

**Non-Goals:**
- 内置内容集合（博客、文档、答案页、法律页）的本地化 slug：它们仍按 slug 对应，项目自有页面用 `alternates` 声明。
- 区分地区的语言代码（`en-US`、`en-GB`）。
- ML-07 内容独立性的自动判定（相似度门槛由项目自行实现）。
- ML-10 上线节奏只写进文档。

## Decisions

### 1. 未翻译页默认 404，回退显示改为 `i18n.untranslated: 'fallback'`

`packages/config` 的 `i18n` 段新增 `untranslated: 'hide' | 'fallback'`，默认 `'hide'`。

- `'hide'` 时 `localizedEntries()` 只返回该语言的真实条目：列表页只列出已翻译的条目，详情路由找不到条目时返回 404，站点地图、hreflang 与区块都只基于真实条目。
- `'fallback'` 时保持 0.7.4 的行为，`fallbackSourceLocale()` 仍负责同站 canonical。

备选：保留回退为默认。否决：使用者选择默认不发布（ML-04），版本因此为 MINOR。

### 2. 小写前缀与默认语言唯一地址

- Paraglide 的 URL 规则改为输出小写前缀（通过 `urlPatterns` 或等价的本地化函数），检查脚本已经从运行时取前缀，无需再改。
- 请求中间件在进入 Paraglide 之前做两种 301：前缀大小写不同的地址，以及带默认语言前缀的地址。这是地址规范化，不属于「选语言」。
- 规范化只看路径，不看任何请求头。

备选：在 Cloudflare 规则中做重定向。否决：自托管目标没有，且规则不随模板同步。

### 3. 语言提示条：水合后挂载的固定定位组件

- 新组件 `LanguagePrompt` 只在客户端 `useEffect` 后渲染，所以 SSR 与预渲染输出中没有它。
- 候选语言取自本页 `<link rel="alternate" hreflang>`（排除 x-default），这样提示天然只指向已发布版本，且无需额外数据。匹配规则沿用 `suggestion.ts` 现有的 `navigator.languages` 匹配函数（完整标签 → 语言加书写系统 → 主语言）。
- 位置：手机底部、桌面右下，`position: fixed`，不占文档流。
- 关闭状态存在 localStorage，读写包在 try/catch 里，失败时只是本次不再显示。
- 删除首帧脚本、`data-locale-suggestion*` 属性、隐藏横幅和建议用的偏好 Cookie（`PREFERENCE_COOKIE`）。语言切换器手动选择时仍写 Paraglide Cookie，供应用区使用；这是浏览器端写入，不是公开页的 `Set-Cookie`。
- 视觉需经 `ui-design` 关卡：在模板设计稿中画出手机与桌面、浅色与深色，由使用者确认后再实现。

备选：保留 SSR 横幅，只把显示条件改为客户端判断。否决：ML-03 明确要求提示不进服务端 HTML。

### 4. hreflang 与本地化 slug：`SeoPage.alternates`

- `SeoPage` 新增可选 `alternates?: Record<locale, path>`，路径不带语言前缀，按各自语言加前缀。
- 声明了 `alternates` 时，hreflang 与语言切换器使用这些地址；未声明时沿用「同路径加前缀」与 `languages` 列表。
- 静态校验增加两条：
  - `alternates` 中的语言版本也要在清单里，且互相声明（双向），否则构建失败。
  - 键必须是已配置语言。
- 语言切换器在 `'hide'` 模式下只列出真实存在的版本；其他语言不显示，或指向该语言的首页（实现时按设计稿确定，二选一写入文档）。

### 5. `lang` 与 `dir`

根路由按当前语言输出 `lang`。`dir` 由 `new Intl.Locale(locale).getTextInfo?.().direction` 推出，运行时不支持时用内置的 RTL 语言表（ar、fa、he、ur 等）。模板默认语言都是 ltr，行为不变。

### 6. ML-09：客户端标记加首页检查，默认关闭

- 新增 `i18n.rememberHomeLocale: boolean`，默认 `false`。
- 已登录用户在语言切换器中手动选择语言时，客户端写一个 localStorage 标记（所选语言）。退出登录时清除。
- 默认语言首页 `/` 水合后：配置开启、标记存在、标记语言不同于当前语言、本页 hreflang 中有该语言版本，并且确认处于登录状态时，执行 `location.replace` 到该语言首页。登录状态由客户端已有的会话信号判断，不在公开页查库。
- 选择客户端方案的原因：
  - 首页是预渲染的静态页，服务端跳转需要每次请求都读会话，违背 Neon 成本基线；
  - 爬虫和匿名访客没有标记，天然不跳；
  - 内页不执行该逻辑。

备选：服务端读取 `user.locale` 后 302。否决：首页需要查库，且 `user.locale` 可能在注册时就已写入，无法区分是否「主动选择」。

### 7. 检查：并入链接图检查

在 `check-links.mjs` 现有抓取结果上增加以下规则，复用 `report` / `enforce` 模式与报告格式：

- 每页：canonical 指向自身；`html lang` 与该页在 hreflang 组中的语言一致；没有语言查询参数链接；没有提示条标记（`data-language-prompt` 与旧 `data-locale-suggestion*`）。
- 跨页：hreflang 双向互指（用已抓取页面的 hreflang 组建图）、同域、恰好一条 x-default、目标可访问且可索引。
- 请求头：对 `/` 与各语言首页（及抽样至多 N 个页面）分别以两种 Accept-Language 请求，比较状态码、`Location`，以及正文 `html lang` 和规范化正文摘要。
- 响应：公开页响应带有名称或内容与语言相关的 `Set-Cookie` 时失败。
- 默认语言前缀：请求 `/<默认语言>` 与 `/<默认语言>/pricing`，期望 301 到无前缀地址。

多站点（`seo.linking.sites`）时以上规则按站点各自执行。

### 8. 规范文档

新增 `docs/multilingual-seo.md`，按 ML-01～ML-10 编号写出模板如何满足各条、哪些靠配置、哪些属于项目职责（ML-07、ML-10），以及第六节验收与检查规则的对应表。`docs/seo-internal-linking.md`、`new-static-page` 技能与 `features/seo/README.md` 加入口。

## Risks / Trade-offs

- [衍生项目已被收录的回退页变为 404] → 升级说明给出两种选择：设置 `i18n.untranslated: 'fallback'` 保持现状；或补译文后再发布。并提醒在 Search Console 观察覆盖率。
- [前缀改为小写会改变已收录地址] → 旧地址 301 到小写地址；模板默认语言 `en`、`zh` 不受影响，升级说明列出受影响的语言 id 形态（含大写字母的）。
- [提示条在水合后出现，可能被认为闪现] → 固定定位不影响 CLS；设计稿中给出进入动画，并遵循 `prefers-reduced-motion`。
- [Accept-Language 对比抽样不足] → 首页与各语言首页必测，其余抽样；数量可配置，CI 中全量成本过高时取抽样。
- [ML-09 依赖客户端会话信号] → 只在首页执行；信号缺失时不跳，宁可不跳也不误跳。

## Migration Plan

1. 发布为 0.8.0（MINOR），升级说明列出必须执行的动作：
   - 确认未翻译页的处理方式（默认 404，或设置 `fallback`）；
   - 删除项目代码中对 `LanguageSuggestion`、`localeSuggestionScript`、`SUGGESTABLE_LOCALES`、偏好 Cookie 的引用；
   - 检查大写语言前缀的外链与站内硬编码地址；
   - 运行 `check:links --mode report` 查看多语言规则结果。
2. xuanxue 已在设计自己的提示组件，同步时可保留项目自有组件，只需满足检查规则。
3. 回滚：回退代码即可，不涉及数据库。

## Open Questions

- 语言切换器在本页没有某语言版本时，是隐藏该语言还是指向该语言首页：随设计稿由使用者确认。
- 「语言相关的 `Set-Cookie`」的判定口径：先按 Paraglide Cookie 名与旧偏好 Cookie 名判断，项目可配置额外名称。
