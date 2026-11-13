# Design

## Context

现状见 `add-analytics-plausible-geo`，实现说明见 `docs/analytics.md` §2 与 §4：

- 根布局经 `getPlausibleSite` 取 `{ domain, scriptUrl }`，`analyticsHeadScripts` 输出带 `data-domain` 的 `script.manual.js`。页面事件由 `trackEvent` 调用 `window.plausible`。
- 公开页面在构建时预渲染：Cloudflare 读本环境的 wrangler vars，selfhost 读 `template.config.ts`。同一份 HTML 会被所有访问域名共用，构建时并不知道访客是从哪个域名进来的。
- 服务端事件经 `EVENTS_QUEUE` 交给 jobs。`serverAnalyticsTarget` 只有一个 site，事件 URL 固定是 `APP_URL`。
- 首触 Cookie `saas_ft` 不带 `Domain` 属性，天然按站点（主机名）隔离。

## Goals / Non-Goals

**Goals:**

- 一份构建产物（含预渲染页面）在多个访问域名下各自上报到正确的 site。
- 注册与付款事件归到用户注册时所在的站点。
- 单站项目无需任何改动，输出逐字节不变。

**Non-Goals:**

- 不引入模板级的多站点注册表。品牌、语言、`hosts` 这类站点概念仍由衍生项目自己维护，本 change 只处理 Plausible 映射。
- 不支持多个 Plausible 实例：所有站点共用一个 `PLAUSIBLE_HOST`，CSP 不变。
- 不做跨站访客串联：两站的 Cookie 和访客本来就是分开的。
- 不回填已有用户的注册域名。

## Decisions

### D1 配置形态：字符串映射 `PLAUSIBLE_SITES`

格式为 `host=site,host=site`：
- host 比较时转成小写，并去掉端口和开头的 `www.`；
- site 是 Plausible 的 site_id。

单站项目继续使用 `PLAUSIBLE_DOMAIN`。多站时它作为未登记域名的兜底，可以留空，留空就表示不统计预览地址。

- 选它的原因：一个字符串变量在 wrangler vars、`.env`、GitHub vars 和 `template.config.ts` 里写法都一样，门禁脚本也能直接比较。
- 备选：JSON 对象。wrangler 支持，但 `.env` 写起来别扭，Node 端还要额外解析和转义，否决。
- 备选：复用衍生项目的 `sites` 注册表。模板里没有这个概念，否决。

解析函数放在 `@saas/config`，web、jobs 和门禁脚本共用同一套规则。门禁是 `.mjs`，只能复制一份相同的解析逻辑，由同一组测试用例约束两份实现一致。

### D2 预渲染页面：多站时由客户端选择 site

配置了映射时，`analyticsHeadScripts` 不再输出带 `data-domain` 的脚本标签，而是输出一段内联配置：
- 形式为 `<script type="application/json" id="saas-plausible">`；
- 内容是 `{ sites, fallback, scriptUrl }`，其中 `fallback` 就是兜底的 `PLAUSIBLE_DOMAIN`。

客户端首次调用 `trackEvent` 之前，按 `location.hostname` 解析出 site，再动态插入 `script.manual.js` 并带上对应的 `data-domain`。解析不出 site 时不插入脚本，同时清空事件队列，不再继续排队。

- 选它的原因：manual 脚本在加载时读取 `data-domain`，按次调用无法改 domain。只有客户端知道真实的访问域名。
- 备选：服务端按 Host 输出不同的 HTML。预渲染页面绕过了 Worker，做不到，否决。
- 备选：不用脚本，由 `trackEvent` 直接 `fetch` `/api/event`。这样要自己实现脚本已有的去重和 `navigator.sendBeacon` 等细节，收益不大，否决。

内联 JSON 由 nonce 保护的 SSR 输出。它不执行，CSP 不需要改。

### D3 服务端事件：记录注册域名

- **注册：** 注册钩子从请求的 `Host` 读取访问域名，经 D1 的规则规范化后：
  - 写入 `user_attribution.signup_host`（可空列）；
  - 放进 `sign_up` 队列消息的可选字段 `host`。
- **没有首触 Cookie 时：** 不会写归因行，但 `sign_up` 仍然带上 `host`。
- **jobs 发送事件：** `ServerAnalyticsTarget` 改为 `{ sites, fallback, origin }`，发送时按事件选择 site：
  - `sign_up` 取消息里的 `host`；
  - `payment_success` 取空间所有者归因行里的 `signup_host`。
- **URL 和兜底：** 事件 URL 用 `https://<host><path>`。host 未登记或缺失时退回 `fallback` 加 `APP_URL`，再没有就不发送。
- **单站时：** 没有映射，`sites` 为空，一律走 `fallback`，与现在相同。

- 选它的原因：付款回调里没有用户请求，只能取注册时持久化的域名。
- 备选：记在 `user` 表上。归因数据本来就集中在 `user_attribution`，删除账号时也随行级联删除，放在 `user` 上会让认证表多出分析字段，否决。
- 备选：按空间语言推断站点。这是 xuanxue 特有的规则，模板不该依赖，否决。

只记 `signup_host` 有一个代价：没有首触 Cookie 的用户（例如清掉了 Cookie）付款时会退回 `fallback`。为了不扩大隐私面，接受这个取舍，详见 Risks。

### D4 门禁

- **静态检查 `check-wrangler-envs`：**
  - 映射必须能解析；
  - staging 与生产的 site 集合（映射值加上 `PLAUSIBLE_DOMAIN`）不得相交；
  - 同一环境下，web 与 jobs 的 `PLAUSIBLE_SITES` 必须相等。
- **部署后检查 `check-site-isolation`：**
  - 检查一个 URL 时，期望的 site 等于这个 URL 的主机名在映射中对应的值，未登记时取兜底值；
  - 单站页面：照旧比较脚本的 `data-domain`；
  - 多站页面：读取内联配置，解析出本主机名对应的 site 后再比较，同时校验 `scriptUrl` 的 origin 是实例地址。
- **期望为空时：** 页面上不得出现脚本，也不得出现内联配置。

### D5 Selfhost 与生成器

- **selfhost：** compose 透传 `PLAUSIBLE_SITES`，`.env.example` 加注释说明。预渲染取 `template.config.ts` 的 `analytics.plausibleSites`，默认是空字符串。
- **生成器：** 不新增参数，`--analytics off` 时连同映射一起移除。

## Risks / Trade-offs

- [多站页面晚一拍才加载脚本] 首个 `page_view` 要等动态插入的脚本加载完才发送。→ `window.plausible` 的队列先缓存事件，脚本加载后补发。这和 manual 脚本的 `defer` 加载方式等价。
- [`Host` 头可以伪造] 恶意请求可能把 `sign_up` 记到另一个已登记的站点。→ 只接受映射中登记过的 host，未登记的退回兜底值，影响仅限统计口径，不涉及安全。
- [`signup_host` 缺失] 没有首触 Cookie 的老用户和新用户付款时会退回 `fallback`。→ 文档说明这个口径。按站点看付款的准确数字仍然用 SQL，按 `signup_host` 分组。
- [两份解析实现可能不一致] → 共用一组表驱动用例，web、jobs 和门禁脚本各自跑一遍。
- [依赖未归档的 capability] `product-analytics`、`release-site-isolation` 由 `add-analytics-plausible-geo` 引入。→ 先归档那个 change（8.4 验收已在 2026-11-04 开始观察），再归档本 change。

## Migration Plan

1. 迁移：给 `user_attribution` 新增可空列 `signup_host`。这一步只加列，旧代码不读它，可以先发迁移再发代码。
2. 模板发布新版本（与 analytics 一同进入 v0.3.0）。
3. 衍生项目经 template-sync 升级后再配置映射。以 xuanxue 为例，生产配置 `PLAUSIBLE_SITES=ganjiday.com=ganjiday.com,arcanumber.com=arcanumber.com`、`PLAUSIBLE_HOST=https://stats.ganjiday.com`，`PLAUSIBLE_DOMAIN` 留空，staging 不配。
4. 回滚：删除 `PLAUSIBLE_SITES` 即退回单站行为。代码回滚后，`signup_host` 列可以保留不用。
