/// <reference lib="dom" />
import { expect, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// 工作台侧边栏（openspec add-ui-design-system tasks 8.3）：两种 App 布局、折叠持久化、移动抽屉与 390px 无横向滚动。
// 布局取自 template.config.ts 的 ui.appLayout，构建期决定；两种布局分别在对应配置下运行本文件。

const sidebar = templateConfig.ui.appLayout === 'sidebar'

async function newUser(page: Page) {
  await simulateClientIp(page)
  await stubTurnstile(page)
  const key = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  await register(page, `shell-${key}@example.com`, 'Shell Tester')
  // 等待水合完成，侧边栏按钮的点击才会生效
  await page.waitForLoadState('networkidle')
  return page.url()
}

const shell = (page: Page) => page.locator('[data-slot="sidebar"]')
const nav = (page: Page) => page.getByRole('navigation', { name: 'Workspace' })

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
}

test.describe('sidebar 布局', () => {
  test.skip(!sidebar, 'ui.appLayout 不是 sidebar')

  test('分组导航、当前项高亮与折叠状态刷新后保持', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const home = await newUser(page)
    const workspaceNav = nav(page)
    await expect(workspaceNav.getByText('Tools', { exact: true })).toBeVisible()
    await expect(workspaceNav.getByText('Settings', { exact: true })).toBeVisible()
    await expect(workspaceNav.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
    await expect(page.getByTestId('current-user')).toContainText('Shell Tester')
    // 底部升级与账户入口
    await expect(page.getByRole('link', { name: 'View plans' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Account menu: Shell Tester' })).toBeVisible()

    await workspaceNav.getByRole('link', { name: 'Usage' }).click()
    await expect(page).toHaveURL(/\/usage$/)
    await expect(workspaceNav.getByRole('link', { name: 'Usage' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(workspaceNav.getByRole('link', { name: 'Home' })).not.toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(page.getByTestId('app-page-title')).toHaveText('Usage')

    // 内容区：surface-2 圆角面板，与侧边栏之间 8px 外边距
    const inset = page.locator('[data-slot="sidebar-inset"]')
    const [panel, rail] = await Promise.all([inset.boundingBox(), shell(page).boundingBox()])
    expect(panel?.y).toBe(8)
    expect(Math.round(panel?.x ?? 0)).toBe(Math.round((rail?.width ?? 0) + (rail?.x ?? 0)))

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect(shell(page)).toHaveAttribute('data-state', 'collapsed')
    await expect.poll(async () => (await shell(page).boundingBox())?.width).toBe(64)
    // 收起后名称只给读屏，底部升级入口变为图标
    await expect(page.getByRole('link', { name: 'Upgrade your plan' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'View plans' })).toBeHidden()

    // 服务端首屏即按 cookie 输出收起状态（不依赖客户端修正）
    const html = await (await page.request.get(home)).text()
    expect(html).toMatch(/data-slot="sidebar"[^>]*data-state="collapsed"/)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(shell(page)).toHaveAttribute('data-state', 'collapsed')
    await expect.poll(async () => (await shell(page).boundingBox())?.width).toBe(64)

    await page.getByRole('button', { name: 'Expand sidebar' }).first().click()
    await expect(shell(page)).toHaveAttribute('data-state', 'expanded')
    await page.reload()
    await expect(shell(page)).toHaveAttribute('data-state', 'expanded')
    await expect.poll(async () => (await shell(page).boundingBox())?.width).toBe(248)

    // 打印只输出正文：侧边栏与顶部条隐藏，面板去掉外边距
    await page.emulateMedia({ media: 'print' })
    await expect(shell(page)).toBeHidden()
    await expect(page.getByTestId('app-page-title')).toBeHidden()
    expect((await page.locator('[data-slot="sidebar-inset"]').boundingBox())?.x).toBe(0)
    await page.emulateMedia({ media: 'screen' })
  })

  test('390px：抽屉打开、选择条目后关闭并把焦点还给菜单按钮，无横向滚动', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await newUser(page)
    await expect(shell(page)).toBeHidden()
    await noHorizontalScroll(page)

    const menu = page.getByRole('button', { name: 'Open navigation' })
    await menu.click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByTestId('workspace-name')).toHaveText('Personal')
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()

    await menu.click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('link', { name: 'Workspace settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
    await expect(drawer).toBeHidden()
    await expect(menu).toBeFocused()
    await expect(page.getByTestId('app-page-title')).toHaveText('Workspace settings')
    await noHorizontalScroll(page)

    for (const path of ['usage', 'billing', 'chat']) {
      await page.goto(`${page.url().replace(/\/settings$/, '')}/${path}`)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('[data-slot="sidebar-inset"]')).toBeVisible()
      await noHorizontalScroll(page)
      await page.goBack()
    }
  })
})

test.describe('topbar 布局', () => {
  test.skip(sidebar, 'ui.appLayout 不是 topbar')

  test('沿用原有顶部布局，没有侧边栏', async ({ page }) => {
    await newUser(page)
    await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
    await expect(page.getByTestId('current-user')).toContainText('Shell Tester')
    await expect(shell(page)).toHaveCount(0)
    await page.getByRole('link', { name: 'Usage' }).click()
    await expect(page).toHaveURL(/\/usage$/)
    await expect(page.getByTestId('workspace-name')).toHaveText('Personal')
    await page.setViewportSize({ width: 390, height: 844 })
    await noHorizontalScroll(page)
  })
})
