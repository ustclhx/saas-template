# W3 后台重放与 PayPal 登录交接

staging health 与远端 main 均为 `a2381f875fbd8b1009e48f7024addcb25285aca9`，数据库正常。复用已登录的真实平台管理员浏览器会话，未执行登录、模拟用户或修改角色。

## 1.1 已通过

管理员在 `/admin/billing/webhooks` 找到受控平台事件 `evt_1URbLcL3UTpBAoXoPo2JjN1L`（持久 UUID `01a14ae5-035b-77c0-b03b-4aa9075d5aa9`），只点击该行一次 `Replay failed event`。页面实际显示 `Replay failed; record remains available for retry.`，attempts 从 3 增至 4。

`w3-admin-replay-before.json` / `after.json` 保存独立只读前后证据。新增 `billing.webhook_replay_requested` 审计 `01a14d88-cd77-764e-98c9-64b3250f8ffc`，付款、订阅、批次、账本、退款、补偿六类业务表的计数与白名单摘要完全不变；两个观察空间的完整付款/批次/账本快照相同，同快照对账差额均为 0。刻意缺少 metadata 的事件仍 failed 是实际结果，不声称成功恢复 processed 或处理真实付款。受控来源及零付款试用资源的取消证据见前一日 W3 记录；没有新增应用失败机制、部署、密钥修改或账务直写。

## PayPal：登录阻塞

打开 `https://www.sandbox.paypal.com/myaccount/home` 后，浏览器实际跳转到同一 Sandbox 的 `/signin`，标题为“登录您的PayPal账户”。按用户规则立即停止，没有输入用户名、密码、二次验证或验证码，也没有新建 PayPal Checkout、批准、付款、退款或取消既有订阅。登录页已标记交接，供用户亲自使用 Sandbox personal 买家登录；不得登录真实钱包代替。

浏览器已释放。任务 2.1 和 3.2 保持未完成，PR 继续为草稿，工作卡片保持 in-progress 并标注登录阻塞。接收器、quick tunnel 和日志监听均未启动；无需清理新 PayPal 资源。用户登录并由协调者恢复浏览器窗口后，再执行新的月付/年付/重叠期订阅和 Sale 部分/全额退款录制及回归。
