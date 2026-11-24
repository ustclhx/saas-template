import { expect, type Page } from '@playwright/test'
import { grant } from '@saas/credits'
import type { Database } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { newId } from '@saas/shared'
import type { UIMessage } from 'ai'
import { drizzle } from 'drizzle-orm/postgres-js'
import { type fixtureDb, register, simulateClientIp } from '../fixtures.ts'
import { chooseOption } from '../select.ts'

// agents 本地 e2e 共用的步骤：注册、套餐与模型夹具、新建对话、发送消息与读取实例消息。

export type Sql = ReturnType<typeof fixtureDb>

export const assistant = (page: Page) =>
  page.getByRole('listitem', { name: 'E2E assistant', exact: true })
export const sendButton = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })

export async function newUser(page: Page) {
  const email = `agents-e2e-${newId()}@example.com`
  await simulateClientIp(page)
  await register(page, email)
  return { email, slug: new URL(page.url()).pathname.split('/')[2] ?? '' }
}

export async function startChat(page: Page, slug: string, modelId: string) {
  await page.goto(`/app/${slug}/agents`)
  const dialog = page.getByRole('dialog', { name: 'New agent conversation' })
  await expect(async () => {
    if (!(await dialog.isVisible()))
      await page.getByRole('button', { name: 'New conversation', exact: true }).first().click()
    await expect(dialog).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 15_000 })
  await expect(dialog.getByRole('button', { name: /^E2E assistant/, pressed: true })).toBeVisible()
  await chooseOption(dialog.getByRole('combobox', { name: 'Model', exact: true }), {
    value: modelId,
  })
  await dialog.getByRole('button', { name: 'Start conversation' }).click()
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}$/)
  return new URL(page.url()).pathname.split('/').at(-1) ?? ''
}

export async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await sendButton(page).click()
}

export async function grantPlan(sql: Sql, workspaceId: string, planId: string, priceId: string) {
  const id = newId()
  // 已取消但付费期仍有效，使用真实套餐权益且无需接入支付渠道。
  await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
    provider_subscription_id,status,current_period_start,current_period_end,cancel_at_period_end,canceled_at,last_event_at)
    values (${id},${workspaceId},${planId},${priceId},'stripe',${`e2e:${id}`},
    'canceled',now(),now()+interval '1 day',true,now(),now())`
}

export async function workspace(sql: Sql, slug: string) {
  const [row] = await sql<{ id: string }[]>`select id from organization where slug = ${slug}`
  if (!row) throw new Error('E2E workspace missing')
  return row.id
}

export function messagesPath(id: string) {
  return `/agents/agent-conversation/${id}/get-messages`
}

export async function lastReply(page: Page, id: string) {
  const response = await page.request.get(messagesPath(id))
  expect(response.status()).toBe(200)
  const messages = (await response.json()) as UIMessage[]
  return messages.findLast((message) => message.role === 'assistant')
}

/** 支持工具调用的脚本化模型与只授权该模型的套餐；返回清理函数 */
export async function modelFixture(sql: Sql) {
  const modelId = newId()
  const modelKey = `agents-e2e-${modelId}`
  const planId = newId()
  const priceId = newId()
  await sql`insert into ai_model
    (id,key,kind,provider,provider_model_id,pricing,params_schema,supports_tools,sort)
    values (${modelId},${modelKey},'text','mock','agents-e2e',
      ${JSON.stringify({
        mode: 'per_call',
        credits: 2,
        limits: { maxInputTokens: 20_000, maxOutputTokens: 1_000 },
      })}::jsonb,'{}',true,-1000)`
  await sql`insert into plan (id,key,name,type,credits,features,sort,active)
    values (${planId},${modelKey},'Agents E2E','subscription',0,
      ${JSON.stringify({ ...DEFAULT_FREE_FEATURES, models: [modelKey] })}::jsonb,1000,false)`
  await sql`insert into plan_price (id,plan_id,provider,provider_price_id,interval,amount,currency,active)
    values (${priceId},${planId},'stripe',${`e2e:${priceId}`},'month',0,'usd',false)`
  return {
    modelId,
    modelKey,
    /** 给空间授予该套餐与积分 */
    async enable(workspaceId: string, credits: number) {
      await grantPlan(sql, workspaceId, planId, priceId)
      if (credits > 0)
        await grant(drizzle(sql) as Database, {
          workspaceId,
          source: 'admin',
          sourceRef: modelKey,
          amount: credits,
        })
    },
    grantPlan: (workspaceId: string) => grantPlan(sql, workspaceId, planId, priceId),
    disable: () => sql`update ai_model set enabled = false where id = ${modelId}`,
  }
}
