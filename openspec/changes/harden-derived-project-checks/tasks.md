# Tasks

## 1. e2e 用例按项目配置运行（一个分支）

- [x] 1.1 share-cards：`v=` 指纹正则接受可选段（项目字体 / 站点覆盖）。验证：用例在模板默认与带覆盖的夹具下都通过。
- [x] 1.2 signup-bonus：`signupBonusCredits` 为 0 时跳过；analytics 答案页用例按 `features.guides` 跳过。验证：改配置后本地运行显示跳过原因。
- [x] 1.3 admin-model-params、ai-media：Workers AI 用例按 `ai.mediaProviders` 与 wrangler `ai` 绑定决定（D1）。验证：单独运行两个 spec 通过。
- [x] 1.4 floating-controls：页面无 `body[data-floating-controls]` 时跳过。验证：spec 通过。
- [x] 1.5 globalSetup 写入价格目录夹具（D2），admin-billing 夹具套餐结束时停用。验证：`playwright test e2e/billing-pages.spec.ts e2e/admin-billing.spec.ts` 在两种顺序下都通过。

## 2. 组件（一个分支）

- [x] 2.1 新增 `--neutral-fill`（浅 / 深与 `--accent` 同值），Badge 灰色实心改用；`docs/design-system.md` 记录（D3）。验证：badge 单测断言 `var(--neutral-fill)`；模板外观不变。
- [x] 2.2 SelectTrigger 外层包装与触发器加 `min-w-0`，长文字截断。验证：select 单测断言类名。

## 3. Nightly

- [x] 3.1 `e2e-multi-tenant` 在衍生项目且未开启 `multiTenant` 时跳过（D4）。验证：用 `act` 不可用时以脚本单测判断逻辑，模板仓库条件为运行。

## 4. 发版

- [x] 4.1 升级说明 `docs/upgrades/0.5.7.md`：列出衍生项目可删除的「项目修正」对照；`template-release.mjs check` 通过。
