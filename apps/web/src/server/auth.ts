import { type AuthEmail, createAuth, type SendAuthEmail } from '@saas/auth'
import { createDb } from '@saas/db'
import { templateConfig } from './template-config.ts'

/**
 * TODO(3.2): 认证邮件改为投递 EMAIL_QUEUE，由 apps/jobs 消费并经 Resend 发送。
 * 当前为占位实现：只记录日志、不发任何邮件。生产环境只记邮件类型（不记收件人与链接 / 验证码）；
 * `vite dev` 下额外打印完整消息，便于本地点击验证链接、查看验证码。
 */
export const sendAuthEmail: SendAuthEmail = async (email: AuthEmail) => {
  console.log(JSON.stringify({ event: 'auth.email.not_sent', type: email.type }))
  if (import.meta.env.DEV) console.log('[dev] auth email', email)
}

/**
 * 按请求创建 Better Auth 实例（design.md 决策 1）：每个请求使用该请求的数据库客户端，
 * 不缓存到模块作用域。
 */
export function getAuth(env: Cloudflare.Env) {
  return createAuth(env, createDb(env.HYPERDRIVE), {
    config: templateConfig,
    sendEmail: sendAuthEmail,
  })
}
