import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { stubTurnstile } from './turnstile.ts'

test('workspace creation, invitation entry and personal switching obey tenancy flag', async ({
  page,
}) => {
  await stubTurnstile(page)
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await form.getByLabel('Name', { exact: true }).fill('Workspace Owner')
  await form.getByLabel('Email', { exact: true }).fill(`team-${key}@example.com`)
  await form.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await form.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/app\/u-/)
  const personalUrl = page.url()
  if (!templateConfig.tenancy.multiTenant) {
    await expect(page.getByLabel('Switch workspace')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Create team workspace' })).toHaveCount(0)
    await page.getByRole('link', { name: 'Workspace settings' }).click()
    await expect(page.getByRole('form', { name: 'Invite member' })).toHaveCount(0)
    return
  }
  await page.getByRole('button', { name: 'Create team workspace' }).click()
  await page.getByLabel('Team name', { exact: true }).fill('Browser Team')
  await page.getByLabel('Workspace URL', { exact: true }).fill(`browser-${key}`)
  await page.getByRole('button', { name: 'Create team', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/app/browser-${key}$`))
  await page.getByRole('link', { name: 'Workspace settings' }).click()
  await page.getByLabel('Invite email').fill(`invite-${key}@example.com`)
  let invitationId = ''
  await page.route('**/api/auth/organization/invite-member', async (route) => {
    const response = await route.fetch()
    const invitation = (await response.json()) as { id: string }
    invitationId = invitation.id
    await route.fulfill({ response })
  })
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await expect(page.getByText(`invite-${key}@example.com`, { exact: false })).toBeVisible()
  await page.getByLabel('Switch workspace').selectOption({ label: 'Personal (personal)' })
  await expect(page).toHaveURL(personalUrl)
  await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
  await page.goto(`/accept-invitation?id=${invitationId}`)
  await expect(page.getByRole('alert')).toHaveText(
    'Sign in with the email address that received this invitation.',
  )
  await expect(page.getByText('Browser Team')).toHaveCount(0)
  await page.context().clearCookies()
  await page.goto('/register')
  const recipient = page.getByRole('form', { name: 'Create an account' })
  await recipient.getByLabel('Name', { exact: true }).fill('Invited Member')
  await recipient.getByLabel('Email', { exact: true }).fill(`invite-${key}@example.com`)
  await recipient.getByLabel('Password', { exact: true }).fill('correct-horse-battery')
  await recipient.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/app\/u-/)
  await page.goto(`/accept-invitation?id=${invitationId}`)
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await expect(page).toHaveURL(new RegExp(`/app/browser-${key}$`))
  await page.getByRole('link', { name: 'Workspace settings' }).click()
  await expect(page.getByRole('form', { name: 'Invite member' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(0)
})
