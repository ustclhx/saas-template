import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { expect, type Page, test } from '@playwright/test'
import { getCreditBalance, grant } from '@saas/credits'
import type { Database } from '@saas/db'
import { DEFAULT_FREE_FEATURES } from '@saas/entitlements'
import { newId } from '@saas/shared'
import type { UIMessage } from 'ai'
import { drizzle } from 'drizzle-orm/postgres-js'
import templateConfig from '../../../template.config.ts'
import { APPROVE, DENY, MULTI_STEP, PARTIAL, RESUME, STOP, TAIL } from './agents/model.ts'
import { APPROVAL_TOOL } from './agents/project.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { chooseOption } from './select.ts'

test.skip(!templateConfig.plugins.agents, 'agents plugin is disabled')

type Sql = ReturnType<typeof fixtureDb>
const serverLog = new URL('../.wrangler/agents-e2e.log', import.meta.url)

async function stopDiagnostics(offset: number, conversationId: string) {
  const log = (await readFile(serverLog)).subarray(offset).toString()
  const entries = stripVTControlCharacters(log)
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.startsWith('{"level":'))
    .map(
      (line) =>
        JSON.parse(line) as {
          level: string
          event: string
          conversationId?: string
          status?: string
          errorCode?: string
        },
    )
  const end = entries.find(
    (entry) =>
      entry.event === 'agents.turn.end' &&
      entry.conversationId === conversationId &&
      entry.status === 'stopped',
  )
  if (end)
    return {
      errorEvents: entries.filter((entry) => entry.level === 'error').map((entry) => entry.event),
      errorCode: end.errorCode,
    }
}
const assistant = (page: Page) => page.getByRole('listitem', { name: 'E2E assistant', exact: true })
const sendButton = (page: Page) => page.getByRole('button', { name: 'Send', exact: true })

async function newUser(page: Page) {
  const email = `agents-e2e-${newId()}@example.com`
  await simulateClientIp(page)
  await register(page, email)
  return { email, slug: new URL(page.url()).pathname.split('/')[2] ?? '' }
}

async function startChat(page: Page, slug: string, modelId: string) {
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

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text)
  await sendButton(page).click()
}

async function grantPlan(sql: Sql, workspaceId: string, planId: string, priceId: string) {
  const id = newId()
  // 已取消但付费期仍有效，使用真实套餐权益且无需接入支付渠道。
  await sql`insert into subscription (id,workspace_id,plan_id,plan_price_id,provider,
    provider_subscription_id,status,current_period_start,current_period_end,cancel_at_period_end,canceled_at,last_event_at)
    values (${id},${workspaceId},${planId},${priceId},'stripe',${`e2e:${id}`},
    'canceled',now(),now()+interval '1 day',true,now(),now())`
}

async function workspace(sql: Sql, slug: string) {
  const [row] = await sql<{ id: string }[]>`select id from organization where slug = ${slug}`
  if (!row) throw new Error('E2E workspace missing')
  return row.id
}

function messagesPath(id: string) {
  return `/agents/agent-conversation/${id}/get-messages`
}

async function lastReply(page: Page, id: string) {
  const response = await page.request.get(messagesPath(id))
  expect(response.status()).toBe(200)
  const messages = (await response.json()) as UIMessage[]
  return messages.findLast((message) => message.role === 'assistant')
}

test('agents run tools, wait for approval, stop and reconnect with real local state', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000)
  const sql = fixtureDb()
  const db = drizzle(sql) as Database
  const modelId = newId()
  const modelKey = `agents-e2e-${modelId}`
  const planId = newId()
  const priceId = newId()
  const evidence = resolve(
    process.env.EVIDENCE_DIR ??
      fileURLToPath(new URL('../../../test-results/evidence', import.meta.url)),
    'add-ai-agents',
    '6.3-local-e2e',
  )
  const screenshots = new Map<string, Buffer>()
  const capture = async (name: string, activePage = page) => {
    screenshots.set(name, await activePage.screenshot())
  }

  try {
    const owner = await newUser(page)
    const workspaceId = await workspace(sql, owner.slug)
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
    await grantPlan(sql, workspaceId, planId, priceId)
    await grant(db, { workspaceId, source: 'admin', sourceRef: modelKey, amount: 100 })

    const id = await test.step('Create a conversation from the agent list', () =>
      startChat(page, owner.slug, modelId))
    const turns = () => sql`select t.status, t.steps, t.credits_charged, h.status as hold_status
      from ai_agent_turn t join credit_hold h on h.id = t.hold_id
      where t.conversation_id = ${id} order by t.id`

    await test.step('Run two real workspace tools in one turn', async () => {
      await send(page, MULTI_STEP)
      const reply = assistant(page).last()
      await expect(reply).toContainText('Both workspace tools returned results.')
      await expect(reply.getByText('Check the time')).toBeVisible()
      await reply.getByRole('button', { name: /List workspace files/ }).click()
      await expect(reply.getByText('0 files', { exact: true })).toBeVisible()
      await expect
        .poll(turns)
        .toEqual([{ status: 'completed', steps: 3, credits_charged: 6, hold_status: 'captured' }])
      await capture('multi-step')
    })

    // 先让冷启动的 SSR 路由完成一次渲染，再测下一次刷新期间的真实续流。
    await expect(async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 })
      await expect(assistant(page).last()).toContainText('Both workspace tools returned results.')
    }).toPass({ timeout: 90_000 })

    for (const scenario of [
      {
        prompt: APPROVE,
        decision: 'Approve and run',
        reply: 'The approved tool returned the note.',
      },
      { prompt: DENY, decision: 'Deny', reply: 'The tool was denied.' },
    ]) {
      await test.step(scenario.decision, async () => {
        const before = (await turns()).length
        await send(page, scenario.prompt)
        const card = page.getByRole('group', { name: `Approval needed: ${APPROVAL_TOOL}` })
        await expect(card.getByText(scenario.prompt, { exact: true })).toBeVisible()
        await expect
          .poll(async () => (await turns()).at(-1))
          .toMatchObject({
            status: 'running',
            hold_status: 'held',
          })
        expect((await lastReply(page, id))?.parts).toContainEqual(
          expect.objectContaining({ type: `tool-${APPROVAL_TOOL}`, state: 'approval-requested' }),
        )
        if (scenario.prompt === APPROVE) await capture('approval-requested')
        await card.getByRole('button', { name: scenario.decision, exact: true }).click()
        await expect(assistant(page).last()).toContainText(scenario.reply)
        await expect(card).toHaveCount(0)
        await expect
          .poll(async () => (await turns()).at(-1))
          .toMatchObject({
            status: 'completed',
            hold_status: 'captured',
            credits_charged: 4,
          })
        expect(await turns()).toHaveLength(before + 1)
        expect((await lastReply(page, id))?.parts).toContainEqual(
          expect.objectContaining(
            scenario.prompt === APPROVE
              ? {
                  type: `tool-${APPROVAL_TOOL}`,
                  state: 'output-available',
                  output: { savedNote: scenario.prompt },
                }
              : { type: `tool-${APPROVAL_TOOL}`, state: 'output-denied' },
          ),
        )
        await capture(scenario.prompt === APPROVE ? 'approved' : 'denied')
      })
    }

    await test.step('Stop during the second step without logging an error', async () => {
      await send(page, STOP)
      const reply = assistant(page).last()
      await expect(reply).toContainText(PARTIAL)
      const logOffset = (await stat(serverLog)).size
      await page.getByRole('button', { name: 'Stop', exact: true }).click()
      await expect(reply).toContainText('Stopped')
      await expect(reply).toContainText(PARTIAL)
      await expect(reply).not.toContainText(TAIL)
      await expect.poll(async () => (await turns()).at(-1)?.status).toBe('stopped')
      await expect
        .poll(() => stopDiagnostics(logOffset, id))
        .toStrictEqual({
          errorEvents: [],
          errorCode: undefined,
        })
      await capture('stopped')
    })

    await test.step('Reload while streaming and receive the rest of the same reply', async () => {
      const before = (await turns()).length
      await send(page, RESUME)
      await expect(assistant(page).last()).toContainText(PARTIAL)
      await Promise.all([
        page.waitForEvent('websocket', {
          predicate: (socket) =>
            new URL(socket.url()).pathname === `/agents/agent-conversation/${id}`,
          timeout: 25_000,
        }),
        page.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 }),
      ])
      expect((await turns()).at(-1)?.status).toBe('running')
      await expect(assistant(page).last()).toContainText(`${PARTIAL} ${TAIL}`, {
        timeout: 40_000,
      })
      await expect.poll(async () => (await turns()).at(-1)?.status).toBe('completed')
      expect(await turns()).toHaveLength(before + 1)
      await capture('resumed')
    })

    const outsider = await browser.newContext()
    try {
      const otherPage = await outsider.newPage()
      const other = await newUser(otherPage)
      const otherWorkspace = await workspace(sql, other.slug)

      await test.step('Another member receives 404 for the page and messages endpoint', async () => {
        const [otherUser] = await sql<
          { id: string }[]
        >`select id from "user" where email = ${other.email}`
        if (!otherUser) throw new Error('Second E2E user missing')
        await sql`insert into member (id,organization_id,user_id,role)
          values (${newId()},${workspaceId},${otherUser.id},'member')`
        const deniedPage = await otherPage.goto(`/app/${owner.slug}/agents/${id}`)
        expect(deniedPage?.status()).toBe(404)
        await expect(
          otherPage.getByRole('heading', { name: 'Conversation not found' }),
        ).toBeVisible()
        const deniedMessages = await otherPage.request.get(messagesPath(id))
        expect(deniedMessages.status()).toBe(404)
        expect(await deniedMessages.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
        await capture('not-found', otherPage)
      })

      await test.step('Zero balance shows the credits prompt without starting a turn', async () => {
        expect(await getCreditBalance(db, otherWorkspace)).toMatchObject({ available: 0, held: 0 })
        await grantPlan(sql, otherWorkspace, planId, priceId)
        const otherId = await startChat(otherPage, other.slug, modelId)
        await send(otherPage, MULTI_STEP)
        await expect(otherPage.getByRole('dialog', { name: 'Insufficient credits' })).toBeVisible()
        expect(
          await sql`select id from ai_agent_turn where conversation_id = ${otherId}`,
        ).toHaveLength(0)
        expect((await lastReply(otherPage, otherId))?.parts ?? []).toHaveLength(0)
        await capture('insufficient-credits', otherPage)
      })
    } finally {
      await outsider.close()
    }

    // 只归档成功运行的合成截图与脱敏汇总，避免保存 cookie、跟踪记录或数据库连接配置。
    await mkdir(evidence, { recursive: true })
    for (const [name, screenshot] of screenshots)
      await writeFile(resolve(evidence, `${name}.png`), screenshot)
    await writeFile(
      resolve(evidence, 'result.json'),
      `${JSON.stringify(
        {
          passedAt: new Date().toISOString(),
          model: 'local scripted replacement',
          otherMember: { page: 404, messages: 404 },
          insufficientCredits: { available: 0, turns: 0 },
          turns: await turns(),
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    try {
      await sql`update ai_model set enabled = false where id = ${modelId}`
    } finally {
      await sql.end()
    }
  }
})
