import { randomUUID } from 'node:crypto'
import { expect, type Page, test } from '@playwright/test'
import { createDb } from '@saas/db'
import { loadEnv } from 'vite'
import templateConfig from '../../../template.config.ts'
import { writeNotification } from '../src/features/notifications/service.ts'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 选择器不依赖界面语言（zh 单语言的生成副本里同样成立）：铃铛与角标用 test id，弹层用 role，
// 按钮名称用中英文都匹配的正则，列表行按通知标题过滤
const MARK_ALL = /mark all as read|全部标为已读/i
const CLOSE = /close notifications|关闭通知/i

function notificationFixture() {
  const sql = fixtureDb()
  const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
  const db = createDb({ connectionString: env.DATABASE_URL as string })
  return { sql, db }
}

async function registerWithWorkspace(
  page: Page,
  sql: ReturnType<typeof fixtureDb>,
  prefix: string,
) {
  const email = `${prefix}-${randomUUID()}@example.com`
  await simulateClientIp(page)
  await stubTurnstile(page)
  await register(page, email)
  const slug = new URL(page.url()).pathname.split('/')[2] as string
  const [account] = await sql`select id from "user" where email=${email}`
  const [workspace] = await sql`select id from organization where slug=${slug}`
  if (!account || !workspace) throw new Error('Notification fixture missing')
  return { slug, userId: account.id as string, workspaceId: workspace.id as string }
}

test('桌面铃铛：单条标已读、全部标已读、点击跳转、查看全部到首页通知区、Escape 还焦点', async ({
  page,
}) => {
  // 注册加多次整页加载，dev server 在负载下单页可达十秒
  test.slow()
  await page.setViewportSize({ width: 1440, height: 900 })
  const { sql, db } = notificationFixture()
  try {
    const { slug, userId, workspaceId } = await registerWithWorkspace(page, sql, 'notify')
    const bell = page.getByTestId('notification-bell')
    const badge = page.getByTestId('notification-badge')
    await expect(bell).toBeVisible()
    await expect(bell).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(badge).toHaveCount(0)
    // 侧边栏布局在还没有通知时不渲染首页通知区
    if (templateConfig.ui.appLayout === 'sidebar')
      await expect(page.getByTestId('notification-unread')).toHaveCount(0)

    for (const [title, link] of [
      ['Fixture linked', `/app/${slug}/usage`],
      ['Fixture plain', undefined],
      ['Fixture third', undefined],
    ] as const)
      await writeNotification(db, workspaceId, {
        userId,
        type: 'test.completed',
        title,
        ...(link ? { link } : {}),
      })
    await page.reload()
    await expect(badge).toHaveText('3')
    await expect(bell).toHaveAccessibleName(/3/)

    await bell.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(bell).toHaveAttribute('aria-expanded', 'true')
    const rows = dialog.getByRole('listitem')
    await expect(rows).toHaveCount(3)
    // 行尾的勾只标已读、不跳转
    await rows.filter({ hasText: 'Fixture plain' }).getByRole('button').nth(1).click()
    await expect(badge).toHaveText('2')
    await expect(page).toHaveURL(new RegExp(`/app/${slug}$`))
    await expect(rows.filter({ hasText: 'Fixture plain' }).getByRole('button')).toHaveCount(1)

    // 点一条：标为已读并跳到服务端返回的链接，弹层关闭
    await rows.filter({ hasText: 'Fixture linked' }).getByRole('button').first().click()
    await expect(page).toHaveURL(new RegExp(`/app/${slug}/usage$`))
    await expect(dialog).toBeHidden()
    await expect(badge).toHaveText('1')

    // 全部标为已读后角标消失、按钮禁用
    await bell.click()
    await dialog.getByRole('button', { name: MARK_ALL }).click()
    await expect(badge).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: MARK_ALL })).toBeDisabled()
    await expect(bell).toHaveAccessibleName(/^(?!.*\d)/)

    // 查看全部：回到工作台首页并展开、滚动到通知区
    await dialog.getByRole('link').click()
    await expect(page).toHaveURL(new RegExp(`/app/${slug}#notifications$`))
    await expect(dialog).toBeHidden()
    const center = page.locator('details#notifications')
    await expect(center).toHaveAttribute('open', '')
    await expect(center).toBeInViewport()
    await expect(page.getByTestId('notification-unread')).toHaveText('0')

    // Escape 关闭，焦点回到铃铛
    await bell.click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(bell).toBeFocused()
    await expect(bell).toHaveAttribute('aria-expanded', 'false')
  } finally {
    await db.$client.end()
    await sql.end()
  }
})

test('手机 390 宽：铃铛打开底部面板（模态），关闭按钮与 Escape 关闭', async ({ page }) => {
  test.slow()
  await page.setViewportSize({ width: 390, height: 844 })
  const { sql, db } = notificationFixture()
  try {
    const { userId, workspaceId } = await registerWithWorkspace(page, sql, 'notify-mobile')
    await writeNotification(db, workspaceId, { userId, type: 'test', title: 'Mobile fixture' })
    await page.reload()
    const bell = page.getByTestId('notification-bell')
    await expect(page.getByTestId('notification-badge')).toHaveText('1')
    await bell.click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await expect(sheet).toHaveAttribute('aria-modal', 'true')
    await expect(sheet.getByRole('listitem')).toHaveCount(1)
    // 面板滑入后贴底
    await expect
      .poll(async () => {
        const box = await sheet.boundingBox()
        return box && Math.round(box.y + box.height)
      })
      .toBe(844)
    // 触控目标不小于 44px
    for (const button of await sheet.getByRole('button').all()) {
      const size = await button.boundingBox()
      expect(size?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
    await sheet.getByRole('button', { name: CLOSE }).click()
    await expect(sheet).toBeHidden()
    await expect(bell).toBeFocused()

    await bell.click()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
    await expect(bell).toBeFocused()
  } finally {
    await db.$client.end()
    await sql.end()
  }
})

test('后台保存运营通知密钥后只显示配置状态，不回显明文', async ({ page }) => {
  const sql = fixtureDb()
  const keys = [
    'operations.telegramBotToken',
    'operations.telegramChatId',
    'operations.discordWebhookUrl',
  ]
  const original = await sql`select key,value from setting where key in ${sql(keys)}`
  const email = `ops-settings-${randomUUID()}@example.com`
  const token = '123456:abcdefghijklmnopqrstuvwxyz_fixture'
  const webhook = 'https://discord.com/api/webhooks/123456/fixture-secret'
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    await sql`update "user" set role='admin' where email=${email}`
    await page.goto('/admin/settings')
    const form = page.getByRole('form', { name: 'Operations notifications' })
    await form.getByLabel('Telegram bot token', { exact: true }).fill(token)
    await form.getByLabel('Telegram chat ID', { exact: true }).fill('-456')
    await form.getByLabel('Discord webhook URL', { exact: true }).fill(webhook)
    await form.getByRole('button', { name: 'Save operations notifications' }).click()
    await expect(form.getByRole('status')).toHaveText('Operations settings saved.')
    await expect(form.getByLabel('Telegram bot token', { exact: true })).toHaveValue('')
    await expect(form.getByLabel('Discord webhook URL', { exact: true })).toHaveValue('')
    await page.reload()
    await expect(form.getByText('Telegram bot: Configured')).toBeVisible()
    await expect(form.getByText('Discord webhook: Configured')).toBeVisible()
    await expect(form.getByLabel('Telegram chat ID', { exact: true })).toHaveValue('-456')
    expect(await page.content()).not.toContain(token)
    expect(await page.content()).not.toContain(webhook)
    await form.getByRole('checkbox', { name: 'Clear Telegram token', exact: true }).check()
    await form.getByRole('checkbox', { name: 'Clear Discord webhook', exact: true }).check()
    await form.getByRole('button', { name: 'Save operations notifications' }).click()
    await expect(form.getByRole('status')).toHaveText('Operations settings saved.')
    await expect(
      form.getByRole('checkbox', { name: 'Clear Telegram token', exact: true }),
    ).not.toBeChecked()
    await expect(
      form.getByRole('checkbox', { name: 'Clear Discord webhook', exact: true }),
    ).not.toBeChecked()
    await page.reload()
    await expect(form.getByText('Telegram bot: Not configured')).toBeVisible()
    await expect(form.getByText('Discord webhook: Not configured')).toBeVisible()
  } finally {
    await sql`delete from setting where key in ${sql(keys)}`
    for (const row of original)
      await sql`insert into setting (id,key,value) values (${randomUUID()},${row.key},${JSON.stringify(row.value)}::jsonb)`
    await sql.end()
  }
})
