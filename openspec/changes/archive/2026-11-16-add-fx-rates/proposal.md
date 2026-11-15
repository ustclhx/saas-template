# Proposal

## Why

部分产品需要在页面上展示「约」的当地货币价格（例如按积分估算的付费内容价格）。模板目前没有统一的汇率来源，各项目只能写死参考汇率，汇率过时后估价失真。模板提供一个与平台无关的参考汇率能力，让项目可以获得每日更新的 USD 汇率，并在服务商不可用时安全回退。

## What Changes

- 新增 `@saas/shared` 的 `fx` 模块：拉取并校验 Exchange Rate API 开放端点（无需密钥）的 USD 汇率，按 12 小时缓存，失败时回退到项目提供的参考值。
- 提供服务商署名常量：使用汇率的页面须按要求显示署名链接。
- 模块只提供数据与校验，不改变支付、扣款或任何现有页面的行为。扣款金额仍以支付服务商显示的金额为准。

## Capabilities

### New Capabilities

- `fx-rates`：以 USD 为基准的参考汇率的获取、校验、缓存与回退，以及服务商署名要求。

### Modified Capabilities

无。

## Impact

- 代码：`packages/shared/src/fx.ts`、`fx.test.ts`，经 `@saas/shared/fx` 子路径导出（依赖服务端日志，不进入根入口与浏览器包）。
- 依赖：无新增依赖，使用运行时的 `fetch`、`AbortSignal.timeout` 与 `AppError`。
- 外部：运行时会请求 `https://open.er-api.com/v6/latest/USD`（每 12 小时至多一次，每个运行实例）。
- 运营：项目若使用汇率展示，必须按服务商要求显示署名链接；本变更不改变任何页面。
