# 需求：埋点 / 自建 Plausible / SEO·GEO 骨架

> **状态**：范围已由 Haixin 拍板（2026-10-30）。本文档为实现真相源；实现走本机 Claude / Orca，不另开范围确认。
>
> **仓库**：`ustclhx/saas-template`  
> **本机 checkout**：`/Users/hxlee/workspace/saas-template`  
> **Staging 前端**：https://web-staging.saas-jobs.workers.dev （首页/登录页可直接打开；工作区需登录）

## 1. 背景与目标

### 1.1 角色输入

- **交付验收官**：首日埋点与归因、漏斗、GEO 答案页骨架。
- **SEO 助手（青柠）**：已收紧 SEO / GEO 相关口径，与本文 P1 对齐。

### 1.2 现状（以本机 checkout + staging 实查为准）

- 已有营销页骨架与 Sentry 类运维观测；Phase 7 文档中提及 Web Analytics / 可选 PostHog，但本机未见完整 **Plausible / GA / UTM 漏斗** 实现。
- Staging 上分析开关未真正落地（验收侧记为 `features.analytics: false` 量级），无 Plausible / GA 脚本。
- Staging 存在 **域名与衍生站串扰** 风险：`sitemap.xml` 的 `<loc>` 曾指向 `https://arcanumber.com/sitemap/en.xml`；`/sitemap/en.xml`、favicon 等出现 404（见 §4 门禁）。
- Staging `/llms.txt` 404（P1）。

### 1.3 产品策略

| 站类型 | Plausible | 说明 |
|---|---|---|
| **新词站**（默认） | **开** | 一站一 `site_id`，共用自建实例，仪表盘按站隔离 |
| **长期词站** | **可选** | 模板开关可关；文档与 `create-project` 需写清默认与覆盖方式 |

**边界（本阶段）**

| 系统 | 职责 |
|---|---|
| **Plausible（自建）** | 多站日更漏斗与产品事件 |
| **GA4** | 后接可选，非本阶段必做 |
| **GSC / Bing** | 只管收录与查询词（验证步骤见 P2） |
| **Sentry** | 继续做错误/性能；**不**用 Plausible 替代 |

## 2. 范围总览

| 优先级 | 主题 | 本节 |
|---|---|---|
| **P0** | 漏斗埋点 + 首触归因 | §3.1 |
| **P0** | 自建 Plausible 集群接入 | §3.2 |
| **P0** | Staging / 发布配置串扰门禁 | §4 |
| **P1** | `llms.txt`、IndexNow、答案优先页脚手架、转化路径一致 | §5 |
| **P2** | GSC/Bing 步骤、Clarity（默认关）、脚手架对齐、404/合规占位 | §6 |
| **不做** | 见 §7 | |

## 3. P0 功能需求

### 3.1 漏斗埋点 + 首触归因

#### 3.1.1 统一封装

- 提供统一 `trackEvent`（或等价封装），前后端约定同一事件名与属性字典。
- 客户端与服务端均可上报；**付款相关以服务端为权威事件**（避免仅靠前端 `payment_success`）。

#### 3.1.2 最少事件字典

| 事件名 | 含义 |
|---|---|
| `page_view` | 页面浏览 |
| `sign_up` | 注册成功 |
| `upload` | 用户上传（若产品有上传入口） |
| `generate_start` | 开始生成 |
| `generate_success` | 生成成功 |
| `generate_fail` | 生成失败 |
| `paywall_view` | 触达付费墙 / 套餐墙 |
| `checkout_start` | 开始结账 |
| `payment_success` | 支付成功（**服务端权威**） |

#### 3.1.3 最少属性

每次事件至少携带（有则填、无则显式缺省约定）：

- `source`（首触/当前归因源）
- `landing_path`
- `locale`
- `plan`
- `device`

#### 3.1.4 首触归因绑定

- 用户**首次进站**时，将来源站、UTM、落地页绑定到用户（持久化），供后续订单归因。
- **ChatGPT / GEO 流量**：必须依赖 `utm_source=chatgpt`（及约定 UTM）+ 落地 `path`；**不能只靠 HTTP referrer**。

#### 3.1.5 验收（产品）

上线 **24 小时内**能回答：

1. **谁来**（渠道 / UTM / 落地页）  
2. **卡哪**（漏斗掉在哪一事件）  
3. **谁付**（付款用户的首触归因）

### 3.2 自建 Plausible 集群

#### 3.2.1 多站模型

- **一站一 `site_id`**；共用同一 Plausible 实例；仪表盘按站隔离。
- `create-project` 注入该站的 **domain + script**；事件字典与 §3.1.2 一致。

#### 3.2.2 开关策略（写入模板配置 / 生成文档）

- 新词站：默认启用 Plausible。
- 长期词站：可选关闭；生成物与 `PROJECT_SETUP`（或等价）写明如何开关。
- Staging：可启用测试 site，但必须使用 staging 自己的 domain / `site_id`，禁止串到衍生站或生产站（见 §4）。

#### 3.2.3 本阶段明确不做（Plausible 相关）

- 不替代 Sentry。
- 不默认三套分析并行（Plausible + GA4 + 其它同时作为产品漏斗真相源）。
- 不做会话录制。
- 不做广告全家桶。

## 4. P0 验收 / 发布门禁（Staging 补记）

> 以下来自 staging 实查，**必须**写入发布验收，建议标为 **P0 门禁**（配置串扰比「缺功能」更危险）。

### 4.1 Staging 基线

- URL：https://web-staging.saas-jobs.workers.dev  
- 首页、登录页可匿名打开；鉴权路由需登录。

### 4.2 域名与衍生站串扰（必须拦）

发布 / staging 验收**失败条件**示例：

| 检查项 | 不合格信号（已观察到的类问题） |
|---|---|
| `sitemap.xml` | `<loc>` 指向他站域名（例：`https://arcanumber.com/sitemap/en.xml`） |
| 子 sitemap | `/sitemap/en.xml` 等返回 404，或内容域名与当前 `APP_URL` 不一致 |
| favicon / 静态品牌资源 | 关键资源 404，或指向错误站点 |
| 分析脚本 | 注入了非本站 `site_id` / domain，或生产脚本进 staging |
| `APP_URL` / canonical | 与当前环境 wrangler / 配置中的站点 URL 不一致 |

**通过标准**：所有公开 SEO / 站点地图 / canonical / 分析 domain 均指向**当前环境自己的** `APP_URL`（staging 即 `https://web-staging.saas-jobs.workers.dev` 或其正式 staging 自定义域），不得出现其它衍生项目域名。

### 4.3 建议自动化

- CI 或 deploy smoke：解析 `sitemap.xml`（及子 sitemap）中的 host，断言 ∈ 当前环境允许列表。
- 可选：断言 `/favicon.ico`（或约定路径）非 404；断言无他站 `site_id` 的 Plausible 脚本。

## 5. P1 需求

### 5.1 `llms.txt`

- 提供 `/llms.txt`（可选 full 变体，若做则文档约定路径）。
- 当前 staging `/llms.txt` → 404，验收时应变为 200 且内容指向本站。

### 5.2 IndexNow

- 接入 IndexNow，并具备 **key 配置**（密钥走 secret / 环境变量，不进仓明文）。
- 文档写清提交时机（发布 / 重要 URL 变更）。

### 5.3 「答案优先」指南页骨架 + 脚手架

#### 页面形态

可复制 **2～3 类**答案页：

1. 怎么做  
2. 免费吗  
3. 趋势是什么  

要求：

- **结论置顶**
- FAQ + **FAQ JSON-LD**

#### 脚手架

- 路由或 MDX 约定
- frontmatter 至少：`title`、`answer_summary`、`faq[]`
- 自动 FAQ JSON-LD 组件
- `create-project` **可选**生成 1～2 个示例页 + 占位文案

#### 验收

- 新站能一键得到可改文案的答案页
- 源码可见 FAQ schema  
- **不要求**第一版写满真实 SEO 长文

### 5.4 转化路径一致（Staging 补记）

| 路径 | 期望 |
|---|---|
| 首页套餐 CTA | → `/register` |
| 定价页 CTA「View in my workspace」 | → `/app`，未登录则进登录后再回工作区 |
| 定价页导航 | 应有完整头/尾导航，对齐可转化的注册 / 结账路径 |

Staging 上若定价页缺头尾导航、CTA 不一致，实现时需对齐上述路径。

## 6. P2 需求

- **PROJECT_SETUP**（或等价生成文档）写清 Google Search Console / Bing Webmaster 验证步骤。
- **Clarity** 热力：支持接入但 **默认关**；不得作为转化真相源。
- 本机与 remote analytics 脚手架对齐（工程债）。
- **404** 页提供回导航。
- 隐私 / 退款等合规页去掉模板占位（如 `support@example.com`），改为项目真实或明确占位流程。

## 7. 明确不做（本阶段）

- 产品漏斗默认 **三套分析并行** 作为真相源。
- 用热力 / 会话录屏当转化真相源。
- 用 Plausible 替代 Sentry。
- 会话录制、广告全家桶（同 §3.2.3）。

## 8. 实现与调度

| 项 | 约定 |
|---|---|
| 需求文档 | 本文；路径见文首 |
| 实现 | 本机常驻 Claude（无窗口则 OMP）；经 Orca 调度；临时 worktree 做完即关 |
| 本机 GUI / 密钥 | 先 Codex computer use；密钥 / token 走剪贴板，不写入对话 |
| 范围 | 已拍板，实现侧按 P0 → P1 → P2 推进，无二次范围确认 |

### 建议落地顺序

1. **P0 门禁**：sitemap / canonical / 资源域名串扰检测（可先修 staging 再固化 CI）  
2. **P0**：`trackEvent` + 事件字典 + 首触归因持久化 + 服务端 `payment_success`  
3. **P0**：自建 Plausible 注入与 `create-project` site 配置  
4. **P1**：转化路径对齐 → `llms.txt` / IndexNow → 答案页脚手架  
5. **P2**：文档与打磨项

## 9. 参考

- Staging 浏览笔记（验收官侧）：`/workspace/saas-ux-review/saas-template-staging-2026-10-30.md`（实现前可对 staging 再自验）。
- 相关既有文档：`docs/README.md`（Phase 6/7 营销与观测概述）、`docs/create-project.md`、`apps/web/wrangler.jsonc`（`env.staging.vars.APP_URL`）。

## 10. 开放问题（非阻塞）

实现中若需拍板再开单；当前**不阻塞**开工：

1. 自建 Plausible 实例的运维归属与 staging/prod 的 `site_id` 命名规范（建议：`<project>-staging` / `<project>`）。  
2. 首触归因存储表位置（user 扩展列 vs 独立 attribution 表）——由实现选定并补设计短文即可。  
3. 「长期词站」关闭 Plausible 的配置键名（与现有 `features.*` 对齐时再定）。
