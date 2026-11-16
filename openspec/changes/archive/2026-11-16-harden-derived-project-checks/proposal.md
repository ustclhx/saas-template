# Proposal

## Why

衍生项目 xuanxue-saas 第一次在项目中跑通全量离线 e2e 与 Nightly，暴露出模板的端到端用例与两个组件只在模板默认配置下成立：用例写死了默认开关、服务商与浮动控件，
用例之间共享价格缓存与夹具套餐状态；Badge 的灰色实心底用了品牌层常改写的 `--accent`；Select 外层包装会被长文字撑开；Nightly 的多空间任务在
多租户关闭的衍生项目里必然失败。项目只能在模板文件上加「项目修正」，下一次 template-sync 就会冲突。

## What Changes

- **e2e 用例按项目配置运行**（`apps/web/e2e`）：
  - share-cards：卡片地址 `v=` 接受项目字体 / 站点覆盖产生的可选指纹段；
  - signup-bonus：`billing.signupBonusCredits` 为 0 时跳过；
  - analytics：答案页用例按 `features.guides` 跳过；
  - admin-model-params、ai-media：Workers AI 用例只在 `ai.mediaProviders` 含 `workers-ai` 且 wrangler 配置有 AI 绑定时运行，否则跳过；
  - floating-controls：页面没有声明浮动控件（`body[data-floating-controls]`）时跳过；
  - 价格目录：e2e globalSetup 先写入目录夹具，再启动用例，结果不依赖执行顺序；
  - admin-billing：夹具套餐在用例结束时停用。
- **Badge 中性底**：新增设计 token `--neutral-fill`（浅色 / 深色与当前 `--accent` 取值相同），灰色实心 Badge 改用它；品牌层改写 `--accent` 不再影响中性徽标。
- **SelectTrigger**：外层包装默认 `min-w-0`，放进 grid / flex 列时长文字不再撑开所在列。
- **Nightly**：`e2e-multi-tenant` 在衍生项目（有 `.template-base.json`）且项目未开启 `multiTenant` 时跳过，模板仓库照常运行。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `design-system`：新增中性填充 token 要求；Select 触发器不撑开所在列。
- `project-bootstrap`：新增「衍生项目的端到端与 Nightly 检查按项目配置运行」要求。

## Impact

- 代码：`apps/web/e2e/*`（share-cards、signup-bonus、analytics、admin-model-params、ai-media、floating-controls、admin-billing、globalSetup）、
  `packages/ui/src/{styles/globals.css,components/badge.tsx,components/select.tsx}`、`.github/workflows/nightly.yml`、`docs/design-system.md`。
- 衍生项目：同步后可删除对应的「项目修正」；升级说明给出对照。
- 不改数据库与运行时行为。
