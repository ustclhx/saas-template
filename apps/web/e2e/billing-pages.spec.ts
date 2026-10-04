import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { fixtureDb, register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

test('public pricing describes unavailable payments without a checkout success', async ({
  page,
}) => {
  await page.goto('/pricing')
  await expect(page.getByRole('heading', { name: 'Pricing', exact: true })).toBeVisible()
  await expect(
    page.getByText('Plans shown here are template examples.', { exact: false }),
  ).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Payments are currently unavailable')
  await expect(page.getByRole('button', { name: /checkout|pay now/i })).toHaveCount(0)
})

test('billing and usage require a fresh authenticated workspace session', async ({ page }) => {
  await page.goto('/app/no-session/billing')
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/app/no-session/usage')
  await expect(page).toHaveURL(/\/login/)
})

test('ordinary members see their own ledger without workspace credits or billing history', async ({
  page,
}) => {
  const sql = fixtureDb()
  const email = `billing-member-${randomUUID()}@example.com`
  const workspaceId = randomUUID()
  const slug = `billing-${workspaceId}`
  try {
    await simulateClientIp(page)
    await stubTurnstile(page)
    await register(page, email)
    const [account] = await sql`select id from "user" where email=${email}`
    if (!account) throw new Error('Missing registered fixture')
    await sql`insert into organization (id,name,slug) values (${workspaceId},'Billing privacy fixture',${slug})`
    await sql`insert into member (id,organization_id,user_id,role) values (${randomUUID()},${workspaceId},${account.id},'member')`
    await sql`insert into credit_ledger (id,workspace_id,user_id,type,delta,ref_type,ref_id) values (${randomUUID()},${workspaceId},${account.id},'consume',-2,'ai_message','own-usage-reference')`
    await sql`insert into credit_ledger (id,workspace_id,type,delta,ref_type,ref_id) values (${randomUUID()},${workspaceId},'adjust',100,'admin','workspace-private-reference')`
    await page.goto(`/app/${slug}/usage`)
    await expect(page.getByText('Your own credit activity is shown below.')).toBeVisible()
    await expect(page.getByText('ai_message · own-usage-reference')).toBeVisible()
    expect(await page.content()).not.toContain('workspace-private-reference')
    await expect(page.getByRole('heading', { name: 'Credit batches' })).toHaveCount(0)
    await page.goto(`/app/${slug}/billing`)
    await expect(page.getByRole('heading', { name: 'Billing', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Payment history' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Continue to checkout' })).toHaveCount(0)
  } finally {
    await sql.end()
  }
})
