# Tasks

## 1. 映射解析与配置

- [x] 1.1 在 `@saas/config` 实现 `PLAUSIBLE_SITES` 的解析与按 host 选择 site（小写、去端口、去开头 `www.`，未登记退回 `PLAUSIBLE_DOMAIN`），`plausibleSite` 返回映射与兜底；用表驱动用例覆盖单站不变、多站命中、未登记无兜底、格式错误，并通过 config 测试
- [x] 1.2 `template.ts` 新增 `analytics.plausibleSites`（默认空串），`node-schema.ts` 新增 `PLAUSIBLE_SITES`（空串视为未设置），贯通 `apps/web` 的 `env.d.ts`、`server.ts`、`node/runtime.ts`、`node/http.ts` 与 `apps/jobs` 的 `worker-env.d.ts`；通过 `pnpm typecheck`

## 2. 浏览器端

- [x] 2.1 `getPlausibleSite` 与 `analyticsHeadScripts`：无映射时输出与现状完全相同（现有 `head.test.ts` 不改即通过）；有映射时改为输出带 nonce 的内联配置 `#saas-plausible`，并补 `head.test.ts` 用例
- [x] 2.2 客户端在首次 `trackEvent` 前按 `location.hostname` 解析 site，动态插入 `script.manual.js`；解析不出时不插入脚本并清空队列；用 `track.test.ts` 覆盖命中、未登记、队列补发
- [x] 2.3 本地用 `PLAUSIBLE_SITES` 构建 web，以两个 host 请求同一预渲染页，确认各自插入的 `data-domain` 不同；证据写入 `EVIDENCE_DIR`

## 3. 服务端事件

- [x] 3.1 新增迁移：`user_attribution.signup_host`（可空），并通过 db 迁移校验与 `pnpm test`（含集成）
- [x] 3.2 注册钩子读取并规范化请求 Host，写入 `signup_host`，`sign_up` 消息带可选 `host`（`@saas/shared/analytics` 类型同步）；集成测试验证无首触 Cookie 时消息仍带 host
- [x] 3.3 jobs：`serverAnalyticsTarget` 改为映射 + 兜底，`deliverServerAnalytics` 按事件选择 site 与事件 URL（`sign_up` 用消息 host，`payment_success` 用所有者 `signup_host`），未登记退回兜底、无兜底不发送也不占位；`analytics.test.ts` 覆盖两站、兜底、跳过，单站用例不改即通过
- [x] 3.4 账号删除仍随 `user_attribution` 级联清除 `signup_host`，现有删除测试通过

## 4. 门禁、selfhost 与文档

- [x] 4.1 `check-wrangler-envs.mjs`：映射可解析、staging 与生产 site 集合不相交、web/jobs `PLAUSIBLE_SITES` 相等；与 1.1 共用同一组解析用例，通过 `production.test.mjs`
- [x] 4.2 `check-site-isolation.mjs`：按被检查 URL 的 host 求期望 site，单站比较 `data-domain`，多站读取 `#saas-plausible` 并校验 site 与 `scriptUrl` origin，期望为空时脚本与配置都不得出现；通过 `staging.test.mjs`
- [x] 4.3 selfhost compose 透传 `PLAUSIBLE_SITES`，`.env.example` 注释说明；生成器在 `--analytics off` 时同时移除映射；通过 `pnpm test:create-project` 与 selfhost compose 门禁
- [x] 4.4 `docs/analytics.md` §4 增加多站配置、预渲染行为、服务端事件归属与 `signup_host` 口径（含按站点统计付款的 SQL）

## 5. 集成验收

- [x] 5.1 `pnpm check`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部通过；模板仓库 staging（单站）部署后 `check-site-isolation` 仍通过，且实例 site `saas-template-staging` 照常收到 pageview（2026-11-04：#292 部署后 staging 仍为单站脚本、门禁通过，无头浏览器访问 /pricing 的 pageview 与 paywall_view 进入 site 3）
- [x] 5.2 衍生项目验收（需 xuanxue 升级到包含本 change 的模板版本后执行，不随本 change 的 PR 勾选）：生产配置两站映射后，`ganjiday.com` 与 `arcanumber.com` 的 pageview 与 `sign_up` 各自进入实例 site 1 与 site 4（2026-11-12：xuanxue 生产两站映射已配置，近 14 天 site 1 ganjiday.com 收到 275 次 pageview、2 次 sign_up，site 4 arcanumber.com 收到 198 次 pageview、2 次 sign_up，各自入库互不混入；证据见私有证据库 plausible-multi-site/5.2-2026-11-12）
