import { type AuthEmail, createAuth, type SendAuthEmail } from '@saas/auth'
import { grantSignupBonus } from '@saas/billing'
import { createDb, type Database } from '@saas/db'
import { createQueueAuthEmailSender, userLocaleByEmail } from './auth-email.ts'
import { templateConfig } from './template-config.ts'
import { resolveWorkspaceMaxSeats } from './workspace-data.ts'

/**
 * 按请求创建 Better Auth 实例（design.md 决策 1）：每个请求使用该请求的数据库客户端，
 * 不缓存到模块作用域。认证邮件投递到 EMAIL_QUEUE，由 apps/jobs 渲染并按 EMAIL_TRANSPORT 发送
 * （tasks.md 3.2）；用户请求只等待入队。
 * 同一请求中已有数据库客户端时可传入复用（如 withSession、requireFreshSession），避免多建一个连接；否则新建一个。
 */
export function getAuth(env: Cloudflare.Env, db: Database = createDb(env.HYPERDRIVE)) {
  const queued = createQueueAuthEmailSender({
    queue: env.EMAIL_QUEUE,
    appName: templateConfig.app.name,
    appUrl: env.APP_URL,
    resolveLocale: userLocaleByEmail(db),
  })
  // `vite dev` 下额外打印完整消息，便于本地点击验证链接、查看验证码（jobs 的 log 通道不记录链接与验证码）
  const sendEmail: SendAuthEmail = import.meta.env.DEV
    ? async (email: AuthEmail) => {
        console.log('[dev] auth email', email)
        await queued(email)
      }
    : queued
  return createAuth(env, db, {
    config: templateConfig,
    sendEmail,
    resolveMaxSeats: resolveWorkspaceMaxSeats,
    onEmailVerified: (user) =>
      grantSignupBonus({ db, userId: user.id, config: templateConfig.billing }),
  })
}
