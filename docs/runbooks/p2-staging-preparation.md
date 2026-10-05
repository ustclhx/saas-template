# P2 staging 准备记录（2026-10-05）

用户已同意进入真实支付联通阶段。P1 归档保持完成；P2 仍为 28/34，本文只记录已执行的部署准备，不作为剩余六项的平台验收证据。

## 发布基线与结果

- [PR #24](https://github.com/ustclhx/saas-template/pull/24) 已 squash 合并，main 为 `458fafdef81cf30cc41516eec15fc4d1e7122725`；[合并后的 CI](https://github.com/ustclhx/saas-template/actions/runs/37259755499) 通过。
- staging 数据库 `saas_staging` 应用 0002–0007，共 8 条迁移记录；新增 `payment_refund`、`billing_compensation` 等表已确认。共享开发库、生产库未迁移。
- `billing:seed` 写入 free/pro/team/credit_pack 四个模板套餐，两家平台各 5 条报价。10 条报价全部 inactive，尚未同步平台价格。
- 创建 `events-staging`（ID `79fc85a8db4843d89c3068cce811df76`），发布后有 1 个 producer / 1 个 consumer；保留已有 `email-staging`。
- 按 jobs → web 发布；Jobs 版本 `91bdd92a-1ffd-4fc8-9672-ecec303045f0`，Web 版本 `6c9cf30a-05fa-4e28-8ab4-976424fee830`。
- 已移除合并后的 `p2-integration` Orca worktree 与 `saas_wt_p2_integration` 测试库。联通文档子任务完成整合后同样清理。

执行命令（连接只指向 staging 本机库）：

```bash
MIGRATION_DATABASE_URL=postgres://migrator:migrator@localhost:5432/saas_staging pnpm --filter @saas/db db:migrate
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://app:app@localhost:5432/saas_staging pnpm billing:seed
pnpm --dir apps/web exec wrangler queues create events-staging --env staging
pnpm --filter @saas/jobs deploy:staging
pnpm --filter @saas/web deploy:staging
```

队列已存在后跳过 create；发布顺序与配置见 [Cloudflare 官方 Queues 配置说明](https://developers.cloudflare.com/queues/configuration/configure-queues/)。

## 冒烟验证

- `/api/health`、`/pricing`、`/login` 均返回 200，数据库 up；新 Jobs 心跳为 `2026-10-05T03:35:26.799Z`，晚于本次 Jobs 发布。
- 实际浏览器显示四个套餐和“Payments are currently unavailable”；Stripe、PayPal 两个选择项均禁用，没有公开 checkout/pay now 按钮。
- 匿名访问客户账单和用量页跳转登录；后台计费页返回 404，未渲染计费后台。
- 无凭据时 POST 两家 webhook 入口返回 503，未知 provider 返回 404；探测后 `webhook_event` 仍为 0。没有伪造已验签平台事件或付款记录。
- Jobs HTTP 返回既定 404，事件队列 producer/consumer 绑定均已确认。真实计费消息消费、平台回调和新计费 Cron 的业务场景仍需联通验收。

## 当前门槛与后续

尚未发现受保护本地文件、进程环境或 staging secret 名单中的 Stripe/PayPal 测试凭据。用户凭据准备状态待回复；不在聊天、日志或 git 中传递密钥。未执行 `billing:sync`、付款、退款或真实平台回调录制。

准备凭据后按 [支付联通步骤](p2-payment-integration.md) 配置两个 Worker、同步报价并复验幂等，再走测试卡、测试时钟和 PayPal 沙箱的完整业务场景。完成 tasks 1.3、3.2、3.3、10.1、10.4、11.1，回写 Q4/Q5/Q6 后才归档 P2。OAuth 继续 mock，邮件继续 log；不接入 live/production。
