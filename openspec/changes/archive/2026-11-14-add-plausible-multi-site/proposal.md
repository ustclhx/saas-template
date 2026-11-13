# Proposal

## Why

模板的 Plausible 接入假定一个环境只服务一个站点：`PLAUSIBLE_DOMAIN` 只能填一个 site。衍生项目 xuanxue 用一个 Worker 按访问域名服务东方站 `ganjiday.com` 与西方站 `arcanumber.com`，两站品牌、语言和受众都分开，数据混在一个 site 里就看不出各站的漏斗。自建实例已上线，两个 site 也已建好，缺的是模板这一侧按访问域名选择 site 的能力。

## What Changes

- 新增可选配置 `PLAUSIBLE_SITES`：访问域名到 Plausible site 的映射，例如 `ganjiday.com=ganjiday.com,arcanumber.com=arcanumber.com`。Cloudflare 写在 `wrangler.jsonc` 的 `vars`，selfhost 写在 `.env`，预渲染取 `template.config.ts` 的 `analytics.plausibleSites`。
- 页面事件按当前访问域名选择 site：命中映射用映射值；未命中时退回 `PLAUSIBLE_DOMAIN`；两者都没有时不加载脚本，例如 workers.dev 预览地址。
- 服务端事件（`sign_up`、`payment_success`）按注册时的访问域名选择 site：注册时记录该域名，付款事件沿用付款人（空间所有者）注册时记录的域名。事件 URL 使用该域名，不再固定使用 `APP_URL`。
- 发布门禁同步支持多站：静态检查比较映射中的 site，staging 与生产不得共用，web 与 jobs 必须一致；部署后检查按被检查地址的域名校验脚本所属的 site。
- 单站项目：未配置 `PLAUSIBLE_SITES` 时行为与现在完全相同。
- 模板仓库自身不启用多站。xuanxue 只接两个正式站，staging 不接。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `product-analytics`：「一站一 Plausible site」改为「按访问域名选择 Plausible site」，并补充服务端事件的站点归属。该 capability 由 `add-analytics-plausible-geo` 引入，本 change 须在它归档之后归档。
- `release-site-isolation`：「分析脚本归属门禁」与「静态配置检查」需要覆盖站点映射。同样依赖 `add-analytics-plausible-geo` 先归档。

## Impact

- `packages/config`：`plausibleSite` 增加按域名解析；`template.ts` 新增 `analytics.plausibleSites`；`node-schema.ts` 新增 `PLAUSIBLE_SITES`。
- `apps/web`：
  - 脚本注入：`features/analytics/head.ts`、`features/seo/origin.functions.ts`，以及多站时由客户端注入；
  - 注册钩子：`features/analytics/server.ts`；
  - 运行时变量的传递：`server.ts`、`node/runtime.ts`、`node/http.ts`、`env.d.ts`。
- `apps/jobs`：`billing.ts` 构造 target，`notifications/analytics.ts` 按事件选择 site 与 URL，另外更新 `worker-env.d.ts`。
- `packages/db`：`user_attribution` 新增可空列 `signup_host`，带一个迁移；账号删除随行级联删除，不需要另外处理。
- `packages/shared/analytics`：服务端事件消息新增可选的 `host`。
- 门禁脚本：`scripts/production/check-wrangler-envs.mjs`、`scripts/staging/check-site-isolation.mjs`。
- 其他：
  - 文档：`docs/analytics.md`；
  - 生成器：`create-project` 的 analytics 参数不变，只有手工开启多站才需要配置；
  - selfhost：`deploy/selfhost` 的 compose 与 `.env.example`。
- 不变：CSP 仍只放行一个 `PLAUSIBLE_HOST` 实例地址。
