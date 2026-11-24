import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { expect, type Page, test } from '@playwright/test'
import { newId } from '@saas/shared'
import templateConfig from '../../../template.config.ts'
import {
  assistant,
  lastReply,
  messagesPath,
  modelFixture,
  newUser,
  type Sql,
  send,
  startChat,
  workspace,
} from './agents/helpers.ts'
import { ASYNC, MULTI_STEP, SUBMITTED } from './agents/model.ts'
import { ASYNC_TOOL } from './agents/project.ts'
import { fixtureDb } from './fixtures.ts'

// openspec add-ai-agents 7.1、8.2 的本地浏览器验收：真实 Worker、Durable Object 实例、alarm 与 PG。
// 8.2：工具返回 pending 后，实例按 alarm 退避轮询 ai_task，终态时把结果写回同一工具调用，不调用模型、不计费。
// 7.1：从列表删除对话后，服务端函数经 Durable Object 绑定请求实例清理，实例核对 PG 后 destroy()。
// 两个场景各自一个用例，互不共享超时（8.2 需要等待 alarm 退避）。

test.skip(!templateConfig.plugins.agents, 'agents plugin is disabled')

const serverLog = new URL('../.wrangler/agents-e2e.log', import.meta.url)
const evidenceDir = resolve(
  process.env.EVIDENCE_DIR ??
    fileURLToPath(new URL('../../../test-results/evidence', import.meta.url)),
  'add-ai-agents',
  '7-lifecycle',
)

/** 本次测试开始后的服务端结构化日志（只取指定对话的事件） */
async function serverEvents(offset: number, conversationId: string) {
  const log = (await readFile(serverLog)).subarray(offset).toString()
  return stripVTControlCharacters(log)
    .split('\n')
    .map((line) => line.replace(/^.*?(\{"level":)/, '$1'))
    .filter((line) => line.startsWith('{"level":'))
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
    .filter((entry) => entry.conversationId === conversationId)
}

/** 截图与结果摘要写入证据目录（主仓库只引用，不提交） */
async function saveEvidence(
  name: string,
  screenshots: Map<string, Buffer>,
  result: Record<string, unknown>,
) {
  await mkdir(evidenceDir, { recursive: true })
  for (const [shot, screenshot] of screenshots)
    await writeFile(resolve(evidenceDir, `${name}-${shot}.png`), screenshot)
  await writeFile(
    resolve(evidenceDir, `${name}.json`),
    `${JSON.stringify({ passedAt: new Date().toISOString(), model: 'local scripted replacement', ...result }, null, 2)}\n`,
  )
}

const eventSummary = (events: Record<string, unknown>[]) =>
  events.map((entry) => ({
    level: entry.level,
    event: entry.event,
    reason: entry.reason,
    resolved: entry.resolved,
    remaining: entry.remaining,
    status: entry.status,
  }))

async function setup(sql: Sql, page: Page) {
  const fixture = await modelFixture(sql)
  const owner = await newUser(page)
  const workspaceId = await workspace(sql, owner.slug)
  await fixture.enable(workspaceId, 100)
  return { fixture, owner, workspaceId }
}

test('agent instances write back async task results without a new turn', async ({ page }) => {
  test.setTimeout(180_000)
  const sql = fixtureDb()
  const screenshots = new Map<string, Buffer>()
  const capture = async (name: string) => {
    screenshots.set(name, await page.screenshot())
  }
  const summary: Record<string, unknown> = {}
  let disable: (() => Promise<unknown>) | undefined

  try {
    const { fixture, owner, workspaceId } = await setup(sql, page)
    disable = fixture.disable
    const logOffset = (await stat(serverLog)).size
    const id = await startChat(page, owner.slug, fixture.modelId)
    const turns = () =>
      sql<{ status: string; credits_charged: number }[]>`
        select status, credits_charged from ai_agent_turn where conversation_id = ${id} order by id`
    const ledger = async () => {
      const [row] = await sql<{ entries: number; holds: number }[]>`
        select (select count(*)::int from credit_ledger where workspace_id = ${workspaceId}) as entries,
               (select count(*)::int from credit_hold where workspace_id = ${workspaceId}) as holds`
      return row
    }
    const toolOutput = async () =>
      (
        (await lastReply(page, id))?.parts.find((item) => item.type === `tool-${ASYNC_TOOL}`) as
          | { state?: string; output?: { taskId?: string; status?: string } }
          | undefined
      )?.output

    const taskId =
      await test.step('A tool submits a background task and returns pending', async () => {
        await send(page, ASYNC)
        await expect(assistant(page).last()).toContainText(SUBMITTED)
        await expect.poll(turns).toEqual([{ status: 'completed', credits_charged: 4 }])
        const output = await toolOutput()
        expect(output).toMatchObject({ status: 'pending' })
        await capture('task-pending')
        return output?.taskId ?? ''
      })

    await test.step('The instance polls ai_task and writes the result back without a new turn', async () => {
      // 轮次结束 5 秒后实例第一次轮询，任务仍在运行，按退避继续；之后再模拟媒体 Workflow 完成任务
      await page.waitForTimeout(7_000)
      expect((await toolOutput())?.status).toBe('pending')
      const before = await ledger()
      const fileId = newId()
      await sql`update ai_task set status = 'succeeded', finished_at = now(),
        output = ${JSON.stringify({ files: [{ id: fileId, mime: 'image/png' }] })}::jsonb
        where id = ${taskId} and workspace_id = ${workspaceId}`
      const started = Date.now()
      await expect
        .poll(async () => (await toolOutput())?.status, { timeout: 90_000, intervals: [1_000] })
        .toBe('succeeded')
      summary.writeBackSeconds = Math.round((Date.now() - started) / 1000)
      expect(await toolOutput()).toMatchObject({
        taskId,
        status: 'succeeded',
        files: [
          { id: fileId, mime: 'image/png', downloadUrl: expect.stringContaining(workspaceId) },
        ],
      })
      // 默认不续轮：没有新的轮次、预扣或积分流水
      expect(await turns()).toEqual([{ status: 'completed', credits_charged: 4 }])
      expect(await ledger()).toEqual(before)
      summary.ledgerUnchanged = true
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect(assistant(page).last()).toContainText(SUBMITTED)
      await capture('task-written-back')
    })

    const events = await serverEvents(logOffset, id)
    expect(events.filter((entry) => entry.level === 'error')).toEqual([])
    await saveEvidence('8.2-async-task', screenshots, {
      ...summary,
      errorEvents: 0,
      events: eventSummary(events),
    })
  } finally {
    try {
      await disable?.()
    } finally {
      await sql.end()
    }
  }
})

test('deleting a conversation from the list purges its agent instance', async ({ page }) => {
  test.setTimeout(120_000)
  const sql = fixtureDb()
  const screenshots = new Map<string, Buffer>()
  const capture = async (name: string) => {
    screenshots.set(name, await page.screenshot())
  }
  let disable: (() => Promise<unknown>) | undefined
  let id = ''

  try {
    const { fixture, owner } = await setup(sql, page)
    disable = fixture.disable
    const logOffset = (await stat(serverLog)).size
    id = await startChat(page, owner.slug, fixture.modelId)

    await test.step('A completed turn leaves messages in the instance', async () => {
      await send(page, MULTI_STEP)
      await expect(assistant(page).last()).toContainText('Both workspace tools returned results.')
      await expect.poll(async () => (await lastReply(page, id))?.role).toBe('assistant')
    })

    await test.step('Delete the conversation from the list', async () => {
      await page.goto(`/app/${owner.slug}/agents`)
      const row = page
        .getByRole('list', { name: 'Agent conversations' })
        .getByRole('listitem')
        .filter({ has: page.getByRole('link', { name: MULTI_STEP }) })
      await expect(row).toHaveCount(1)
      // SSR 后、水合前点击触发器不会打开菜单；重试直到菜单出现
      const menu = page.getByRole('menu')
      await expect(async () => {
        if (!(await menu.isVisible()))
          await row.getByRole('button', { name: /^Conversation actions:/ }).click()
        await expect(menu).toBeVisible({ timeout: 1_000 })
      }).toPass({ timeout: 30_000 })
      await capture('row-menu')
      await menu.getByRole('menuitem', { name: 'Delete conversation' }).click()
      const dialog = page.getByRole('alertdialog')
      await expect(dialog).toContainText(MULTI_STEP)
      await capture('confirm')
      await dialog.getByRole('button', { name: 'Delete conversation' }).click()
      await expect(dialog).toHaveCount(0)
      // 列表刷新后行被移除，PG 中对话归档（软删）
      await expect(row).toHaveCount(0)
      const [conversation] = await sql<
        { archived: boolean }[]
      >`select archived from ai_conversation where id = ${id}`
      expect(conversation?.archived).toBe(true)
      await capture('deleted')
    })

    await test.step('The instance is purged and the conversation returns 404', async () => {
      await expect
        .poll(
          async () =>
            (await serverEvents(logOffset, id)).find(
              (entry) => entry.event === 'agents.instance.purged',
            )?.reason,
          { timeout: 30_000 },
        )
        .toBe('gone')
      expect((await page.request.get(messagesPath(id))).status()).toBe(404)
      const chat = await page.goto(`/app/${owner.slug}/agents/${id}`)
      expect(chat?.status()).toBe(404)
      await capture('conversation-404')
    })

    await test.step('Instance storage is empty even if the PG row came back', async () => {
      // 只为核对实例存储：临时取消归档，前置处理放行后实例应已没有任何消息
      await sql`update ai_conversation set archived = false where id = ${id}`
      const response = await page.request.get(messagesPath(id))
      expect(response.status()).toBe(200)
      expect(await response.json()).toEqual([])
      await sql`update ai_conversation set archived = true where id = ${id}`
    })

    const events = await serverEvents(logOffset, id)
    expect(events.filter((entry) => entry.level === 'error')).toEqual([])
    await saveEvidence('7.1-delete', screenshots, {
      archived: true,
      instancePurged: 'gone',
      messages: 404,
      storageAfterPurge: [],
      errorEvents: 0,
      events: eventSummary(events),
    })
  } finally {
    try {
      if (id) await sql`update ai_conversation set archived = true where id = ${id}`
      await disable?.()
    } finally {
      await sql.end()
    }
  }
})
