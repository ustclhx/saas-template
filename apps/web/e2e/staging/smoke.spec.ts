import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('首页渲染', async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.locator('section#features')).toBeVisible()
})

test('定价页渲染', async ({ page }) => {
  const response = await page.goto('/pricing')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Pricing', exact: true })).toBeVisible()
})

test('随机邮箱注册后进入个人空间', async ({ page }) => {
  const sha = (process.env.APP_VERSION ?? process.env.GITHUB_SHA ?? 'local').slice(0, 12)
  const email = `smoke+${sha}-${randomUUID()}@example.com`
  // staging 使用真实 Turnstile 脚本和官方测试 key；不依赖本地桩、日志或邮件。
  await page.goto('/register')
  const form = page.getByRole('form', { name: 'Create an account' })
  await form.getByLabel('Name').fill('Staging Smoke User')
  await form.getByLabel('Email').fill(email)
  await form.getByLabel('Password').fill('staging-smoke-password')
  await form.getByRole('button', { name: 'Create account' }).click()
  await expect(page).toHaveURL(/\/app\/u-[a-z0-9]+\/?$/)
  await expect(page.getByTestId('current-user')).toContainText(email)
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible()

  // 每次发布都会注册一个用户；走真实的注销流程删除，避免 staging 库中冒烟账号累积
  await page.goto('/account')
  await page.getByLabel('Type DELETE to confirm').fill('DELETE')
  await page.getByRole('button', { name: 'Delete account' }).click()
  await expect(page).toHaveURL(/\/login(\?|$)/)
})
