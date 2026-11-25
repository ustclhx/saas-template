# 管理员无法完成重新验证（step-up 救援）

后台敏感操作（退款、积分调整、封禁、模拟登录、创建管理员令牌、改密钥设置等）要求当前会话在
最近若干分钟内重新验证（[认证文档 §2「后台重新验证」](../04-auth-and-tenancy.md#后台重新验证step-up)）。
登录与只读后台页面从不要求重新验证，所以下列任何情况下管理员都能进入后台查看，只是不能执行敏感操作。

本 runbook 按从轻到重的顺序处理。每一步都需要部署环境的写权限或管理员本人的手段，被盗会话无法触发。

## 0. 先判断属于哪种情况

在后台触发一次敏感操作，看验证弹窗列出的方式（或调用 `getStepUpStatus`）：

| 弹窗显示 | 含义 | 处理 |
|---|---|---|
| 邮箱验证码 / 密码 | 账号未开启两步验证 | 用邮箱验证码；邮件发不出时用密码。都不行看 §3 |
| 验证器 / 备用码 | 账号已开启两步验证 | 用验证器；设备丢失用备用码（§1）；都没有看 §2 |
| 「已锁定，HH:MM 后重试」 | 连续失败 5 次，账号锁定 15 分钟 | 等待解锁，不需要运维介入 |
| 没有可用方式 | 邮箱未验证且没有密码、未开两步验证 | §3 |

## 1. 用备用码

开启两步验证时生成的备用码每个只能用一次。在弹窗中选「备用码」输入其中一个即可。
用完后到账号设置重新生成备用码，或重置两步验证。

## 2. 开启救援开关（丢失验证器与全部备用码）

前提：该管理员的邮箱已验证，并且在部署环境的 `BOOTSTRAP_ADMIN_EMAILS` 名单内。
名单外的管理员见 §3。

1. 运维为 web Worker 设置救援开关（每个环境分别设置；命令会创建并立即部署新版本）：

   ```bash
   cd apps/web
   pnpm exec wrangler secret put ADMIN_STEP_UP_RESCUE --env staging   # 输入 1
   ```

   自托管：在 web 服务的环境变量中加入 `ADMIN_STEP_UP_RESCUE=1` 并重启 web。
   出处：[Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)（核对日期 2026-11-25）。

2. 开关生效后，后台所有页面顶部显示红色救援警示条。名单内的管理员在验证弹窗中多出「救援验证码」，
   验证码发往其已验证邮箱，10 分钟内有效。
3. 每次救援验证都会：写审计 `admin.step_up.verified`（`meta.method = rescue`），并向运营通知渠道
   （Telegram / Discord，见后台「运营设置」）发送一条 `admin.step_up.rescue` 通知。收到通知后确认是预期中的操作。
4. 管理员完成需要的操作后，到账号设置重置两步验证（重新绑定验证器并保存新的备用码）。

### 关闭救援开关（必须执行）

问题解决后立即删除密钥，警示条随之消失：

```bash
cd apps/web
pnpm exec wrangler secret delete ADMIN_STEP_UP_RESCUE --env staging
pnpm exec wrangler secret list --env staging   # 确认列表中已无 ADMIN_STEP_UP_RESCUE
```

自托管：从环境变量中删除该项并重启 web。在审计日志中按 `admin.step_up.verified` 筛选，
核对开关开启期间的全部 `rescue` 验证都是预期的。

## 3. 邮箱也不可用：用引导名单提升新账号

沿用首次运行的管理员引导（`packages/auth/src/admin-bootstrap.ts`，只提升、不降权）：

1. 用另一个能收信的邮箱注册并完成邮箱验证。
2. 运维把该邮箱加入 `BOOTSTRAP_ADMIN_EMAILS`（Wrangler secret 或自托管环境变量）。
3. 新账号下次登录即被提升为管理员（审计 `admin.user.bootstrap`）。新账号未开两步验证，可用邮箱验证码完成重新验证。
4. 用新账号处理旧账号（如封禁旧账号），然后视需要把旧邮箱移出名单。

## 4. 记录

在私有证据库记录处理经过（时间、涉及账号的审计 ID、开关开启与关闭时间），本仓库只引用，不写真实邮箱或账号 ID。
