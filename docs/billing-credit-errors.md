# 余额不足合同与聊天接线

`@saas/shared` 导出 `INSUFFICIENT_CREDITS`、`InsufficientCreditsDetails`、
`insufficientCreditsError(estimatedCredits, availableCredits)` 和
`parseInsufficientCredits(value)`。构造器返回 HTTP 402 的 `AppError`，公共响应为：

```json
{"error":{"code":"INSUFFICIENT_CREDITS","message":"Insufficient credits","details":{"estimatedCredits":8,"availableCredits":2}}}
```

两个数值必须是非负安全整数。序列化只复制这两个字段；其他内部 details、cause
以及其他错误码的 details 均不公开。解析器是浏览器可用纯函数，支持公共响应对象、
AppError、JSON 字符串以及聊天 SDK 将响应正文包装后的 `Error.message`；不完整或
非法数值、其他 code 返回 `undefined`。

通用 `hold` 在空间锁内读取全部仍可用的积分后抛出 `CreditsError`，该类型继承
`AppError`，保留现有 `instanceof CreditsError` 与 code 判断。`estimatedCredits`
是请求预扣额，`availableCredits` 是竞争结束后锁内的实际余额。媒体接口保留这份详情。
聊天预算的预计消耗是请求输入与最小输出对应的成本（按次模型为固定成本），
并发预扣失败则采用 hold 的最新数值。欠费仍使用独立 `CREDIT_DEBT` 错误。

聊天 `ChatPage` 解析 SDK 错误并保留原有错误提示。
`InsufficientCreditsGuide({ slug, details })` 为 UI 8.6 的纯展示替换接口，显示预计消耗、
可用余额，并链接到 `/app/$slug/billing#credit-packs` 和
`/app/$slug/billing#subscriptions`。替换该组件即可调整视觉，无需重做解析或请求逻辑。
