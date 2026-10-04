import { env } from 'cloudflare:workers'
import { createAuth } from '@saas/auth'
import { defineTemplateConfig } from '@saas/config'
import { createDb } from '@saas/db'
import { type EmailQueueMessage, parseEmailQueueMessage } from '@saas/email/queue'
import { newId } from '@saas/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createQueueAuthEmailSender, userLocaleByEmail } from '../src/server/auth-email.ts'

// tasks.md 3.2：认证邮件只入队，用户请求不受邮件服务影响（specs/user-auth「邮件服务暂时不可用」）。
// 在 workerd 中经 Hyperdrive 连接本地 PG；Resend 由 mock fetch 模拟为 503，不访问任何外部服务。
// 消息在队列中的重试与最终发送见 apps/jobs/test/email-queue.test.ts。

const APP_URL = 'http://localhost:3000'
const testEnv = {
  BETTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnopqrstuvwxyz',
  APP_URL,
}
const EMAIL_DOMAIN = `${newId()}.web-email-test.example`
let startedAt = new Date()

function setup() {
  const db = createDb(env.HYPERDRIVE)
  const queued: EmailQueueMessage[] = []
  const auth = createAuth(testEnv, db, {
    config: defineTemplateConfig({
      app: { name: 'TestApp', url: APP_URL, supportEmail: 'support@example.test' },
      // 本测试只验证邮件入队；Turnstile 与限流由 packages/auth 的 protection 测试覆盖
      auth: { oauth: [], turnstile: false },
    }),
    sendEmail: createQueueAuthEmailSender({
      queue: {
        send: async (body) => {
          queued.push(body)
        },
      },
      appName: 'TestApp',
      appUrl: APP_URL,
      resolveLocale: userLocaleByEmail(db),
    }),
  })
  const post = (path: string, body: unknown) =>
    auth.handler(
      new Request(`${APP_URL}/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP_URL },
        body: JSON.stringify(body),
      }),
    )
  return { db, queued, post }
}

beforeAll(() => {
  startedAt = new Date()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  const sql = createDb(env.HYPERDRIVE).$client
  const users = await sql<
    { id: string }[]
  >`select id from "user" where email like ${`%@${EMAIL_DOMAIN}`}`
  const ids = users.map((u) => u.id)
  await sql`delete from verification where created_at >= ${startedAt.toISOString()}`
  if (ids.length === 0) return
  await sql`delete from session where user_id in ${sql(ids)}`
  await sql`delete from account where user_id in ${sql(ids)}`
  await sql`delete from "user" where id in ${sql(ids)}`
})

describe('认证邮件入队', () => {
  it('Resend 返回 5xx 时找回密码请求仍成功，邮件以收件人语言入队', async () => {
    const resend = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"name":"internal_server_error"}', { status: 503 }))
    const { db, queued, post } = setup()
    const address = `reset-${newId()}@${EMAIL_DOMAIN}`
    const signUp = await post('/sign-up/email', {
      email: address,
      password: 'correct-horse-battery-staple',
      name: 'Test User',
    })
    expect(signUp.status).toBe(200)
    await db.$client`update "user" set locale = 'zh-CN' where email = ${address}`
    queued.length = 0

    const res = await post('/request-password-reset', { email: address, redirectTo: '/reset' })

    expect(res.status).toBe(200)
    expect(resend).not.toHaveBeenCalled()
    expect(queued).toHaveLength(1)
    const [message] = queued
    expect(parseEmailQueueMessage(message)).toEqual(message)
    expect(message).toMatchObject({
      template: 'reset-password',
      to: address,
      locale: 'zh-CN',
      appName: 'TestApp',
      props: { url: expect.stringContaining(`${APP_URL}/api/auth/reset-password/`) },
    })
  })

  it('未注册的收件人语言为 null', async () => {
    const { db } = setup()
    expect(await userLocaleByEmail(db)(`nobody-${newId()}@${EMAIL_DOMAIN}`)).toBeNull()
  })
})
