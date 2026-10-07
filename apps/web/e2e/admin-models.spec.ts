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
      await sql`select action, meta from audit_log where target_type='ai_model' and target_id=${String(saved?.id)} order by id`
    expect(audits.map((row) => row.action)).toEqual([
      'ai.model_created',
      'ai.model_updated',
      'ai.model_disabled',
      'ai.model_enabled',
    ])
    expect(audits.find((row) => row.action === 'ai.model_updated')?.meta).toMatchObject({
      oldPricing: {
        mode: 'per_call',
        credits: 2,
        limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
      },
      newPricing: {
        mode: 'per_call',
        credits: 3,
        limits: { maxInputTokens: 8000, maxOutputTokens: 2000 },
      },
    })

    // 复制已保存值，新副本停用，并保留参数 schema。
    await sql`update ai_model set params_schema=${JSON.stringify({ quality: ['standard', 'hd'] })}::jsonb where key=${key}`
    await card.getByLabel('Copy key').fill(`${key}-copy`)
    await card.getByRole('button', { name: 'Copy model', exact: true }).click()
    const copy = page.getByRole('article', { name: `Model ${key}-copy` })
    await expect(copy).toBeVisible()
    await expect(copy.getByRole('heading')).toContainText('(disabled)')
    const [cloned] =
      await sql`select id, pricing, params_schema, provider_model_id from ai_model where key=${`${key}-copy`}`
    expect(cloned).toMatchObject({
      pricing: saved?.pricing,
      params_schema: { quality: ['standard', 'hd'] },
      provider_model_id: 'gpt-fixture',
    })
    const [copyAudit] =
      await sql`select meta from audit_log where action='ai.model_copied' and target_id=${String(cloned?.id)}`
    expect(copyAudit?.meta).toMatchObject({ sourceId: saved?.id, sourceKey: key })

    await page.getByLabel('Model type').selectOption('image')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(card).toHaveCount(0)
    await expect(copy).toHaveCount(0)
    await expect(page).toHaveURL(/kind=image/)
    await page.getByLabel('Model type').selectOption('text')
    await page.getByLabel('Order models').selectOption('key_desc')
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(copy).toBeVisible()
    const keys = await page
      .getByRole('table', { name: 'AI models' })
      .getByRole('link')
      .allTextContents()
    expect(keys).toEqual([...keys].sort().reverse())
  } finally {
    await sql`delete from ai_model where key in ${sql([key, `${key}-copy`])}`
    await sql.end()
  }
})
