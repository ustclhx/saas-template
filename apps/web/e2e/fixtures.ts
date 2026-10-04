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
