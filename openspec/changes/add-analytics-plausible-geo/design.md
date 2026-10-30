# Design

## Context

见 proposal.md。现状：已有可选 PostHog（需同意）与 Cloudflare beacon；公开页在构建期预渲染，Cloudflare 按环境构建，能读到该环境的 wrangler vars，selfhost 的预渲染读 `template.config.ts`；CSP 目前为 Report-Only；`EVENTS_QUEUE` 已承载计费后处理与运营通知，运营通知用 `audit_log` 做发送标记。实查 staging（2026-10-31）：sitemap、robots、canonical 都指向本站，需求记录的 arcanumber 串扰未复现；`/favicon.ico` 与 `/llms.txt` 为 404。

## Goals / Non-Goals

**Goals:** 各环境数据隔离；付款事件不依赖浏览器；分析故障不影响业务。

**Non-Goals:** 部署或运维 Plausible 实例；用 Sites API 自动开站（手工步骤写入清单）；媒体任务终态的服务端上报。

## Decisions

**1. 配置分层。** 工具选择放模板配置（`features.analytics`），site 与实例地址放环境变量。单选开关从结构上排除多套并行；site 放构建常量会让 staging 带上生产值。selfhost 预渲染读不到运行时环境，使用 `analytics.plausibleDomain/Host`，与其 `APP_URL` 预渲染行为一致。

**2. 服务端事件走 `EVENTS_QUEUE`。** 备选是请求内直接 `fetch`：会拖慢 Webhook，Worker 上未等待的请求可能被截断，也没有重试。消息只带身份标识，消费者查库解析归因与套餐。

**3. 去重用 `audit_log` 发送标记。** 与运营通知一致，不新增表。发送成功后写标记，属于至少一次语义：发送成功但写标记失败时可能多计一次，可接受，付款真相在 `payment` 表。

**4. 首触用客户端 Cookie + 注册钩子写库。** 公开页是静态预渲染，服务端无法设置；Better Auth 钩子覆盖所有注册方式，OAuth 回调属于同站顶级导航，`SameSite=Lax` 会带上 Cookie。独立表 `user_attribution`，不扩展 user 列：Better Auth 的 user 对象会下发到客户端，归因不应进入会话数据。

**5. Plausible 用 manual 脚本。** 由 `trackEvent` 发送 `pageview`，才能脱敏 URL 并附加属性。脚本从 SSR head 输出，门禁可直接校验。

**6. `payment_success` 归因到空间所有者。** 付款属于空间，个人空间所有者即付款人；团队空间取最早的所有者。

**7. 门禁独立于 Playwright。** 用无依赖 Node 脚本，从 `wrangler.jsonc` 读取期望值，紧跟健康检查运行，失败即阻断。

**8. 答案页是独立集合。** 不复用 blog：frontmatter 必填项不同，页面结构也不同。沿用 content-collections 与预渲染，内容校验在构建期完成。

**9. IndexNow 密钥放 `/indexnow.txt`。** 协议要求密钥可公开访问，`keyLocation` 指向根路径即覆盖全站，无需为每个密钥动态路由。提交由部署步骤执行，只在生产运行，失败不阻断。

**10. Clarity 由客户端注入。** 需要判断 DNT / GPC，服务端做不到；只在公开页面加载。会录制会话，因此默认关闭，启用前需更新隐私政策。

**11. 占位邮箱按语言显示提示。** 法律页模板声明保留（提醒法律审阅）；只替换邮箱。不在门禁中硬失败：模板自身生产环境尚无真实支持邮箱，硬失败会阻断其发布，改为门禁输出警告，清单提示替换。

## Risks / Trade-offs

- [未在真实 Plausible 实例上验证] → 用单元测试和本地收件桩验证请求内容；实例就绪后按 tasks 第 8 组验收。
- [Plausible 可能丢弃 Webhook 来源事件（数据中心 IP / UA）] → 响应头 `x-plausible-dropped` 记日志；付款归因可用 SQL 直接查询。
- [欧盟等地 Cookie 可能需要事先同意] → 模板遵守 DNT / GPC 并更新隐私政策；是否加同意流程由各站上线前确认。
- [离开详情页后结束的媒体任务不计入终态事件] → 已写入文档，属于可接受的漏斗低估。
- [同一 selfhost 镜像跑多环境时公开页带构建时 site] → selfhost 预渲染既有限制；文档注明。
- [生成项目 staging 地址是占位值] → 门禁在首次部署时拦下，清单提示替换。

## Migration Plan

迁移 0019 只新增表，先迁移后部署，回滚时旧代码不读此表。`features.analytics` 默认值改为 `plausible`，但环境变量为空时无脚本、无服务端事件，现有站点的可见变化仅为写首触 Cookie 和记录归因。需要完全关闭的站点设为 `false`。

## Open Questions

- Plausible 实例的运维归属与地址：不影响代码，配置环境变量即启用。
