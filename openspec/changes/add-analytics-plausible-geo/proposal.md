# Proposal

## Why

模板站目前回答不了“谁来、卡在哪、谁付钱”：没有统一埋点、首触归因和多站分析；staging 曾出现 sitemap 指向衍生站域名，生成器还把 staging 的 APP_URL 写成生产域名，这类串扰比缺功能更危险。需求已拍板，真相源是 `docs/requirements/analytics-plausible-geo.md`。

## What Changes

**P0**
- 统一 `trackEvent` 与事件字典，`sign_up`、`payment_success` 由服务端上报。
- 首触归因：第一方 Cookie 记录来源，注册时写入新表 `user_attribution`。
- 接入自建 Plausible：一站一 site，按环境配置，`features.analytics` 单选，默认 `plausible`，长期词站可关。
- 发布串扰门禁：部署后校验 sitemap、robots、canonical、favicon、分析脚本都属于当前环境；静态检查禁止 staging 与生产共用站点配置。
- **BREAKING**（生成器）：新项目 staging 的 APP_URL 不再等于生产域名，默认 `https://staging.<域名>`。
- `create-project` 新增 `--analytics`、`--plausible-domain`、`--plausible-host`，并写入 `PROJECT_SETUP.md`。

**P1**
- `/llms.txt`。
- IndexNow：密钥走环境变量，生产发布后提交站点地图 URL。
- 答案优先页脚手架：`/guides`，frontmatter 含 `title`、`answer_summary`、`faq[]`，自动输出 FAQ JSON-LD；`features.guides` 控制，生成器可选。
- 转化路径：定价页使用完整页头页脚，CTA 路径与需求一致。

**P2**
- `PROJECT_SETUP.md` 写清 Google Search Console 与 Bing Webmaster 验证步骤。
- Clarity：可配置接入，默认关闭，不作为转化真相源。
- 404 页提供返回导航。
- 法律页不再公开展示模板占位邮箱，发布清单提示替换。

**明确不做**：不替代 Sentry；不并行多套分析作为真相源；不默认开启会话录制；不接广告追踪。不部署 Plausible 实例、不打 tag、不发生产。

## Capabilities

### New Capabilities

- `product-analytics`: 事件字典、服务端权威事件、首触归因与 Plausible 接入及开关。
- `release-site-isolation`: 发布时校验公开地址与分析脚本属于当前环境。
- `answer-pages`: 答案优先指南页与 FAQ 结构化数据。

### Modified Capabilities

- `seo`: 新增 `/llms.txt` 与 IndexNow 提交。
- `marketing-site`: 定价页转化路径、404 回导航、法律页占位处理。
- `project-bootstrap`: 分析与 staging 地址参数、搜索站长验证清单、答案页选项。

## Impact

- 数据库：新表 `user_attribution`（迁移 0019），账号删除时清除。
- 代码：`packages/shared`、`config`、`db`、`auth`；`apps/web` 的 analytics、seo、marketing、路由、CSP；`apps/jobs` 的事件消费者。
- 配置：web / jobs 的 `wrangler.jsonc`、selfhost compose；新增变量 `PLAUSIBLE_DOMAIN`、`PLAUSIBLE_HOST`、`INDEXNOW_KEY`，配置项 `analytics.clarityProjectId`。
- CI：staging 与生产部署增加门禁步骤，生产部署增加 IndexNow 步骤。
- 外部：依赖自建 Plausible 实例，未就绪时脚本不注入，服务端事件不发送，归因仍写库。
