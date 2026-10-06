# 02 · 项目结构与约定

## 1. Monorepo 目录

```
saas-template/
├─ apps/
│  ├─ web/                        # TanStack Start，部署为 Worker
│  │  ├─ src/
│  │  │  ├─ routes/               # 文件路由
│  │  │  │  ├─ (marketing)/       # 首页、定价、博客、法律页（尽量预渲染）
│  │  │  │  ├─ (auth)/            # 登录、注册、找回密码、邀请接受
│  │  │  │  ├─ app/               # 登录后的应用区（/app/$slug/...，个人空间也有 slug）
│  │  │  │  ├─ admin/             # 平台管理后台
│  │  │  │  └─ api/               # HTTP 接口：auth、webhooks、ai、public v1
│  │  │  ├─ components/           # 页面级组件
│  │  │  ├─ features/             # 按功能组织的 UI + server functions
│  │  │  │  ├─ billing/  ai/  workspace/  settings/  admin/ ...
│  │  │  ├─ server/               # 仅服务端：上下文、中间件、鉴权守卫
│  │  │  ├─ lib/                  # 前端工具
│  │  │  └─ styles/
│  │  ├─ content/                 # MDX：博客、文档、法律页
│  │  ├─ messages/                # Paraglide 文案，按功能拆分：<locale>/<feature>.json
│  │  └─ wrangler.jsonc
│  └─ jobs/                       # 纯 Worker：Workflows / Queue 消费者 / Cron
│     ├─ src/
│     │  ├─ workflows/ai-media.ts
│     │  ├─ queues/email.ts  events.ts
│     │  ├─ cron/credits-expire.ts  subscription-grants.ts  holds-sweep.ts  reconcile.ts  cleanup.ts
│     │  └─ index.ts              # 导出 fetch/queue/scheduled + Workflow 类
│     └─ wrangler.jsonc
├─ packages/
│  ├─ config/                     # template.config.ts 类型与默认值、env schema
│  ├─ db/                         # Drizzle schema、迁移、createDb()、scoped 查询
│  ├─ auth/                       # Better Auth 实例工厂与插件配置
│  ├─ billing/                    # PaymentProvider 接口 + stripe/ paypal/ 实现
│  ├─ credits/                    # 积分：grant / hold / capture / release / expire
│  ├─ entitlements/               # 套餐权益判断 can()
│  ├─ ai/                         # 文本模型注册、MediaProvider 接口 + fal/ 实现
│  ├─ storage/                    # R2 封装、预签名上传、SSRF 安全下载
│  ├─ email/                      # React Email 模板 + 发送接口
│  ├─ ui/                         # shadcn/ui 组件（被 web 使用）
│  └─ shared/                     # 通用类型、错误、id 生成、时间工具
├─ infra/
│  ├─ postgres/                   # VPS 上的 docker-compose（PG + cloudflared + WAL-G）
│  └─ local/                      # 本地开发 docker-compose
├─ docs/
├─ biome.json  package.json  pnpm-workspace.yaml  turbo.json
└─ CLAUDE.md / AGENTS.md          # AI 编码助手约定
```

**依赖方向**：`apps/*` → `packages/*`；packages 之间只允许 `shared` ← `config` ← `db` ← 业务包（billing/credits/ai/…）。业务包不得依赖 `apps`，不得依赖 React（`ui` 除外）。例外：`email` 用 React Email 在服务端渲染邮件，允许依赖 `react` / `react-dom` 与 React Email（`react-email`、`@react-email/*`），但不得依赖 `ui`；其他包依赖 React Email 同样视为依赖 React。以上规则由 `pnpm check:deps`（`scripts/check-deps.mjs`）检查。

## 2. 为什么拆 `apps/jobs`

- Workflow 类必须由某个 Worker 导出；与 TanStack Start 的入口混在一起会增加耦合。已实测：web 经 `script_name` 绑定 jobs 中定义的 Workflow，创建实例、查询状态、`sendEvent` 均可用（Phase 0 任务 4.5、7.2）。
- 后台任务的 CPU / 依赖 / 发布节奏与 Web 不同，拆开后互不影响包体与稳定性。
- `apps/web` 通过 Workflow 绑定（`script_name: jobs`）启动工作流、通过 Queue 投递消息；需要同步调用时用 Service Binding。

## 3. 配置体系

三层配置，**各管各的内容、互不覆盖**（同一个配置项只属于其中一层，不存在「高优先级层覆盖低优先级层」）：

| 层 | 位置 | 内容 | 修改方式 |
|---|---|---|---|
| 密钥 | Wrangler secrets / `.dev.vars` | API Key、Webhook secret、Auth secret | `wrangler secret put` |
| 运行时设置 | 数据库 `setting` 表（KV 缓存） | 可在后台修改的项：模型定价、公告、注册开关 | 管理后台 |
| 模板配置 | `template.config.ts`（代码） | 功能开关与产品形态 | 改代码、重新部署 |

归属原则：泄露有风险的放密钥；需要不发版就能改的放运行时设置；决定代码路径和产品形态的（是否多租户、启用哪些登录方式）放模板配置。运行时设置在代码里必须有默认值，`setting` 表中缺失时回退到默认值，而不是去读另外两层。

`template.config.ts` 草案：

```ts
export default defineTemplateConfig({
  app: { name: 'MyApp', url: 'https://example.com', supportEmail: 'support@example.com' },
  i18n: { locales: ['en', 'zh'], defaultLocale: 'en' },
  tenancy: {
    multiTenant: false,          // false = 仅个人空间；true = 允许团队 workspace
    maxWorkspacesPerUser: 5,
  },
  auth: {
    emailPassword: true,
    requireEmailVerification: false, // 邮箱密码注册是否必须先验证邮箱才能登录；默认否，领取注册赠送积分时才要求验证
    emailOtp: true,              // 邮箱验证码登录（emailOTP 插件）
    magicLink: false,            // 魔法链接登录（magicLink 插件）
    oauth: ['google', 'github'],
    twoFactor: false,
    turnstile: true,
  },
  billing: {
    providers: ['stripe', 'paypal'],   // 结账页展示顺序
    currency: 'usd',
    signupBonusCredits: 100,           // 用户领取时触发邮箱验证，验证完成后发放
    pastDueGraceDays: 7,               // past_due 期间保留权益的天数
    subscriptionCreditGraceHours: 24,  // 订阅积分批次在周期末之后的额外有效期
    overage: {                         // 实际消耗超出预扣时平台承担的上限，超出部分从余额补扣 / 记欠费
      maxRatio: 0.2,                   // 单次最多承担预扣额的 20%
      maxCredits: 50,                  // 单次最多承担 50 积分
      dailyBudgetPerWorkspace: 200,    // 每个空间每天最多承担 200 积分
    },
    refundWindowDays: 30,              // 可申请退款的付款时间范围；退款需人工审核，默认不主动退
  },
  ai: {
    text: true, image: true, video: true,
    // 新建模型时的默认计费方式，后台可逐个模型修改：'per_call' 按次 | 'token' 按 token | 'per_unit' 按张/秒
    defaultPricingMode: { text: 'token', image: 'per_call', video: 'per_call' },
  },
  features: {
    publicApi: false,            // API Key 调用 /api/v1
    blog: true, docs: false, waitlist: false,
  },
})
```

环境变量用 Zod 在启动时校验（`packages/config/env.ts`），缺失即报错，避免线上才发现。

## 4. 编码约定

- **ID**：主键统一用 UUIDv7（时间有序，利于索引），列类型为 PG 原生 `uuid`（16 字节，比 `text` 存储的 36 字符更省空间、索引更小）。Better Auth 通过 `advanced.database.generateId` 生成 UUIDv7，其表的 id 与外键列也改为 `uuid`（Better Auth CLI 生成的 Drizzle schema 默认是 `text`，在 `packages/db/src/schema/{auth,tenancy}.ts` 中手动调整；已验证 better-auth 1.7.7 的核心、organization、admin 等插件在 `uuid` 列上可用，无需例外，见 `packages/auth/test/auth.test.ts`）。对外暴露的 ID 与内部一致，不另设公开 ID。
- **时间**：数据库一律 `timestamptz`，服务端只处理 UTC；展示层用 `Intl.DateTimeFormat` + 用户时区。
- **金额**：整数最小货币单位（cents）+ `currency` 字段；**积分**：整数。
- **租户过滤**：业务查询必须经过 `scoped(db, workspaceId)` 帮助函数，禁止在 feature 代码里手写 `where workspace_id = ...`。
- **服务端入口**：Server Function / API route 统一走中间件链：`withSession → withWorkspace → withEntitlement → handler`。
- **错误**：业务错误用带 `code` 的 `AppError`，API 返回 `{ error: { code, message } }`，前端按 code 做 i18n。
- **外部调用**：一律经过对应 package 的接口（PaymentProvider / MediaProvider / EmailSender），不在 feature 代码里直接用第三方 SDK。
- **Webhook**：一律「验签 → 去重 → 事务处理 → 异步副作用」四步。
- **迁移**：只通过 drizzle-kit 生成的 SQL 迁移变更 schema，迁移文件纳入版本控制。
