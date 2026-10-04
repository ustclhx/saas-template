import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { expect, type Page } from '@playwright/test'
import type { Database } from '@saas/db'
import { loadEnv } from 'vite'

export const PASSWORD = 'correct-horse-battery'
export const APP_URL = /\/app\/u-[a-z0-9]+\/?$/
const env = loadEnv('worktree', new URL('../../../', import.meta.url).pathname, '')
const require = createRequire(new URL('../../../packages/db/package.json', import.meta.url))
// Never fall back to a shared checkout database.
export function fixtureDb() {
  if (!env.DATABASE_URL) throw new Error('E2E requires .env.worktree DATABASE_URL')
  const postgres = require('postgres') as (
    url: string,
    options: { max: number },
  ) => Database['$client']
  return postgres(env.DATABASE_URL, { max: 1 })
}
export async function register(page: Page, email: string, name = 'Workspace Owner') {
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  await form.getByLabel('Name', { exact: true }).fill(name)
  await form.getByLabel('Email', { exact: true }).fill(email)
  await form.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await form.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(APP_URL)
}
export async function login(page: Page, email: string, path = '/login') {
  await page.goto(path)
  const form = page.getByRole('form', { name: 'Sign in with password' })
  await form.getByLabel('Email', { exact: true }).fill(email)
  await form.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await form.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
}
/** Local workerd honors this header; separate simulated clients retain real 10/min limits. */
export async function simulateClientIp(page: Page) {
  await page.context().setExtraHTTPHeaders({
    'cf-connecting-ip': `192.0.2.${1 + Math.floor(Math.random() * 254)}`,
  })
}

export async function verifyInvitation(
  page: Page,
  email: string,
  id: string,
  workspaceName: string,
) {
  await expect(page.getByText(workspaceName, { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toHaveCount(0)
  const request = page.waitForRequest('**/api/auth/send-verification-email')
  await page.getByRole('button', { name: 'Send verification email' }).click()
  expect((await request).postDataJSON()).toEqual({
    email,
    callbackURL: `/accept-invitation?id=${id}`,
  })
  await expect(
    page.getByText('Verification email sent. Check your inbox and open the link.'),
  ).toBeVisible()
  await page.goto(await emailLink(email))
  await expect(page).toHaveURL(new RegExp(`/accept-invitation\\?id=${id}$`))
  await expect(
    page.getByText(`You are invited to ${workspaceName}`, { exact: false }),
  ).toBeVisible()
}

export async function loginOtp(page: Page, email: string, path = '/login') {
  await page.goto(path)
  await page.getByRole('button', { name: 'Sign in with email code' }).click()
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByRole('button', { name: 'Send code' }).click()
  await expect(page.getByLabel('Verification code')).toBeVisible()
  await page.getByLabel('Verification code').fill(await emailCode(email))
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login(?:\?|$)/)
}
/** Consume only the existing local-development email logger, never forge a token. */
export async function emailLink(email: string, type = 'verify-email') {
  let link = ''
  await expect
    .poll(() => {
      const log = readFileSync(process.env.E2E_AUTH_LOG ?? '/tmp/p1-phase-e2e-auth.log', 'utf8')
      const messages = log.match(/\[dev\] auth email \{[\s\S]*?\n\}/g) ?? []
      const message = messages.findLast((entry) => entry.includes(email) && entry.includes(type))
      link = message?.match(/url: ['"]([^'"]+)['"]/)?.[1] ?? ''
      return link
    })
    .not.toBe('')
  return link
}

export async function emailCode(email: string) {
  let code = ''
  await expect
    .poll(() => {
      const log = readFileSync(process.env.E2E_AUTH_LOG ?? '/tmp/p1-phase-e2e-auth.log', 'utf8')
      const messages = log.match(/\[dev\] auth email \{[\s\S]*?\n\}/g) ?? []
      const message = messages.findLast((entry) => entry.includes(email) && entry.includes('otp'))
      code = message?.match(/otp: ['"](\d{6})['"]/)?.[1] ?? ''
      return code
    })
    .not.toBe('')
  return code
}
