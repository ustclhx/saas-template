import { expect, test } from '@playwright/test'
import { chooseOption } from './select.ts'

// 组件预览页（add-ui-design-system D6）：开发环境 wrangler 顶层设 UI_PREVIEW=true，页面可达且不被索引；
// 关闭时的 404 由 smoke.spec.ts（UI_PREVIEW=false）覆盖。
test('component preview renders every section in development', async ({ page }) => {
  const response = await page.goto('/dev/ui')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Component preview' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow')
  for (const name of [
    'Button',
    'Combobox',
    'Tabs',
    'Dropdown',
    'Command Menu',
    'Toast',
    'Sidebar',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  }
  // 运行时切换预设写入 <html data-preset>
  await chooseOption(page.getByRole('combobox', { name: 'Preset', exact: true }), 'violet')
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'violet')
})
