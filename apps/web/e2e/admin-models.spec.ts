import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('model administration is hidden from non-admins', async ({ page }) => {
  await page.goto('/admin/models')
  await expect(page.getByRole('heading', { name: 'AI models' })).toHaveCount(0)
})

test('platform admin can create, edit, disable and enable a model', async ({ page }) => {
  const sql = fixtureDb()
  const email = `admin-models-${randomUUID()}@example.com`
  const key = `e2e-${randomUUID().slice(0, 8)}`
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing account fixture')
    await sql`update "user" set role='admin' where id=${account.id}`

    await page.goto('/admin/models')
    await expect(page.getByRole('heading', { name: 'AI models' })).toBeVisible()
    const form = page.getByRole('article', { name: 'New model' })
    // template.config.ts 中文本模型默认按 token 计费
    await expect(form.getByLabel('Pricing mode')).toHaveValue('token')

    // 页面水合前的操作不会进入 React 状态：重复切换直到按次字段出现
    await expect
      .poll(async () => {
        await form.getByLabel('Pricing mode').selectOption('per_call')
        return form.getByLabel('Credits per call').isVisible()
      })
      .toBe(true)
    await form.getByLabel('Key').fill(key)
    await form.getByLabel('Provider', { exact: true }).fill('openai')
    await form.getByLabel('Provider model ID').fill('gpt-fixture')
    await form.getByLabel('Credits per call').fill('2')
    await form.getByRole('button', { name: 'Create model' }).click()
    await expect(form.getByRole('status')).toContainText('token limits')
    expect(await sql`select id from ai_model where key=${key}`).toHaveLength(0)

    await form.getByLabel('Max input tokens').fill('8000')
    await form.getByLabel('Max output tokens').fill('2000')
    await form.getByRole('button', { name: 'Create model' }).click()
    const card = page.getByRole('article', { name: `Model ${key}` })
    await expect(card).toBeVisible()

    await card.getByLabel('Credits per call').fill('3')
    await card.getByRole('button', { name: 'Save changes' }).click()
    await expect(card.getByRole('status')).toContainText('Saved.')
    const [saved] = await sql`select id, pricing, enabled from ai_model where key=${key}`
    expect(saved).toMatchObject({
      enabled: true,
      pricing: { mode: 'per_call', credits: 3, limits: { maxInputTokens: 8000 } },
    })

    await card.getByRole('button', { name: 'Disable' }).click()
    await expect(card.getByRole('heading')).toContainText('(disabled)')
    await card.getByRole('button', { name: 'Enable' }).click()
    await expect(card.getByRole('button', { name: 'Disable' })).toBeVisible()

    const audits =
      await sql`select action from audit_log where target_type='ai_model' and target_id=${String(saved?.id)} order by id`
    expect(audits.map((row) => row.action)).toEqual([
      'ai.model_created',
      'ai.model_updated',
      'ai.model_disabled',
      'ai.model_enabled',
    ])
  } finally {
    await sql`delete from ai_model where key=${key}`
    await sql.end()
  }
})
