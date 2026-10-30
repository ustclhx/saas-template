# Tasks

## 1. P0 事件与归因

- [x] 1.1 在 `packages/shared` 增加事件字典、属性、URL 脱敏与首触解析，并通过 `analytics.test.ts`
- [x] 1.2 新增 `user_attribution` 表与迁移 0019，账号删除时清除，并通过 db 与 auth 的类型检查和迁移校验
- [x] 1.3 用注册钩子写入归因并投递 `sign_up`，后台代建账号除外，用集成测试验证 Cookie 落库、非法 Cookie 不影响注册
- [x] 1.4 实现浏览器 `trackEvent`、首触 Cookie 与漏斗埋点，并通过 `track.test.ts`
- [x] 1.5 Webhook 与后台重放投递 `payment_success`，jobs 消费者解析归因、去重并发送，并通过 `analytics.test.ts` 与 `webhook-http.test.ts`

## 2. P0 Plausible 接入

- [x] 2.1 增加 `features.analytics` 单选与 `plausibleSite` 环境配置，贯通 Cloudflare、Node 与 jobs，并通过 config 测试
- [x] 2.2 head 按环境注入脚本，CSP 放行本环境实例，并通过 `head.test.ts`
- [x] 2.3 生成器增加 `--analytics`、`--plausible-domain`、`--plausible-host`，写入 wrangler、模板配置、基准参数与清单，并通过 `pnpm test:create-project`
- [x] 2.4 编写 `docs/analytics.md`，写明字典、归因、开关和开通步骤，更新隐私政策模板

## 3. P0 串扰门禁

- [x] 3.1 增加 `/favicon.ico` 并在根 head 声明，本地请求返回 200
- [x] 3.2 实现 `check-site-isolation.mjs` 并覆盖需求 §4.2 各失败信号，通过 `staging.test.mjs`
- [x] 3.3 接入 staging 与生产部署流程，放在健康检查之后，对线上 staging 只读运行并确认已知问题只剩待部署项（2026-10-31：staging 只剩 favicon 404，随本次部署解决；生产地址从本机 TLS 连接被重置，未能检查，由部署流程内的门禁校验）
- [x] 3.4 `check-wrangler-envs` 拒绝共用站点配置和 web / jobs 不一致，生成器 staging APP_URL 不再等于生产域名，并通过 `production.test.mjs` 与 `create-project.test.mjs`

## 4. P1 llms.txt 与 IndexNow

- [x] 4.1 新增 `/llms.txt`，关闭营销时不注册，门禁纳入校验，并通过单元测试与本地请求
- [x] 4.2 新增 `/indexnow.txt` 与 `INDEXNOW_KEY` 配置，未配置返回 404，并通过单元测试
- [x] 4.3 编写提交脚本并接入生产部署（失败不阻断），测试只提交本站地址，文档写清提交时机

## 5. P1 答案页

- [x] 5.1 新增 `guides` 内容集合与 `features.guides`，三类中英文示例，缺必填字段时构建失败
- [x] 5.2 新增 `/guides` 列表与详情路由，结论置顶，输出 FAQ JSON-LD，预渲染并进入站点地图、`llms.txt` 与导航，并通过单元测试和 e2e
- [x] 5.3 生成器支持 `--features guides`，文档与 `new-static-page` 技能写清约定，并通过生成器测试

## 6. P1 转化路径

- [x] 6.1 定价页使用 `MarketingShell`，核对首页 CTA 指向 `/register`、定价页 CTA 未登录经登录回到 `/app`，并通过 e2e

## 7. P2 打磨

- [x] 7.1 清单写入 GSC 与 Bing 验证步骤及法律页发布提示，并通过生成器测试
- [x] 7.2 Clarity 配置项默认关闭，只在公开页加载，遵守 DNT / GPC，CSP 按需放行，并通过 `track.test.ts` 与 `security-headers` 测试
- [x] 7.3 404 页提供回导航并返回 404 状态码，并通过 e2e
- [x] 7.4 法律页替换占位邮箱为尚未配置提示，门禁输出警告，并通过 content 测试
- [x] 7.5 核对 `origin/ustclhx/p7-analytics` 与本地脚手架的差异，把结论写入 PR 说明

## 8. 集成验收

- [x] 8.1 `pnpm check`、`pnpm typecheck`、`pnpm check:deps`、`pnpm check:singletons`、`pnpm test`、`pnpm build` 全部通过
- [x] 8.2 本地启动 web，用收件桩验证脚本注入、`trackEvent` 请求、UTM 首触落库；证据写入 `EVIDENCE_DIR`
- [ ] 8.3 部署后线上门禁通过（阻塞：需合并并部署 staging，由协调者执行）
- [ ] 8.4 配置真实 Plausible 实例后验收：staging 仪表盘 24 小时内能回答谁来、卡哪、谁付（阻塞：需实例地址；下一步填 `PLAUSIBLE_DOMAIN` / `PLAUSIBLE_HOST` 并按 `docs/analytics.md` §4 开站，同时确认 Webhook 来源的 `payment_success` 未被实例丢弃）
